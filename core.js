const path = require("path");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const { NewMessage } = require("telegram/events");
const { StringSession } = require("telegram/sessions");

const DIR = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
fs.mkdirSync(DIR, { recursive: true });

if (!process.env.DB_PATH) process.env.DB_PATH = path.join(DIR, "cloner.db");

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => Number(x.trim()))
    .filter(Boolean)
);
const PORT = Number(process.env.PORT || 3000);
const MT_SESSION = process.env.MT_SESSION || "";
const SESSION_PATH = process.env.MT_SESSION_FILE || path.join(DIR, "telegram.session");

if (!API_ID || !API_HASH || !BOT_TOKEN || !ADMIN_IDS.size) {
  throw new Error("Заполни API_ID, API_HASH, BOT_TOKEN и ADMIN_IDS.");
}

const db = new Database(process.env.DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sources(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER UNIQUE NOT NULL,
    title TEXT NOT NULL,
    username TEXT
  );
  CREATE TABLE IF NOT EXISTS destinations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER UNIQUE NOT NULL,
    title TEXT NOT NULL,
    username TEXT
  );
  CREATE TABLE IF NOT EXISTS links(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    destination_id INTEGER NOT NULL,
    UNIQUE(source_id,destination_id)
  );
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS link_settings(
    link_id INTEGER PRIMARY KEY,
    enabled TEXT DEFAULT '1',
    remove_links TEXT DEFAULT '0',
    delay TEXT DEFAULT '0',
    keywords TEXT DEFAULT '',
    ban_words TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    replacements TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS copied(
    source_chat_id INTEGER NOT NULL,
    source_message_id INTEGER NOT NULL,
    destination_chat_id INTEGER NOT NULL,
    destination_message_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(source_chat_id,source_message_id,destination_chat_id)
  );
  CREATE TABLE IF NOT EXISTS link_stats(
    link_id INTEGER NOT NULL,
    source_message_id INTEGER NOT NULL,
    destination_message_id INTEGER,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(link_id,source_message_id)
  );
`);

const LINK_DEFAULTS = {
  enabled: "1",
  remove_links: "0",
  delay: "0",
  keywords: "",
  ban_words: "",
  signature: "",
  replacements: "",
};

const bot = new Telegraf(BOT_TOKEN);
const inputState = new Map();
const auth = { phone: null, code: null, password: null };
let client = null;
let loginInProgress = false;
let telegramStarting = false;
let telegramError = "";

function language(ctx) {
  return require("./language.js").lang(ctx.from?.id) === "uk" ? "uk" : "ru";
}

function T(ctx, ru, uk = ru) {
  return language(ctx) === "uk" ? uk : ru;
}

function isAdmin(id) {
  return ADMIN_IDS.has(Number(id));
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? String(row.value) : fallback;
}

function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

function ensureLinkSettings(linkId) {
  db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(linkId);
}

function getLinkSetting(linkId, key, fallback = "") {
  if (!Object.prototype.hasOwnProperty.call(LINK_DEFAULTS, key)) return fallback;
  ensureLinkSettings(linkId);
  const row = db.prepare(`SELECT ${key} value FROM link_settings WHERE link_id=?`).get(linkId);
  return row && row.value !== null && String(row.value) !== "" ? String(row.value) : fallback;
}

function setLinkSetting(linkId, key, value) {
  if (!Object.prototype.hasOwnProperty.call(LINK_DEFAULTS, key)) return;
  ensureLinkSettings(linkId);
  db.prepare(`UPDATE link_settings SET ${key}=? WHERE link_id=?`).run(String(value), linkId);
}

function resetLinkSettings(linkId) {
  for (const [key, value] of Object.entries(LINK_DEFAULTS)) setLinkSetting(linkId, key, value);
}

function rowsSources() {
  return db.prepare("SELECT id,chat_id,title,username FROM sources ORDER BY id").all();
}

function rowsDestinations() {
  return db.prepare("SELECT id,chat_id,title,username FROM destinations ORDER BY id").all();
}

function rowsLinks() {
  return db.prepare(`
    SELECT l.id,
           s.id source_id,
           s.chat_id source_chat_id,
           s.title source_title,
           d.id destination_id,
           d.chat_id destination_chat_id,
           d.title destination_title
      FROM links l
      JOIN sources s ON s.id=l.source_id
      JOIN destinations d ON d.id=l.destination_id
     ORDER BY l.id
  `).all();
}

function findLink(id) {
  return rowsLinks().find(link => Number(link.id) === Number(id));
}

function mainKeyboard() {
  return Markup.keyboard([
    ["📥 Джерела", "📤 Приймачі"],
    ["🔗 Зв’язки", "⚙️ Налаштування"],
    ["📊 Статистика", "❓ Допомога"],
  ]).resize().persistent();
}

function formatEntityRow(row) {
  const username = row.username ? ` @${row.username}` : "";
  return `${row.id}. ${row.title}${username}\n   ID: ${row.chat_id}`;
}

function dashboardText(ctx) {
  const status = client ? "🟢 Telegram online" : telegramStarting ? "🟡 Telegram connecting" : "🔴 Telegram offline";
  return T(ctx,
    `👋 Панель управления\n\n${status}\n📥 Источников: ${rowsSources().length}\n📤 Приёмников: ${rowsDestinations().length}\n🔗 Связок: ${rowsLinks().length}\n\nВыберите раздел кнопками ниже.`,
    `👋 Панель керування\n\n${status}\n📥 Джерел: ${rowsSources().length}\n📤 Приймачів: ${rowsDestinations().length}\n🔗 Зв’язків: ${rowsLinks().length}\n\nОберіть розділ кнопками нижче.`
  );
}

function sourcesText(ctx) {
  const rows = rowsSources();
  const body = rows.length ? rows.map(formatEntityRow).join("\n\n") : T(ctx, "Пока нет источников.", "Поки немає джерел.");
  return T(ctx,
    `📥 Источники\n\n${body}\n\nДобавить: /add_source @username или /add_source -1001234567890`,
    `📥 Джерела\n\n${body}\n\nДодати: /add_source @username або /add_source -1001234567890`
  );
}

function destinationsText(ctx) {
  const rows = rowsDestinations();
  const body = rows.length ? rows.map(formatEntityRow).join("\n\n") : T(ctx, "Пока нет приёмников.", "Поки немає приймачів.");
  return T(ctx,
    `📤 Приёмники\n\n${body}\n\nДобавить: /add_destination @username или /add_destination -1001234567890`,
    `📤 Приймачі\n\n${body}\n\nДодати: /add_destination @username або /add_destination -1001234567890`
  );
}

function linksText(ctx) {
  const rows = rowsLinks();
  if (!rows.length) {
    return T(ctx,
      "🔗 Связки\n\nСвязок пока нет. Добавьте источник и приёмник, затем нажмите «➕ Создать связь».",
      "🔗 Зв’язки\n\nЗв’язків поки немає. Додайте джерело й приймач, потім натисніть «➕ Створити зв’язок»."
    );
  }
  return T(ctx,
    `🔗 Связки\n\n${rows.map(link => `${link.id}. ${link.source_title} → ${link.destination_title}`).join("\n")}\n\nОткройте связку для настройки или ручного клонирования.`,
    `🔗 Зв’язки\n\n${rows.map(link => `${link.id}. ${link.source_title} → ${link.destination_title}`).join("\n")}\n\nВідкрийте зв’язок для налаштування або ручного клонування.`
  );
}

function linksKeyboard(ctx) {
  const rows = rowsLinks().map(link => [
    Markup.button.callback(`🔗 ${link.id}. ${link.source_title} → ${link.destination_title}`.slice(0, 64), `link_open:${link.id}`),
  ]);
  rows.push([
    Markup.button.callback(T(ctx, "➕ Создать связь", "➕ Створити зв’язок"), "link_create"),
    Markup.button.callback(T(ctx, "🗑 Удалить связь", "🗑 Видалити зв’язок"), "link_delete"),
  ]);
  rows.push([Markup.button.callback(T(ctx, "🔄 Обновить", "🔄 Оновити"), "links_back")]);
  return Markup.inlineKeyboard(rows);
}

function linkCard(ctx, linkId) {
  const link = findLink(linkId);
  if (!link) return T(ctx, "Связка не найдена.", "Зв’язок не знайдено.");
  return T(ctx,
    `🔗 Связка #${link.id}\n\n📥 ${link.source_title}\n↓\n📤 ${link.destination_title}\n\n` +
      `${getLinkSetting(link.id, "enabled", "1") === "1" ? "🟢 Копирование включено" : "🔴 Копирование выключено"}\n` +
      `🔗 Удалять ссылки: ${getLinkSetting(link.id, "remove_links", "0") === "1" ? "да" : "нет"}\n` +
      `⏱ Задержка: ${Number(getLinkSetting(link.id, "delay", "0")) || 0} сек.\n` +
      `🔎 Ключевые слова: ${getLinkSetting(link.id, "keywords", "") || "нет"}\n` +
      `🚫 Запрещённые слова: ${getLinkSetting(link.id, "ban_words", "") || "нет"}\n` +
      `✍️ Подпись: ${getLinkSetting(link.id, "signature", "") || "нет"}\n` +
      `🔄 Замены: ${getLinkSetting(link.id, "replacements", "") || "нет"}\n\n` +
      `Ручное клонирование:\n/clone_ids ${link.id} 10-20\n/clone_dates ${link.id} 2026-08-01 2026-08-15`,
    `🔗 Зв’язок #${link.id}\n\n📥 ${link.source_title}\n↓\n📤 ${link.destination_title}\n\n` +
      `${getLinkSetting(link.id, "enabled", "1") === "1" ? "🟢 Копіювання увімкнено" : "🔴 Копіювання вимкнено"}\n` +
      `🔗 Видаляти посилання: ${getLinkSetting(link.id, "remove_links", "0") === "1" ? "так" : "ні"}\n` +
      `⏱ Затримка: ${Number(getLinkSetting(link.id, "delay", "0")) || 0} с\n` +
      `🔎 Ключові слова: ${getLinkSetting(link.id, "keywords", "") || "немає"}\n` +
      `🚫 Заборонені слова: ${getLinkSetting(link.id, "ban_words", "") || "немає"}\n` +
      `✍️ Підпис: ${getLinkSetting(link.id, "signature", "") || "немає"}\n` +
      `🔄 Заміни: ${getLinkSetting(link.id, "replacements", "") || "немає"}\n\n` +
      `Ручне клонування:\n/clone_ids ${link.id} 10-20\n/clone_dates ${link.id} 2026-08-01 2026-08-15`
  );
}

