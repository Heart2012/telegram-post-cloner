// Stable MTProto polling forwarder.
// Uses direct message-ID lookup instead of GramJS history iterators.
// This avoids the "Request not set yet" failure seen with getMessages({minId,maxId}).
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

const settingStmt = db.prepare("SELECT value FROM settings WHERE key=?");
const sourceRows = db.prepare("SELECT chat_id,title,username FROM sources ORDER BY id");
const destinationsFor = db.prepare(`
  SELECT d.chat_id
  FROM links l
  JOIN sources s ON s.id=l.source_id
  JOIN destinations d ON d.id=l.destination_id
  WHERE s.chat_id=?
  ORDER BY d.id
`);
const copiedStmt = db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?");
const markStmt = db.prepare(`
  INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id)
  VALUES(?,?,?,?)
`);

const locks = new Map();
const lastSeen = new Map();
const running = new WeakSet();

function setting(key, fallback = "") {
  const row = settingStmt.get(key);
  return row ? row.value : fallback;
}

function idOf(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (value?.value !== undefined) return Number(value.value) || 0;
  return Number(value) || 0;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function transformText(text) {
  text = text || "";
  const lower = text.toLowerCase();

  if (csv(setting("ban_words")).some(word => lower.includes(word.toLowerCase()))) {
    return null;
  }

  const keywords = csv(setting("keywords"));
  if (keywords.length && !keywords.some(word => lower.includes(word.toLowerCase()))) {
    return null;
  }

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
  if (signature) {
    text = text.trim() ? `${text.trim()}\n\n${signature}` : signature;
  }

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
  return client.sendMessage(destination, {
    message: text,
    linkPreview: false
  });
}

async function processOne(client, sourceId, message) {
  const messageId = idOf(message.id);
  const rows = destinationsFor.all(sourceId);

  console.log(`FORWARDER: source=${sourceId} message=${messageId} destinations=${rows.length}`);

  for (const row of rows) {
    const destinationId = idOf(row.chat_id);
    if (!destinationId) continue;
    if (copiedStmt.get(sourceId, messageId, destinationId)) continue;

    await withLock(destinationId, async () => {
      try {
        const destination = await client.getEntity(destinationId);
        const sent = await copyMessage(client, message, destination);

        if (!sent) {
          console.log(`FORWARDER: filtered/empty ${sourceId}:${messageId}`);
          return;
        }

        markStmt.run(sourceId, messageId, destinationId, idOf(sent.id));
        console.log(`FORWARDER COPIED ${sourceId}:${messageId} -> ${destinationId}`);
      } catch (error) {
        console.error(
          `FORWARDER COPY ERROR ${sourceId} -> ${destinationId}:`,
          error?.stack || error?.message || error
        );
      }
    });
  }
}

async function fetchMessageBatch(client, entity, firstId, lastId) {
  const ids = [];
  for (let id = firstId; id <= lastId; id++) ids.push(id);

  // GramJS direct ID lookup uses messages.getMessages/channels.getMessages
  // and does not create the history iterator that caused the startup error.
  const result = await client.getMessages(entity, { ids });
  return Array.from(result || [])
    .filter(message => message && idOf(message.id) >= firstId && idOf(message.id) <= lastId)
    .sort((a, b) => idOf(a.id) - idOf(b.id));
}

async function pollSource(client, row) {
  const sourceId = idOf(row.chat_id);
  const ref = row.username ? `@${row.username}` : sourceId;

  try {
    const entity = await client.getEntity(ref);
    const newest = await client.getMessages(entity, { limit: 1 });
    if (!newest?.length) return;

    const newestId = idOf(newest[0].id);
    const previousId = lastSeen.get(sourceId);

    if (previousId === undefined) {
      lastSeen.set(sourceId, newestId);
      console.log(`FORWARDER: watching ${sourceId} (${row.title}), last=${newestId}`);
      return;
    }

    if (newestId <= previousId) return;

    // Process at most 100 message IDs per polling pass.
    // If more than 100 messages arrived, lastSeen advances only to the
    // processed boundary so nothing is silently skipped.
    const batchEnd = Math.min(newestId, previousId + 100);
    const fresh = await fetchMessageBatch(client, entity, previousId + 1, batchEnd);

    lastSeen.set(sourceId, batchEnd);

    console.log(`FORWARDER: found ${fresh.length} new message(s) in ${sourceId}`);

    for (const message of fresh) {
      await processOne(client, sourceId, message);
    }
  } catch (error) {
    console.error(
      `FORWARDER POLL ERROR ${sourceId}:`,
      error?.stack || error?.message || error
    );
  }
}

async function start(client) {
  if (!client || running.has(client)) return;
  running.add(client);

  console.log("FORWARDER: Telegram client ready; polling every 2 seconds.");

  const loop = async () => {
    try {
      const rows = sourceRows.all();
      for (const row of rows) {
        await pollSource(client, row);
      }
    } catch (error) {
      console.error(
        "FORWARDER LOOP ERROR:",
        error?.stack || error?.message || error
      );
    }

    setTimeout(loop, 2000);
  };

  await loop();
}

if (!TelegramClient.prototype.__postClonerConnectHook) {
  const originalConnect = TelegramClient.prototype.connect;

  TelegramClient.prototype.connect = async function(...args) {
    const result = await originalConnect.apply(this, args);
    console.log("FORWARDER: Telegram connect() completed; starting poller.");
    setImmediate(() => {
      start(this).catch(error => {
        console.error(
          "FORWARDER START ERROR:",
          error?.stack || error?.message || error
        );
      });
    });
    return result;
  };

  TelegramClient.prototype.__postClonerConnectHook = true;
}

console.log("Stable MTProto forwarder hook loaded.");
