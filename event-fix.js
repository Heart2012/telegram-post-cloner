// Reliable MTProto forwarding layer.
// Primary transport is polling via GramJS getMessages.
// This does not depend on Telegram update events, which can be unreliable on some hosting setups.

try {
  const fs = require("fs");
  const path = require("path");
  const Database = require("better-sqlite3");
  const { TelegramClient } = require("telegram");

  const nodeProcess = globalThis.process;
  const persistentDir = path.join(nodeProcess?.env?.HOME || nodeProcess?.cwd?.() || ".", ".telegram-post-cloner");
  const dbPath = nodeProcess?.env?.DB_PATH || path.join(persistentDir, "cloner.db");
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
  const sourceRows = db.prepare("SELECT chat_id,title,username FROM sources ORDER BY id");
  const sourceExists = db.prepare("SELECT 1 FROM sources WHERE chat_id=?");
  const destinationsFor = db.prepare(`SELECT d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);
  const alreadyCopied = db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?");
  const markCopied = db.prepare(`INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id) VALUES(?,?,?,?)`);

  const locks = new Map();
  const lastSeen = new Map();
  const pollingClients = new WeakSet();

  function setting(key, fallback = "") { const row = getSetting.get(key); return row ? row.value : fallback; }
  function idOf(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value) || 0;
    if (value.value !== undefined) return Number(value.value) || 0;
    return Number(value) || 0;
  }
  function channelPeerId(value) { const id = idOf(value); return id ? -1000000000000 - id : 0; }
  function messageChatId(message) {
    const peer = message?.peerId || message?.peerID;
    if (peer?.channelId !== undefined) return channelPeerId(peer.channelId);
    if (peer?.chatId !== undefined) return idOf(peer.chatId);
    if (peer?.userId !== undefined) return idOf(peer.userId);
    if (message?.chatId !== undefined) return idOf(message.chatId);
    if (message?.chatID !== undefined) return idOf(message.chatID);
    return 0;
  }
  function transformText(text) {
    text = text || "";
    const lower = text.toLowerCase();
    const csv = value => String(value || "").split(",").map(x => x.trim()).filter(Boolean);
    if (csv(setting("ban_words")).some(word => lower.includes(word.toLowerCase()))) return null;
    const keywords = csv(setting("keywords"));
    if (keywords.length && !keywords.some(word => lower.includes(word.toLowerCase()))) return null;
    if (setting("remove_links", "0") === "1") text = text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi, "");
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
    try { return await task(); } finally { release(); if (locks.get(destinationId) === current) locks.delete(destinationId); }
  }
  async function copyOne(client, message, destination) {
    const text = transformText(message.message || "");
    if (text === null) return null;
    if (message.media) return client.sendFile(destination, { file: message.media, caption: text || undefined, forceDocument: false });
    if (!text) return null;
    return client.sendMessage(destination, { message: text, linkPreview: false });
  }
  async function processMessages(client, messages) {
    if (!client || !messages?.length) return;
    const sourceChatId = messageChatId(messages[0]);
    const ids = messages.map(m => idOf(m.id)).filter(Boolean);
    if (!sourceChatId) { console.log(`FORWARDER skip: unknown source peer for ${ids.join(",")}`); return; }
    console.log(`FORWARDER received ${sourceChatId}:${ids.join(",")}`);
    if (!sourceExists.get(sourceChatId)) { console.log(`FORWARDER ignored ${sourceChatId}: not configured as source`); return; }
    const rows = destinationsFor.all(sourceChatId);
    console.log(`FORWARDER destinations for ${sourceChatId}: ${rows.length}`);
    for (const row of rows) {
      const destinationChatId = idOf(row.chat_id);
      if (!destinationChatId || ids.every(mid => alreadyCopied.get(sourceChatId, mid, destinationChatId))) continue;
      await withLock(destinationChatId, async () => {
        const delay = Math.max(0, Math.min(3600, Number(setting("delay", "0")) || 0));
        if (delay) await new Promise(resolve => setTimeout(resolve, delay * 1000));
        try {
          const destination = await client.getEntity(destinationChatId);
          const sent = [];
          for (const message of messages) { const result = await copyOne(client, message, destination); if (result) sent.push(result); }
          if (!sent.length) { console.log(`FORWARDER filtered/empty ${sourceChatId}:${ids.join(",")}`); return; }
          messages.forEach((message, index) => { if (sent[index]) markCopied.run(sourceChatId, idOf(message.id), destinationChatId, idOf(sent[index].id)); });
          console.log(`FORWARDER COPIED ${sourceChatId}:${ids.join(",")} -> ${destinationChatId}`);
        } catch (error) { console.error(`FORWARDER COPY ERROR ${sourceChatId} -> ${destinationChatId}:`, error?.stack || error?.message || error); }
      });
    }
  }
  async function pollSource(client, row) {
    const sourceChatId = idOf(row.chat_id);
    const entityRef = row.username ? `@${row.username}` : sourceChatId;
    try {
      const entity = await client.getEntity(entityRef);
      const newest = await client.getMessages(entity, { limit: 1 });
      if (!newest?.length) return;
      const newestId = idOf(newest[0].id);
      const previousId = lastSeen.get(sourceChatId);
      if (previousId === undefined) {
        lastSeen.set(sourceChatId, newestId);
        console.log(`FORWARDER watching source ${sourceChatId} (${row.title}); starting at message ${newestId}`);
        return;
      }
      if (newestId <= previousId) return;
      const messages = await client.getMessages(entity, { minId: previousId, maxId: newestId, limit: Math.min(100, Math.max(1, newestId - previousId)) });
      const fresh = (messages || []).filter(m => idOf(m.id) > previousId && idOf(m.id) <= newestId).sort((a,b) => idOf(a.id) - idOf(b.id));
      lastSeen.set(sourceChatId, newestId);
      if (!fresh.length) return;
      console.log(`FORWARDER found ${fresh.length} new message(s) in ${sourceChatId}`);
      for (const message of fresh) await processMessages(client, [message]);
    } catch (error) { console.error(`FORWARDER POLL ERROR ${sourceChatId}:`, error?.stack || error?.message || error); }
  }
  async function startPolling(client) {
    if (!client || pollingClients.has(client)) return;
    pollingClients.add(client);
    console.log("FORWARDER polling started (2s interval).");
    const loop = async () => {
      try { for (const row of sourceRows.all()) await pollSource(client, row); }
      catch (error) { console.error("FORWARDER polling loop error:", error?.stack || error?.message || error); }
      setTimeout(loop, 2000);
    };
    await loop();
  }
  const installedClients = new WeakSet();
  async function install(client) {
    if (!client || installedClients.has(client)) return;
    installedClients.add(client);
    console.log("Reliable MTProto forwarding handler installed.");
    try { await client.getMe(); console.log("FORWARDER Telegram client ready."); }
    catch (error) { console.error("FORWARDER client readiness error:", error?.stack || error?.message || error); }
    void startPolling(client);
  }
  const originalConnect = TelegramClient.prototype.connect;
  const originalStart = TelegramClient.prototype.start;
  TelegramClient.prototype.connect = async function(...args) { const result = await originalConnect.apply(this, args); try { await install(this); } catch (error) { console.error("FORWARDER install error:", error?.stack || error?.message || error); } return result; };
  TelegramClient.prototype.start = async function(...args) { const result = await originalStart.apply(this, args); try { await install(this); } catch (error) { console.error("FORWARDER start install error:", error?.stack || error?.message || error); } return result; };
  console.log("Telegram peer-ID forwarding fix loaded.");
} catch (error) { console.error("Telegram peer-ID forwarding fix failed to load:", error?.stack || error?.message || error); }