function linkKeyboard(ctx, linkId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(getLinkSetting(linkId, "enabled", "1") === "1" ? T(ctx, "⏸ Выключить", "⏸ Вимкнути") : T(ctx, "▶️ Включить", "▶️ Увімкнути"), `link_toggle:${linkId}`)],
    [Markup.button.callback(T(ctx, "🔗 Удалять ссылки", "🔗 Видаляти посилання"), `link_setting:${linkId}:remove_links`), Markup.button.callback(T(ctx, "⏱ Задержка", "⏱ Затримка"), `link_setting:${linkId}:delay`)],
    [Markup.button.callback(T(ctx, "🔎 Ключевые слова", "🔎 Ключові слова"), `link_setting:${linkId}:keywords`), Markup.button.callback(T(ctx, "🚫 Бан-слова", "🚫 Бан-слова"), `link_setting:${linkId}:ban_words`)],
    [Markup.button.callback(T(ctx, "✍️ Подпись", "✍️ Підпис"), `link_setting:${linkId}:signature`), Markup.button.callback(T(ctx, "🔄 Замены", "🔄 Заміни"), `link_setting:${linkId}:replacements`)],
    [Markup.button.callback(T(ctx, "🧹 Сбросить", "🧹 Скинути"), `link_reset:${linkId}`), Markup.button.callback(T(ctx, "🗑 Удалить", "🗑 Видалити"), `link_del:${linkId}`)],
    [Markup.button.callback(T(ctx, "⬅️ К связкам", "⬅️ До зв’язків"), "links_back")],
  ]);
}

