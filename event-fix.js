// Reliable MTProto forwarding layer.
// This is intentionally independent from the core handler so message events are
// still processed when GramJS exposes channel peer IDs through peerId.channelId.

try {
  const fs = require("fs");
  const path = require("path");
  const Database = require("better-sqlite3");
  const { TelegramClient } = require("telegram");
  const events = require("telegram/events");

  const persistentDir = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
  const dbPath = process.env.DB_PATH || path.join(persistentDir, "cloner.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER UNIQUE NOT NULL,title TEXT NOT NULL,username TEXT);
    CREATE TABLE IF NOT EXISTS destinations(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER UNIQUE NOT NULL,title TEXT NOT NULL,username TEXT);
    CREATE TABLE IF NOT EXISTS links(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id INTEGER NOT NULL,destination_id INTEGER NOT NULL,UNIQUE(source_id,destination_id));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS copied(source_chat_id INTEGER NOT NULL,source_message_id INTEGER NOT NULL,destination_chat_id INTEGER NOT NULL,destination_message_id INTEGER,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(source_chat_id,source_message_id,destination_chat_id));
  `);

  const getSetting = db.prepare("SELECT value FROM settings WHERE key=?");
  const sourceExists = db.prepare("SELECT 1 FROM sources WHERE chat_id=?");
  const destinationsFor = db.prepare(`
    SELECT d.chat_id
    FROM links l
    JOIN sources s ON s.id=l.source_id
    JOIN destinations d ON d.id=l.destination_id
    WHERE s.chat_id=?
    ORDER BY d.id
  `);
  const alreadyCopied = db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?");
  const markCopied = db.prepare(`
    INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id)
    VALUES(?,?,?,?)
  `);

  const locks = new Map();
  const installed = new WeakSet();

  function setting(key, fallback = "") {
    const row = getSetting.get(key);
    return row ? row.value : fallback;
  }

  function idOf(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value) || 0;
    if (value.value !== undefined) return Number(value.value) || 0;
    return Number(value) || 0;
  }

  // For channel messages GramJS can expose the channel ID as peerId.channelId,
  // while older code may read chatId. The DB stores the raw Telegram entity ID.
  function messageChatId(message) {
    const peer = message?.peerId || message?.peerID;
    if (peer?.channelId !== undefined) return idOf(peer.channelId);
    if (peer?.chatId !== undefined) return idOf(peer.chatId);
    if (peer?.userId !== undefined) return idOf(peer.userId);
    if (message?.chatId !== undefined) return idOf(message.chatId);
    return 0;
  }

  function transformText(text) {
    text = text || "";
    const lower = text.toLowerCase();
    const csv = value => String(value || "").split(",").map(x => x.trim()).filter(Boolean);

    if (csv(setting("ban_words")).some(word => lower.includes(word.toLowerCase()))) return null;

    const keywords = csv(setting("keywords"));
    if (keywords.length && !keywords.some(word => lower.includes(word.toLowerCase()))) return null;

    if (setting("remove_links", "0") === "1") {
      text = text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi, "");
    }

    for (const line of setting("replacements", "").split(/\r?\n/)) {
      if (!line.includes("->")) continue;
      const p = line.indexOf("->");
      const oldText = line.slice(0, p).trim();
      const newText = line.slice(p + 2).trim();
      if (oldText) text = text.split(oldText).join(newText);
    }

    const signature = setting("signature", "");
    if (signature) text = text.trim() ? `${text.trim()}\n\n${signature}` : signature;
    return text.trim();
  }

  async function withLock(destinationId, task) {
    const previous = locks.get(destinationId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(destinationId, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (locks.get(destinationId) === current) locks.delete(destinationId);
    }
  }

  async function copyMessage(client, message, destination) {
    const text = transformText(message.message || "");
    if (text === null) return null;

    if (message.media) {
      return client.sendFile(destination, {
        file: message.media,
        caption: text || undefined,
        forceDocument: false
      });
    }

    if (!text) return null;
    return client.sendMessage(destination, { message: text, linkPreview: false });
  }

  async function process(client, messages) {
    if (!client || !messages?.length) return;

    const first = messages[0];
    const sourceChatId = messageChatId(first);
    const sourceMessageId = idOf(first.id);

    if (!sourceChatId || !sourceMessageId) {
      console.log(`EVENT-FIX skip: cannot determine peer/message ID (peer=${JSON.stringify(first.peerId || null)}, chat=${String(first.chatId || "")}, msg=${String(first.id || "")})`);
      return;
    }

    if (!sourceExists.get(sourceChatId)) {
      console.log(`EVENT-FIX ignored chat ${sourceChatId}: not configured as source`);
      return;
    }

    const rows = destinationsFor.all(sourceChatId);
    console.log(`EVENT-FIX message ${sourceChatId}:${sourceMessageId}; destinations=${rows.length}`);
    if (!rows.length) return;

    for (const row of rows) {
      const destinationChatId = idOf(row.chat_id);
      if (!destinationChatId) continue;

      const messageIds = messages.map(m => idOf(m.id)).filter(Boolean);
      if (messageIds.length && messageIds.every(mid => alreadyCopied.get(sourceChatId, mid, destinationChatId))) continue;

      await withLock(destinationChatId, async () => {
        const delay = Math.max(0, Math.min(3600, Number(setting("delay", "0")) || 0));
        if (delay) await new Promise(resolve => setTimeout(resolve, delay * 1000));

        try {
          const destination = await client.getEntity(destinationChatId);
          let sent;

          if (messages.length === 1) {
            sent = await copyMessage(client, messages[0], destination);
          } else {
            // Keep album handling simple and reliable: send each media item in order.
            const sentItems = [];
            for (const message of messages) {
              const item = await copyMessage(client, message, destination);
              if (item) sentItems.push(item);
            }
            sent = sentItems;
          }

          if (!sent) {
            console.log(`EVENT-FIX filtered/empty ${sourceChatId}:${sourceMessageId}`);
            return;
          }

          const sentArray = Array.isArray(sent) ? sent : [sent];
          messages.forEach((message, index) => {
            const sentMessage = sentArray[index];
            if (sentMessage) markCopied.run(sourceChatId, idOf(message.id), destinationChatId, idOf(sentMessage.id));
          });

          console.log(`EVENT-FIX COPIED ${sourceChatId}:${messages.map(m => idOf(m.id)).join(",")} -> ${destinationChatId}`);
        } catch (error) {
          console.error(`EVENT-FIX COPY ERROR ${sourceChatId} -> ${destinationChatId}:`, error?.stack || error?.message || error);
        }
      });
    }
  }

  async function install(client) {
    if (!client || installed.has(client)) return;
    installed.add(client);

    client.addEventHandler(async event => {
      try {
        if (event?.message && !event.message.groupedId) await process(client, [event.message]);
      } catch (error) {
        console.error("EVENT-FIX NewMessage ERROR:", error?.stack || error?.message || error);
      }
    }, new events.NewMessage({}));

    client.addEventHandler(async event => {
      try {
        const messages = (event?.messages || []).slice().sort((a, b) => idOf(a.id) - idOf(b.id));
        if (messages.length) await process(client, messages);
      } catch (error) {
        console.error("EVENT-FIX Album ERROR:", error?.stack || error?.message || error);
      }
    }, new events.Album({}));

    console.log("Reliable MTProto forwarding handler installed.");
  }

  const originalConnect = TelegramClient.prototype.connect;
  TelegramClient.prototype.connect = async function(...args) {
    const result = await originalConnect.apply(this, args);
    try { await install(this); } catch (error) { console.error("EVENT-FIX install error:", error?.stack || error?.message || error); }
    return result;
  };

  // start() may establish the connection internally; add a defensive hook too.
  const originalStart = TelegramClient.prototype.start;
  TelegramClient.prototype.start = async function(...args) {
    const result = await originalStart.apply(this, args);
    try { await install(this); } catch (error) { console.error("EVENT-FIX start install error:", error?.stack || error?.message || error); }
    return result;
  };

  console.log("Telegram peer-ID forwarding fix loaded.");
} catch (error) {
  console.error("Telegram peer-ID forwarding fix failed to load:", error?.stack || error?.message || error);
}