function helpText(ctx) {
  return T(ctx,
    `❓ Помощь\n\n` +
      `/auth — подключить Telegram-аккаунт\n` +
      `/add_source @channel — добавить источник\n` +
      `/add_destination @channel — добавить приёмник\n` +
      `/clone_ids LINK_ID 10-20 — скопировать посты по номерам\n` +
      `/clone_dates LINK_ID 2026-08-01 2026-08-15 [limit] — скопировать посты за даты\n\n` +
      `Сначала добавьте источник и приёмник, затем создайте связку в разделе «🔗 Связки».`,
    `❓ Допомога\n\n` +
      `/auth — підключити Telegram-акаунт\n` +
      `/add_source @channel — додати джерело\n` +
      `/add_destination @channel — додати приймач\n` +
      `/clone_ids LINK_ID 10-20 — скопіювати пости за номерами\n` +
      `/clone_dates LINK_ID 2026-08-01 2026-08-15 [limit] — скопіювати пости за датами\n\n` +
      `Спочатку додайте джерело й приймач, потім створіть зв’язок у розділі «🔗 Зв’язки».`
  );
}

function waitAuth(field) {
  return new Promise((resolve, reject) => {
    auth[field] = { resolve, reject };
  });
}

function provideAuth(field, value) {
  const promise = auth[field];
  if (!promise?.resolve) return false;
  auth[field] = null;
  promise.resolve(value);
  return true;
}

function failAuth(error) {
  for (const field of ["phone", "code", "password"]) {
    if (auth[field]?.reject) auth[field].reject(error);
    auth[field] = null;
  }
}

function readSession() {
  if (fs.existsSync(SESSION_PATH)) return fs.readFileSync(SESSION_PATH, "utf8").trim();
  return "";
}

function saveSession(value) {
  const session = String(value || "").trim();
  if (!session) return;
  setSetting("mtproto_session", session);
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(`${SESSION_PATH}.tmp`, session, "utf8");
  fs.renameSync(`${SESSION_PATH}.tmp`, SESSION_PATH);
  console.log(`SESSION: saved to ${SESSION_PATH}`);
}

function normalizeTarget(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^https?:\/\/t\.me\//i, "@").replace(/^t\.me\//i, "@");
}

function entityTitle(entity, fallback) {
  return entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username || String(fallback);
}

function entityChatId(entity, fallback) {
  const raw = entity?.id?.value ?? entity?.id ?? fallback;
  const n = Number(raw);
  if (entity?.className === "Channel" && n > 0) return Number(`-100${n}`);
  return n;
}

async function addChat(kind, rawTarget) {
  if (!client) throw new Error("Telegram не авторизован. Используйте /auth.");
  const target = normalizeTarget(rawTarget);
  if (!target) throw new Error("Укажите @username, ссылку t.me или chat_id.");
  const entity = await client.getEntity(target);
  const chatId = entityChatId(entity, target);
  const title = entityTitle(entity, target);
  const username = entity?.username || null;
  const table = kind === "source" ? "sources" : "destinations";
  db.prepare(`INSERT INTO ${table}(chat_id,title,username) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`)
    .run(chatId, title, username);
  return { chatId, title };
}

function applyText(linkId, value) {
  let text = String(value || "");
  const ban = csv(getLinkSetting(linkId, "ban_words", getSetting("ban_words", "")));
  const keys = csv(getLinkSetting(linkId, "keywords", getSetting("keywords", "")));

  if (ban.some(word => text.toLowerCase().includes(word.toLowerCase()))) return null;
  if (keys.length && !keys.some(word => text.toLowerCase().includes(word.toLowerCase()))) return null;

  if (getLinkSetting(linkId, "remove_links", getSetting("remove_links", "0")) === "1") {
    text = text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi, "");
  }

  const replacements = getLinkSetting(linkId, "replacements", getSetting("replacements", ""));
  for (const line of replacements.split(/\r?\n/)) {
    if (!line.includes("->")) continue;
    const index = line.indexOf("->");
    const from = line.slice(0, index).trim();
    const to = line.slice(index + 2).trim();
    if (from) text = text.split(from).join(to);
  }

  const signature = getLinkSetting(linkId, "signature", getSetting("signature", ""));
  if (signature) text = text.trim() ? `${text.trim()}\n\n${signature}` : signature;
  return text.trim();
}

async function copyMessage(message, destination, linkId) {
  const text = applyText(linkId, message.message || "");
  if (text === null) return null;
  if (message.media) return client.sendFile(destination, { file: message.media, caption: text || undefined, forceDocument: false });
  if (!text) return null;
  return client.sendMessage(destination, { message: text, linkPreview: false });
}

function markCopied(linkId, sourceChatId, sourceMessageId, destinationChatId, destinationMessageId, error = null) {
  if (!error) {
    db.prepare("INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id) VALUES(?,?,?,?)")
      .run(sourceChatId, sourceMessageId, destinationChatId, destinationMessageId);
  }
  db.prepare("INSERT OR REPLACE INTO link_stats(link_id,source_message_id,destination_message_id,error) VALUES(?,?,?,?)")
    .run(linkId, sourceMessageId, destinationMessageId || null, error);
}

async function copyMessageToLink(message, link, options = {}) {
  const sourceChatId = Number(link.source_chat_id);
  const destinationChatId = Number(link.destination_chat_id);
  const sourceMessageId = Number(message.id);

  if (!options.force && db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?").get(sourceChatId, sourceMessageId, destinationChatId)) {
    return { skipped: true };
  }

  const delay = options.skipDelay ? 0 : Number(getLinkSetting(link.id, "delay", getSetting("delay", "0"))) || 0;
  if (delay) await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(3600, delay)) * 1000));

  const sent = await copyMessage(message, await client.getEntity(destinationChatId), link.id);
  if (!sent) return { skipped: true };

  const sentId = Number(Array.isArray(sent) ? sent[0]?.id : sent.id);
  markCopied(link.id, sourceChatId, sourceMessageId, destinationChatId, sentId);
  return { copied: true, sentId };
}

async function processMessage(message) {
  if (!client || !message) return;
  const sourceChatId = Number(message.chatId?.value ?? message.chatId);
  const source = db.prepare("SELECT id FROM sources WHERE chat_id=?").get(sourceChatId);
  if (!source) return;

  const rows = rowsLinks().filter(link => Number(link.source_id) === Number(source.id));
  console.log(`FORWARDER: event source=${sourceChatId} message=${message.id} destinations=${rows.length}`);

  for (const link of rows) {
    if (getLinkSetting(link.id, "enabled", "1") !== "1") continue;
    try {
      const result = await copyMessageToLink(message, link);
      if (result.copied) console.log(`FORWARDER COPIED ${sourceChatId}:${message.id} -> ${link.destination_chat_id}:${result.sentId}`);
    } catch (error) {
      markCopied(link.id, sourceChatId, Number(message.id), Number(link.destination_chat_id), null, String(error?.message || error));
      console.error(`FORWARDER COPY ERROR ${sourceChatId}:${message.id} -> ${link.destination_chat_id}:`, error?.stack || error);
    }
  }
}

async function setupTelegramHandlers() {
  if (!client || client.__forwardingHandler) return;
  client.__forwardingHandler = true;
  client.addEventHandler(async event => {
    try {
      await processMessage(event.message);
    } catch (error) {
      console.error("FORWARDER EVENT ERROR:", error?.stack || error);
    }
  }, new NewMessage({}));
  console.log("FORWARDER: NewMessage handler registered.");
}

async function connectSavedSession() {
  if (client || telegramStarting) return;
  const saved = readSession() || getSetting("mtproto_session", "") || MT_SESSION;
  console.log(`TELEGRAM: session check file=${readSession() ? "YES" : "NO"} db=${getSetting("mtproto_session", "") ? "YES" : "NO"} env=${MT_SESSION ? "YES" : "NO"}`);
  if (!saved) {
    telegramError = "NO TELEGRAM SESSION. Use /auth.";
    return;
  }

  telegramStarting = true;
  let nextClient = null;
  try {
    nextClient = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 10, autoReconnect: true });
    console.log("TELEGRAM: connecting...");
    await nextClient.connect();
    if (!(await nextClient.checkAuthorization())) throw new Error("SAVED SESSION INVALID");
    const me = await nextClient.getMe();
    client = nextClient;
    saveSession(nextClient.session.save());
    await setupTelegramHandlers();
    console.log(`TELEGRAM: ACCOUNT RESTORED id=${me.id} username=@${me.username || "—"}`);
  } catch (error) {
    telegramError = String(error?.message || error);
    console.error("TELEGRAM: SESSION RESTORE ERROR:", error?.stack || error);
    if (nextClient) await nextClient.disconnect();
    client = null;
  } finally {
    telegramStarting = false;
  }
}

async function beginLogin() {
  if (client || loginInProgress) return;
  loginInProgress = true;
  telegramStarting = true;
  const nextClient = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 10, autoReconnect: true });
  client = nextClient;
  nextClient.start({
    phoneNumber: () => waitAuth("phone"),
    phoneCode: () => waitAuth("code"),
    password: () => waitAuth("password"),
    onError: error => console.error("Telegram auth:", error),
  }).then(async () => {
    const me = await nextClient.getMe();
    saveSession(nextClient.session.save());
    await setupTelegramHandlers();
    console.log(`TELEGRAM: ACCOUNT AUTHORIZED id=${me.id} username=@${me.username || "—"}`);
  }).catch(error => {
    telegramError = String(error?.message || error);
    console.error("TELEGRAM AUTH ERROR:", error?.stack || error);
    failAuth(error);
    if (client === nextClient) client = null;
  }).finally(() => {
    loginInProgress = false;
    telegramStarting = false;
  });
}

function parseIds(raw) {
  const ids = new Set();
  for (const part of String(raw || "").split(",")) {
    const value = part.trim();
    if (!value) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(value);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let id = Math.min(start, end); id <= Math.max(start, end); id += 1) ids.add(id);
      continue;
    }
    if (/^\d+$/.test(value)) ids.add(Number(value));
  }
  return [...ids].sort((a, b) => a - b);
}

function parseDate(value, endOfDay = false) {
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const date = new Date(`${value}${/^\d{4}-\d{2}-\d{2}$/.test(value) ? suffix : ""}`);
  if (Number.isNaN(date.getTime())) throw new Error("Дата должна быть в формате YYYY-MM-DD.");
  return date;
}

function messageDate(message) {
  const raw = message.date;
  if (raw instanceof Date) return raw;
  if (typeof raw === "number") return new Date(raw * 1000);
  return new Date(raw);
}

async function cloneByIds(linkId, rawIds) {
  if (!client) throw new Error("Telegram не авторизован. Используйте /auth.");
  const link = findLink(linkId);
  if (!link) throw new Error("Связка не найдена.");
  const ids = parseIds(rawIds);
  if (!ids.length) throw new Error("Укажите номера постов: 10,12 или 10-20.");

  const source = await client.getEntity(Number(link.source_chat_id));
  const messages = await client.getMessages(source, { ids });
  const list = Array.isArray(messages) ? messages : [messages];
  let copied = 0;
  let skipped = 0;

  for (const message of list.filter(Boolean).sort((a, b) => Number(a.id) - Number(b.id))) {
    const result = await copyMessageToLink(message, link, { force: true, skipDelay: true });
    if (result.copied) copied += 1;
    else skipped += 1;
  }

  return { copied, skipped, requested: ids.length };
}

async function cloneByDates(linkId, fromValue, toValue, limitValue) {
  if (!client) throw new Error("Telegram не авторизован. Используйте /auth.");
  const link = findLink(linkId);
  if (!link) throw new Error("Связка не найдена.");
  const from = parseDate(fromValue);
  const to = parseDate(toValue, true);
  const limit = Math.min(Math.max(Number(limitValue) || 500, 1), 5000);
  const source = await client.getEntity(Number(link.source_chat_id));
  const messages = [];

  for await (const message of client.iterMessages(source, { limit })) {
    const date = messageDate(message);
    if (date >= from && date <= to) messages.push(message);
    if (date < from) break;
  }

  let copied = 0;
  let skipped = 0;
  for (const message of messages.sort((a, b) => Number(a.id) - Number(b.id))) {
    const result = await copyMessageToLink(message, link, { force: true, skipDelay: true });
    if (result.copied) copied += 1;
    else skipped += 1;
  }

  return { copied, skipped, scanned: limit, matched: messages.length };
}

bot.use(async (ctx, next) => {
  if (ctx.from && !isAdmin(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
    return undefined;
  }
  return next();
});

bot.start(ctx => ctx.reply(dashboardText(ctx), mainKeyboard()));

bot.command("auth", async ctx => {
  if (client) return ctx.reply(T(ctx, "Telegram уже подключен.", "Telegram вже підключено."));
  beginLogin();
  return ctx.reply(T(ctx, "Введите номер телефона:", "Введіть номер телефону:"));
});

bot.command("add_source", async ctx => {
  try {
    const target = ctx.message.text.split(/\s+/).slice(1).join(" ");
    const added = await addChat("source", target);
    return ctx.reply(T(ctx, `✅ Источник добавлен: ${added.title}\nID: ${added.chatId}`, `✅ Джерело додано: ${added.title}\nID: ${added.chatId}`));
  } catch (error) {
    return ctx.reply(`❌ ${error.message || error}`);
  }
});

bot.command("add_destination", async ctx => {
  try {
    const target = ctx.message.text.split(/\s+/).slice(1).join(" ");
    const added = await addChat("destination", target);
    return ctx.reply(T(ctx, `✅ Приёмник добавлен: ${added.title}\nID: ${added.chatId}`, `✅ Приймач додано: ${added.title}\nID: ${added.chatId}`));
  } catch (error) {
    return ctx.reply(`❌ ${error.message || error}`);
  }
});

bot.command("clone_ids", async ctx => {
  const [, linkId, ...rest] = ctx.message.text.split(/\s+/);
  const progress = await ctx.reply(T(ctx, "⏳ Клонирую посты по номерам...", "⏳ Клоную пости за номерами..."));
  try {
    const result = await cloneByIds(Number(linkId), rest.join(" "));
    return ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, T(ctx,
      `✅ Готово\nЗапрошено: ${result.requested}\nСкопировано: ${result.copied}\nПропущено фильтрами: ${result.skipped}`,
      `✅ Готово\nЗапитано: ${result.requested}\nСкопійовано: ${result.copied}\nПропущено фільтрами: ${result.skipped}`
    ));
  } catch (error) {
    return ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, `❌ ${error.message || error}`);
  }
});

bot.command("clone_dates", async ctx => {
  const [, linkId, from, to, limit] = ctx.message.text.split(/\s+/);
  const progress = await ctx.reply(T(ctx, "⏳ Клонирую посты за период...", "⏳ Клоную пости за період..."));
  try {
    const result = await cloneByDates(Number(linkId), from, to, limit);
    return ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, T(ctx,
      `✅ Готово\nНайдено: ${result.matched}\nСкопировано: ${result.copied}\nПропущено фильтрами: ${result.skipped}\nЛимит сканирования: ${result.scanned}`,
      `✅ Готово\nЗнайдено: ${result.matched}\nСкопійовано: ${result.copied}\nПропущено фільтрами: ${result.skipped}\nЛіміт сканування: ${result.scanned}`
    ));
  } catch (error) {
    return ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, `❌ ${error.message || error}`);
  }
});

bot.on("text", async ctx => {
  const text = ctx.message.text;
  if (provideAuth("phone", text) || provideAuth("code", text) || provideAuth("password", text)) return;

  const state = inputState.get(ctx.from.id);
  if (!state) return;

  if (state.type === "setting") {
    if (state.key === "delay" && (!/^\d{1,4}$/.test(text.trim()) || Number(text.trim()) > 3600)) {
      return ctx.reply(T(ctx, "❌ Введите число от 0 до 3600.", "❌ Введіть число від 0 до 3600."));
    }
    setLinkSetting(state.linkId, state.key, text.trim());
    inputState.delete(ctx.from.id);
    return ctx.reply(T(ctx, "✅ Настройка сохранена.", "✅ Налаштування збережено."), linkKeyboard(ctx, state.linkId));
  }
});

bot.hears("📥 Джерела", ctx => ctx.reply(sourcesText(ctx)));
bot.hears("📤 Приймачі", ctx => ctx.reply(destinationsText(ctx)));
bot.hears("🔗 Зв’язки", ctx => ctx.reply(linksText(ctx), linksKeyboard(ctx)));
bot.hears("⚙️ Налаштування", ctx => ctx.reply(T(ctx,
  "⚙️ Настройки\n\nГлобальные настройки лучше задавать на уровне конкретной связки: откройте «🔗 Связки» и выберите нужную связь.",
  "⚙️ Налаштування\n\nГлобальні налаштування краще задавати на рівні конкретного зв’язку: відкрийте «🔗 Зв’язки» і виберіть потрібний зв’язок."
)));
bot.hears("📊 Статистика", ctx => {
  const copied = db.prepare("SELECT COUNT(*) c FROM copied").get().c;
  const errors = db.prepare("SELECT COUNT(*) c FROM link_stats WHERE error IS NOT NULL").get().c;
  return ctx.reply(T(ctx,
    `📊 Статистика\n\n📥 Источников: ${rowsSources().length}\n📤 Приёмников: ${rowsDestinations().length}\n🔗 Связок: ${rowsLinks().length}\n📨 Скопировано: ${copied}\n❌ Ошибок: ${errors}`,
    `📊 Статистика\n\n📥 Джерел: ${rowsSources().length}\n📤 Приймачів: ${rowsDestinations().length}\n🔗 Зв’язків: ${rowsLinks().length}\n📨 Скопійовано: ${copied}\n❌ Помилок: ${errors}`
  ));
});
bot.hears("❓ Допомога", ctx => ctx.reply(helpText(ctx)));

bot.action("link_create", async ctx => {
  await ctx.answerCbQuery();
  const sources = rowsSources();
  const destinations = rowsDestinations();
  if (!sources.length || !destinations.length) return ctx.reply(T(ctx, "Сначала добавьте источник и приёмник.", "Спочатку додайте джерело й приймач."));
  return ctx.reply(T(ctx, "1️⃣ Выберите источник:", "1️⃣ Оберіть джерело:"), Markup.inlineKeyboard(sources.map(row => [Markup.button.callback(`📥 ${row.title}`, `link_src:${row.id}`)])));
});

bot.action(/^link_src:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const sourceId = Number(ctx.match[1]);
  return ctx.reply(T(ctx, "2️⃣ Выберите приёмник:", "2️⃣ Оберіть приймач:"), Markup.inlineKeyboard(rowsDestinations().map(row => [Markup.button.callback(`📤 ${row.title}`, `link_dst:${sourceId}:${row.id}`)])));
});

bot.action(/^link_dst:(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const sourceId = Number(ctx.match[1]);
  const destinationId = Number(ctx.match[2]);
  db.prepare("INSERT OR IGNORE INTO links(source_id,destination_id) VALUES(?,?)").run(sourceId, destinationId);
  const link = db.prepare("SELECT id FROM links WHERE source_id=? AND destination_id=?").get(sourceId, destinationId);
  resetLinkSettings(link.id);
  return ctx.reply(T(ctx, "✅ Связка создана.", "✅ Зв’язок створено."), linkKeyboard(ctx, link.id));
});

bot.action(/^link_open:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const linkId = Number(ctx.match[1]);
  return ctx.reply(linkCard(ctx, linkId), linkKeyboard(ctx, linkId));
});

bot.action(/^link_toggle:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const linkId = Number(ctx.match[1]);
  setLinkSetting(linkId, "enabled", getLinkSetting(linkId, "enabled", "1") === "1" ? "0" : "1");
  return ctx.editMessageText(linkCard(ctx, linkId), linkKeyboard(ctx, linkId));
});

bot.action(/^link_setting:(\d+):(\w+)$/, async ctx => {
  await ctx.answerCbQuery();
  const linkId = Number(ctx.match[1]);
  const key = ctx.match[2];
  if (key === "remove_links") {
    setLinkSetting(linkId, key, getLinkSetting(linkId, key, "0") === "1" ? "0" : "1");
    return ctx.editMessageText(linkCard(ctx, linkId), linkKeyboard(ctx, linkId));
  }
  inputState.set(ctx.from.id, { type: "setting", linkId, key });
  const prompts = {
    delay: T(ctx, "Введите задержку в секундах от 0 до 3600.", "Введіть затримку в секундах від 0 до 3600."),
    keywords: T(ctx, "Введите ключевые слова через запятую.", "Введіть ключові слова через кому."),
    ban_words: T(ctx, "Введите запрещённые слова через запятую.", "Введіть заборонені слова через кому."),
    signature: T(ctx, "Введите подпись.", "Введіть підпис."),
    replacements: T(ctx, "Введите замены, по одной на строку: старое -> новое", "Введіть заміни, по одній на рядок: старе -> нове"),
  };
  return ctx.reply(prompts[key] || T(ctx, "Введите значение.", "Введіть значення."));
});

bot.action(/^link_reset:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const linkId = Number(ctx.match[1]);
  resetLinkSettings(linkId);
  return ctx.editMessageText(linkCard(ctx, linkId), linkKeyboard(ctx, linkId));
});

bot.action("links_back", async ctx => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(linksText(ctx), linksKeyboard(ctx));
});

bot.action(/^link_del:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const linkId = Number(ctx.match[1]);
  db.prepare("DELETE FROM links WHERE id=?").run(linkId);
  db.prepare("DELETE FROM link_settings WHERE link_id=?").run(linkId);
  return ctx.editMessageText(T(ctx, "✅ Связка удалена.", "✅ Зв’язок видалено."), linksKeyboard(ctx));
});

bot.action("link_delete", async ctx => {
  await ctx.answerCbQuery();
  const rows = rowsLinks();
  if (!rows.length) return ctx.reply(T(ctx, "Нет связок для удаления.", "Немає зв’язків для видалення."));
  return ctx.reply(T(ctx, "Выберите связку для удаления:", "Оберіть зв’язок для видалення:"), Markup.inlineKeyboard(rows.map(link => [Markup.button.callback(`${link.id}. ${link.source_title} → ${link.destination_title}`, `link_del:${link.id}`)])));
});

bot.catch(error => console.error("Bot error:", error?.stack || error));

const app = express();
app.get("/", (_, res) => res.status(200).send("telegram-post-cloner OK"));
app.get("/health", (_, res) => res.json({ ok: true, telegram: !!client, error: telegramError || null }));
app.listen(PORT, () => console.log(`HTTP server on ${PORT}`));

(async () => {
  console.log(`Starting management bot. ADMIN_IDS=${[...ADMIN_IDS].join(",")}`);
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log("BOT: webhook cleared.");
  } catch (error) {
    console.error("BOT: deleteWebhook failed:", error?.message || error);
  }
  try {
    console.log("BOT: starting polling...");
    await bot.launch();
    console.log("Management bot started.");
  } catch (error) {
    console.error("BOT: polling start failed:", error?.stack || error);
  }
  connectSavedSession().catch(error => console.error("TELEGRAM startup error:", error?.stack || error));
})();

function stopBot(signal) {
  try {
    bot.stop(signal);
  } catch (error) {
    if (!String(error?.message || error).includes("Bot is not running")) throw error;
  }
}

process.once("SIGINT", () => stopBot("SIGINT"));
process.once("SIGTERM", () => stopBot("SIGTERM"));
