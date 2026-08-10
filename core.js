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
const ADMIN_IDS = new Set(String(process.env.ADMIN_IDS || "").split(",").map(x => Number(x.trim())).filter(Boolean));
const PORT = Number(process.env.PORT || 3000);
const AUTH_KEY = process.env.AUTH_KEY || "";
const AUTH_URL = String(process.env.AUTH_URL || "").replace(/\/$/, "");
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

const DEFAULTS = {
 remove_links: "0",
 delay: "0",
 keywords: "",
 ban_words: "",
 signature: "",
 replacements: ""
};
const LINK_DEFAULTS = { enabled: "1", ...DEFAULTS };

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? String(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}
function getLinkSetting(id, key, fallback = "") {
  if (!Object.prototype.hasOwnProperty.call(LINK_DEFAULTS, key)) return fallback;
  db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(id);
  const row = db.prepare(`SELECT ${key} value FROM link_settings WHERE link_id=?`).get(id);
  return row && row.value !== null && String(row.value) !== "" ? String(row.value) : fallback;
}
function setLinkSetting(id, key, value) {
  if (!Object.prototype.hasOwnProperty.call(LINK_DEFAULTS, key)) return;
  db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(id);
  db.prepare(`UPDATE link_settings SET ${key}=? WHERE link_id=?`).run(String(value), id);
}
function resetLinkSettings(id) {
  for (const [k, v] of Object.entries(LINK_DEFAULTS)) setLinkSetting(id, k, v);
}
function isAdmin(id) { return ADMIN_IDS.has(Number(id)); }
function csv(v) { return String(v || "").split(",").map(x => x.trim()).filter(Boolean); }

function rowsSources() { return db.prepare("SELECT id,chat_id,title,username FROM sources ORDER BY id").all(); }
function rowsDestinations() { return db.prepare("SELECT id,chat_id,title,username FROM destinations ORDER BY id").all(); }
function rowsLinks() {
  return db.prepare(`SELECT l.id,s.id source_id,s.title source_title,d.id destination_id,d.title destination_title
    FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id ORDER BY l.id`).all();
}
function language(ctx) {
  try { return require("./language.js").lang(ctx.from?.id) === "uk" ? "uk" : "ru"; } catch (_) { return "uk"; }
}
function T(ctx, ru, uk = ru) { return language(ctx) === "uk" ? uk : ru; }

function mainKeyboard() {
  return Markup.keyboard([
    ["📥 Джерела", "📤 Приймачі"],
    ["🔗 Зв’язки", "⚙️ Налаштування"],
    ["📊 Статистика", "❓ Допомога"]
  ]).resize().persistent();
}

const bot = new Telegraf(BOT_TOKEN);
const inputState = new Map();
const auth = { phone: null, code: null, password: null };
let client = null;
let loginInProgress = false;
let telegramStarting = false;
let telegramError = "";

function waitAuth(field) {
  return new Promise((resolve, reject) => { auth[field] = { resolve, reject }; });
}
function provideAuth(field, value) {
  const p = auth[field];
  if (!p || !p.resolve) return false;
  auth[field] = null;
  p.resolve(value);
  return true;
}
function failAuth(error) {
  for (const field of ["phone", "code", "password"]) {
    if (auth[field]?.reject) auth[field].reject(error);
    auth[field] = null;
  }
}
function readSession() {
  try { return fs.existsSync(SESSION_PATH) ? fs.readFileSync(SESSION_PATH, "utf8").trim() : ""; } catch (_) { return ""; }
}
function saveSession(value) {
  value = String(value || "").trim();
  if (!value) return;
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("mtproto_session", value);
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(`${SESSION_PATH}.tmp`, value, "utf8");
  fs.renameSync(`${SESSION_PATH}.tmp`, SESSION_PATH);
  console.log(`SESSION: saved to ${SESSION_PATH}`);
}
function clearSession() {
  db.prepare("DELETE FROM settings WHERE key='mtproto_session'").run();
  try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); } catch (_) {}
}

function applyText(linkId, text) {
  text = String(text || "");
  const ban = csv(getLinkSetting(linkId, "ban_words", getSetting("ban_words", "")));
  const keys = csv(getLinkSetting(linkId, "keywords", getSetting("keywords", "")));
  if (ban.some(w => text.toLowerCase().includes(w.toLowerCase()))) return null;
  if (keys.length && !keys.some(w => text.toLowerCase().includes(w.toLowerCase()))) return null;
  if (getLinkSetting(linkId, "remove_links", getSetting("remove_links", "0")) === "1") {
    text = text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi, "");
  }
  const replacements = getLinkSetting(linkId, "replacements", getSetting("replacements", ""));
  for (const line of replacements.split(/\r?\n/)) {
    if (!line.includes("->")) continue;
    const p = line.indexOf("->");
    const oldText = line.slice(0, p).trim();
    const newText = line.slice(p + 2).trim();
    if (oldText) text = text.split(oldText).join(newText);
  }
  const signature = getLinkSetting(linkId, "signature", getSetting("signature", ""));
  if (signature) text = text.trim() ? `${text.trim()}\n\n${signature}` : signature;
  return text.trim();
}

async function copyMessage(message, destination, linkId) {
  const text = applyText(linkId, message.message || "");
  if (text === null) return null;
  if (message.media) {
    return client.sendFile(destination, { file: message.media, caption: text || undefined, forceDocument: false });
  }
  if (!text) return null;
  return client.sendMessage(destination, { message: text, linkPreview: false });
}

async function processMessage(message) {
  if (!client || !message) return;
  const sourceChatId = Number(message.chatId?.value ?? message.chatId);
  const source = db.prepare("SELECT id FROM sources WHERE chat_id=?").get(sourceChatId);
  if (!source) return;

  const destinations = db.prepare(`SELECT l.id link_id,l.destination_id,d.chat_id
    FROM links l JOIN destinations d ON d.id=l.destination_id WHERE l.source_id=? ORDER BY l.id`).all(source.id);

  console.log(`FORWARDER: event source=${sourceChatId} message=${message.id} destinations=${destinations.length}`);
  for (const row of destinations) {
    const linkId = Number(row.link_id);
    if (getLinkSetting(linkId, "enabled", "1") !== "1") continue;
    const destinationChatId = Number(row.chat_id);
    const messageId = Number(message.id);
    if (db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?").get(sourceChatId, messageId, destinationChatId)) continue;

    try {
      const delay = Math.max(0, Math.min(3600, Number(getLinkSetting(linkId, "delay", getSetting("delay", "0"))) || 0));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay * 1000));
      const destination = await client.getEntity(destinationChatId);
      const sent = await copyMessage(message, destination, linkId);
      if (!sent) continue;
      db.prepare("INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id) VALUES(?,?,?,?)")
        .run(sourceChatId, messageId, destinationChatId, Number(sent.id));
      db.prepare("INSERT OR REPLACE INTO link_stats(link_id,source_message_id,destination_message_id,error) VALUES(?,?,?,NULL)")
        .run(linkId, messageId, Number(sent.id));
      console.log(`FORWARDER COPIED ${sourceChatId}:${messageId} -> ${destinationChatId}:${sent.id}`);
    } catch (error) {
      console.error(`FORWARDER COPY ERROR ${sourceChatId}:${messageId} -> ${destinationChatId}:`, error?.stack || error);
      db.prepare("INSERT OR REPLACE INTO link_stats(link_id,source_message_id,destination_message_id,error) VALUES(?,?,NULL,?)")
        .run(linkId, messageId, String(error?.message || error));
    }
  }
}

async function setupTelegramHandlers() {
  if (!client || client.__forwardingHandler) return;
  client.__forwardingHandler = true;
  client.addEventHandler(async event => {
    try { await processMessage(event.message); }
    catch (error) { console.error("FORWARDER EVENT ERROR:", error?.stack || error); }
  }, new NewMessage({}));
  console.log("FORWARDER: NewMessage handler registered.");
}

async function connectSavedSession() {
  if (client || telegramStarting) return;
  const fileSession = readSession();
  const dbSession = getSetting("mtproto_session", "");
  const saved = fileSession || dbSession || MT_SESSION;
  console.log(`TELEGRAM: session check file=${fileSession ? "YES" : "NO"} db=${dbSession ? "YES" : "NO"} env=${MT_SESSION ? "YES" : "NO"}`);
  if (!saved) { telegramError = "NO TELEGRAM SESSION. Use /auth."; return; }

  telegramStarting = true;
  telegramError = "";
  let c = null;
  try {
    c = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 10, autoReconnect: true });
    console.log("TELEGRAM: connecting...");
    await c.connect();
    const authorized = await c.checkAuthorization();
    if (!authorized) throw new Error("SAVED SESSION INVALID");
    const me = await c.getMe();
    client = c;
    saveSession(c.session.save());
    console.log(`TELEGRAM: ACCOUNT RESTORED id=${me.id} username=@${me.username || "—"}`);
    await setupTelegramHandlers();
    console.log("TELEGRAM: READY — forwarding is active.");
  } catch (error) {
    telegramError = String(error?.message || error);
    console.error("TELEGRAM: SESSION RESTORE ERROR:", error?.stack || error);
    if (String(error?.message || "").includes("INVALID")) clearSession();
    if (c) { try { await c.disconnect(); } catch (_) {} }
    client = null;
  } finally { telegramStarting = false; }
}

async function beginLogin() {
  if (client || loginInProgress) return;
  loginInProgress = true;
  telegramStarting = true;
  telegramError = "";
  const c = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 10, autoReconnect: true });
  client = c;
  c.start({
    phoneNumber: () => waitAuth("phone"),
    phoneCode: () => waitAuth("code"),
    password: () => waitAuth("password"),
    onError: error => console.error("Telegram auth:", error)
  }).then(async () => {
    try {
      const me = await c.getMe();
      saveSession(c.session.save());
      await setupTelegramHandlers();
      console.log(`TELEGRAM: ACCOUNT AUTHORIZED id=${me.id} username=@${me.username || "—"}`);
    } catch (error) {
      telegramError = String(error?.message || error);
      console.error("TELEGRAM: POST-LOGIN ERROR:", error?.stack || error);
      try { await c.disconnect(); } catch (_) {}
      client = null;
    }
  }).catch(error => {
    telegramError = String(error?.message || error);
    console.error("TELEGRAM AUTH ERROR:", error?.stack || error);
    failAuth(error);
    if (client === c) client = null;
  }).finally(() => { loginInProgress = false; telegramStarting = false; });
}

function linkListText(ctx) {
  const ls = rowsLinks();
  return T(ctx,
    ls.length ? `🔗 Связки\n\n${ls.map(x => `${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}` : "🔗 Связки\n\nНет связок.",
    ls.length ? `🔗 Зв’язки\n\n${ls.map(x => `${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}` : "🔗 Зв’язки\n\nНемає зв’язків."
  );
}
function linkMenu(ctx) {
  const rows = rowsLinks().map(r => [Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0, 60), `link_open:${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx, "➕ Создать связку", "➕ Створити зв’язок"), "link_create")]);
  if (rowsLinks().length) rows.push([Markup.button.callback(T(ctx, "🗑 Удалить связку", "🗑 Видалити зв’язок"), "link_delete")]);
  rows.push([Markup.button.callback(T(ctx, "🔄 Обновить", "🔄 Оновити"), "link_menu")]);
  return Markup.inlineKeyboard(rows);
}
function linkCard(ctx, id) {
  const r = rowsLinks().find(x => x.id === id);
  if (!r) return T(ctx, "❌ Связка не найдена.", "❌ Зв’язок не знайдено.");
  return T(ctx,
    `🔗 Связка #${id}\n\n📥 ${r.source_title}\n↓\n📤 ${r.destination_title}\n\n${getLinkSetting(id,"enabled","1")==="1"?"🟢 Копирование включено":"🔴 Копирование выключено"}\n🔗 Удалять ссылки: ${getLinkSetting(id,"remove_links",getSetting("remove_links","0"))==="1"?"🟢":"🔴"}\n⏱ Задержка: ${getLinkSetting(id,"delay",getSetting("delay","0"))} сек.\n🔎 Белый фильтр: ${getLinkSetting(id,"keywords",getSetting("keywords",""))||"нет"}\n🚫 Чёрный фильтр: ${getLinkSetting(id,"ban_words",getSetting("ban_words",""))||"нет"}\n✍️ Подпись: ${getLinkSetting(id,"signature",getSetting("signature",""))||"нет"}\n🔄 Замены: ${getLinkSetting(id,"replacements",getSetting("replacements",""))||"нет"}`,
    `🔗 Зв’язок #${id}\n\n📥 ${r.source_title}\n↓\n📤 ${r.destination_title}\n\n${getLinkSetting(id,"enabled","1")==="1"?"🟢 Копіювання увімкнено":"🔴 Копіювання вимкнено"}\n🔗 Видаляти посилання: ${getLinkSetting(id,"remove_links",getSetting("remove_links","0"))==="1"?"🟢":"🔴"}\n⏱ Затримка: ${getLinkSetting(id,"delay",getSetting("delay","0"))} с\n🔎 Білий фільтр: ${getLinkSetting(id,"keywords",getSetting("keywords",""))||"немає"}\n🚫 Чорний фільтр: ${getLinkSetting(id,"ban_words",getSetting("ban_words",""))||"немає"}\n✍️ Підпис: ${getLinkSetting(id,"signature",getSetting("signature",""))||"немає"}\n🔄 Заміни: ${getLinkSetting(id,"replacements",getSetting("replacements",""))||"немає"}`
  );
}
function linkSettingsKeyboard(ctx, id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(getLinkSetting(id,"enabled","1")==="1"?T(ctx,"⏸ Выключить","⏸ Вимкнути"):T(ctx,"▶️ Включить","▶️ Увімкнути"), `link_toggle:${id}`)],
    [Markup.button.callback(`${T(ctx,"🔗 Удалять ссылки","🔗 Видаляти посилання")}: ${getLinkSetting(id,"remove_links",getSetting("remove_links","0"))==="1"?"🟢":"🔴"}`, `link_remove:${id}`), Markup.button.callback(`⏱ ${getLinkSetting(id,"delay",getSetting("delay","0"))} ${T(ctx,"сек.","с")}`, `link_delay:${id}`)],
    [Markup.button.callback(T(ctx,"🔎 Белый фильтр","🔎 Білий фільтр"), `link_keywords:${id}`), Markup.button.callback(T(ctx,"🚫 Чёрный фильтр","🚫 Чорний фільтр"), `link_ban:${id}`)],
    [Markup.button.callback(T(ctx,"✍️ Подпись","✍️ Підпис"), `link_signature:${id}`), Markup.button.callback(T(ctx,"🔄 Замены","🔄 Заміни"), `link_replace:${id}`)],
    [Markup.button.callback(T(ctx,"📊 Статистика","📊 Статистика"), `link_stats:${id}`), Markup.button.callback(T(ctx,"🧹 Сбросить","🧹 Скинути"), `link_reset:${id}`)],
    [Markup.button.callback(T(ctx,"⬅️ К связкам","⬅️ До зв’язків"), "link_menu")]
  ]);
}
function sourceSelectKeyboard(ctx) {
  return Markup.inlineKeyboard([
    ...rowsSources().map(r => [Markup.button.callback(`📥 ${r.title}`.slice(0, 60), `link_source:${r.id}`)]),
    [Markup.button.callback(T(ctx, "❌ Отмена", "❌ Скасувати"), "link_menu")]
  ]);
}
function destinationSelectKeyboard(ctx, sourceId) {
  return Markup.inlineKeyboard([
    ...rowsDestinations().map(r => [Markup.button.callback(`📤 ${r.title}`.slice(0, 60), `link_destination:${sourceId}:${r.id}`)]),
    [Markup.button.callback(T(ctx, "⬅️ Назад", "⬅️ Назад"), "link_create")],
    [Markup.button.callback(T(ctx, "❌ Отмена", "❌ Скасувати"), "link_menu")]
  ]);
}
function deleteKeyboard(ctx) {
  return Markup.inlineKeyboard([
    ...rowsLinks().map(r => [Markup.button.callback(`🗑 ${r.id}. ${r.source_title} → ${r.destination_title}`.slice(0,60), `link_delete_one:${r.id}`)]),
    [Markup.button.callback(T(ctx, "⬅️ Назад", "⬅️ Назад"), "link_menu")]
  ]);
}
function globalSettingsKeyboard(ctx) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${T(ctx,"🔗 Удалять ссылки","🔗 Видаляти посилання")}: ${getSetting("remove_links","0")==="1"?"🟢":"🔴"}`, "set_remove")],
    [Markup.button.callback(`⏱ ${getSetting("delay","0")} ${T(ctx,"сек.","с")}`, "set_delay")],
    [Markup.button.callback(T(ctx,"🔎 Белый фильтр","🔎 Білий фільтр"), "set_keywords"), Markup.button.callback(T(ctx,"🚫 Чёрный фильтр","🚫 Чорний фільтр"), "set_ban")],
    [Markup.button.callback(T(ctx,"✍️ Подпись","✍️ Підпис"), "set_signature"), Markup.button.callback(T(ctx,"🔄 Замены","🔄 Заміни"), "set_replace")],
    [Markup.button.callback(T(ctx,"🔄 Сбросить настройки","🔄 Скинути налаштування"), "set_reset")]
  ]);
}
function globalSettingsText(ctx) {
  return T(ctx,
    `⚙️ Настройки\n\n🔗 Удалять ссылки: ${getSetting("remove_links","0")==="1"?"🟢":"🔴"}\n⏱ Задержка: ${getSetting("delay","0")} сек.\n🔎 Белый фильтр: ${getSetting("keywords")||"нет"}\n🚫 Чёрный фильтр: ${getSetting("ban_words")||"нет"}\n✍️ Подпись: ${getSetting("signature")||"нет"}\n🔄 Замены: ${getSetting("replacements")||"нет"}`,
    `⚙️ Налаштування\n\n🔗 Видаляти посилання: ${getSetting("remove_links","0")==="1"?"🟢":"🔴"}\n⏱ Затримка: ${getSetting("delay","0")} с\n🔎 Білий фільтр: ${getSetting("keywords")||"немає"}\n🚫 Чорний фільтр: ${getSetting("ban_words")||"немає"}\n✍️ Підпис: ${getSetting("signature")||"немає"}\n🔄 Заміни: ${getSetting("replacements")||"немає"}`
  );
}

async function safeEdit(ctx, text, markup) {
  try { return await ctx.editMessageText(text, markup); }
  catch (error) {
    if (String(error?.message || error).includes("message is not modified")) return;
    throw error;
  }
}
async function answer(ctx) { try { await ctx.answerCbQuery(); } catch (_) {} }

bot.use(async (ctx, next) => {
  if (ctx.from && isAdmin(ctx.from.id)) return next();
  if (ctx.callbackQuery) { try { await ctx.answerCbQuery("Нет доступа"); } catch (_) {} }
});

bot.start(ctx => ctx.reply("🤖 Telegram Post Cloner\n\nВибери розділ.", mainKeyboard()));
bot.command("cancel", ctx => { inputState.delete(ctx.from.id); return ctx.reply(T(ctx,"❌ Отменено.","❌ Скасовано."), mainKeyboard()); });
bot.command("status", async ctx => {
  if (!client) return ctx.reply(`❌ Telegram не авторизован.\n${telegramError || "Используй /auth."}`);
  try { const me = await client.getMe(); return ctx.reply(`✅ Telegram авторизован.\nID: ${me.id}\nUsername: @${me.username || "—"}`, mainKeyboard()); }
  catch (e) { return ctx.reply(`❌ ${e.message || e}`); }
});
bot.command("auth", ctx => {
  const url = AUTH_URL ? `${AUTH_URL}/auth${AUTH_KEY ? `?key=${encodeURIComponent(AUTH_KEY)}` : ""}` : "/auth";
  return ctx.reply(`🔐 Авторизация Telegram\n\n${url}`);
});

bot.hears("📥 Джерела", ctx => ctx.reply(T(ctx,"📥 Источники\n\nВыбери действие:","📥 Джерела\n\nОберіть дію:"), Markup.inlineKeyboard([
  [Markup.button.callback(T(ctx,"➕ Добавить источник","➕ Додати джерело"), "source_add")],
  [Markup.button.callback(T(ctx,"🗑 Удалить источник","🗑 Видалити джерело"), "source_delete")],
  [Markup.button.callback(T(ctx,"📋 Список","📋 Список"), "source_list")]
])));
bot.hears("📤 Приймачі", ctx => ctx.reply(T(ctx,"📤 Приёмники\n\nВыбери действие:","📤 Приймачі\n\nОберіть дію:"), Markup.inlineKeyboard([
  [Markup.button.callback(T(ctx,"➕ Добавить приёмник","➕ Додати приймач"), "destination_add")],
  [Markup.button.callback(T(ctx,"🗑 Удалить приёмник","🗑 Видалити приймач"), "destination_delete")],
  [Markup.button.callback(T(ctx,"📋 Список","📋 Список"), "destination_list")]
])));
bot.hears("🔗 Зв’язки", ctx => ctx.reply(linkListText(ctx), linkMenu(ctx)));
bot.hears("⚙️ Налаштування", ctx => ctx.reply(globalSettingsText(ctx), globalSettingsKeyboard(ctx)));
bot.hears("📊 Статистика", ctx => {
  const c = table => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  return ctx.reply(`📊 Статистика\n\n📥 Джерел: ${c("sources")}\n📤 Приймачів: ${c("destinations")}\n🔗 Зв’язків: ${c("links")}\n📨 Скопійовано: ${c("copied")}\n❌ Помилок: ${db.prepare("SELECT COUNT(*) c FROM link_stats WHERE error IS NOT NULL").get().c}`);
});
bot.hears("❓ Допомога", ctx => ctx.reply("❓ Допомога\n\n1. Додай джерело.\n2. Додай приймач.\n3. Створи зв’язок кнопками.\n4. Відкрий зв’язок і налаштуй фільтри.\n5. Після авторизації Telegram пересилання працює автоматично.\n\n/auth — авторизація\n/status — стан Telegram\n/cancel — скасувати введення", mainKeyboard()));

bot.action("source_add", async ctx => { await answer(ctx); inputState.set(ctx.from.id, { type: "source_add" }); return ctx.reply(T(ctx,"📥 Пришли @username, ссылку или пересланное сообщение из канала.\n/cancel","📥 Надішліть @username, посилання або переслане повідомлення з каналу.\n/cancel")); });
bot.action("destination_add", async ctx => { await answer(ctx); inputState.set(ctx.from.id, { type: "destination_add" }); return ctx.reply(T(ctx,"📤 Пришли @username, ссылку или пересланное сообщение из канала.\n/cancel","📤 Надішліть @username, посилання або переслане повідомлення з каналу.\n/cancel")); });

function listEntities(ctx, type) {
  const rows = type === "source" ? rowsSources() : rowsDestinations();
  const title = type === "source" ? T(ctx,"📥 Источники","📥 Джерела") : T(ctx,"📤 Приёмники","📤 Приймачі");
  if (!rows.length) return `${title}\n\n${T(ctx,"Нет записей.","Немає записів.")}`;
  return `${title}\n\n${rows.map(r => `${r.id}. ${r.title} — ${r.username ? "@" + r.username : r.chat_id}`).join("\n")}`;
}
bot.action("source_list", async ctx => { await answer(ctx); return ctx.reply(listEntities(ctx,"source")); });
bot.action("destination_list", async ctx => { await answer(ctx); return ctx.reply(listEntities(ctx,"destination")); });
bot.action("source_delete", async ctx => { await answer(ctx); const rows=rowsSources(); return ctx.editMessageText(listEntities(ctx,"source"), Markup.inlineKeyboard([...rows.map(r=>[Markup.button.callback(`🗑 ${r.id}. ${r.title}`.slice(0,60),`source_delete_one:${r.id}`)]),[Markup.button.callback(T(ctx,"⬅️ Назад","⬅️ Назад"),"source_menu")]])); });
bot.action("destination_delete", async ctx => { await answer(ctx); const rows=rowsDestinations(); return ctx.editMessageText(listEntities(ctx,"destination"), Markup.inlineKeyboard([...rows.map(r=>[Markup.button.callback(`🗑 ${r.id}. ${r.title}`.slice(0,60),`destination_delete_one:${r.id}`)]),[Markup.button.callback(T(ctx,"⬅️ Назад","⬅️ Назад"),"destination_menu")]])); });
bot.action("source_menu", async ctx => { await answer(ctx); return safeEdit(ctx,T(ctx,"📥 Источники\n\nВыбери действие:","📥 Джерела\n\nОберіть дію:"),Markup.inlineKeyboard([[Markup.button.callback(T(ctx,"➕ Добавить источник","➕ Додати джерело"),"source_add")],[Markup.button.callback(T(ctx,"🗑 Удалить источник","🗑 Видалити джерело"),"source_delete")],[Markup.button.callback(T(ctx,"📋 Список","📋 Список"),"source_list")]])); });
bot.action("destination_menu", async ctx => { await answer(ctx); return safeEdit(ctx,T(ctx,"📤 Приёмники\n\nВыбери действие:","📤 Приймачі\n\nОберіть дію:"),Markup.inlineKeyboard([[Markup.button.callback(T(ctx,"➕ Добавить приёмник","➕ Додати приймач"),"destination_add")],[Markup.button.callback(T(ctx,"🗑 Удалить приёмник","🗑 Видалити приймач"),"destination_delete")],[Markup.button.callback(T(ctx,"📋 Список","📋 Список"),"destination_list")]])); });

async function resolveInput(ctx, value) {
  if (!client) throw new Error("Telegram не авторизован. Используй /auth.");
  value = String(value || "").trim();
  const origin = ctx.message?.forward_origin;
  if (origin?.type === "channel" && origin.chat?.id) value = origin.chat.id;
  if (/^https?:\/\//i.test(value)) value = value.replace(/^https?:\/\/t\.me\//i, "").split("/")[0];
  if (value.startsWith("@")) value = value.slice(1);
  const entity = await client.getEntity(value);
  const id = Number(entity.id?.value ?? entity.id);
  if (!id) throw new Error("Не удалось определить ID канала.");
  return { id, title: entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || String(id), username: entity.username || null };
}

bot.action("link_create", async ctx => { await answer(ctx); const s=rowsSources(),d=rowsDestinations(); if(!s.length||!d.length) return safeEdit(ctx,T(ctx,"🔗 Создание связки\n\nСначала добавь источник и приёмник.","🔗 Створення зв’язку\n\nСпочатку додайте джерело та приймач."),linkMenu(ctx)); return safeEdit(ctx,T(ctx,"🔗 Создание связки\n\n1️⃣ Выбери источник:","🔗 Створення зв’язку\n\n1️⃣ Оберіть джерело:"),sourceSelectKeyboard(ctx)); });
bot.action(/^link_source:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); return safeEdit(ctx,T(ctx,"🔗 Создание связки\n\n2️⃣ Выбери приёмник:","🔗 Створення зв’язку\n\n2️⃣ Оберіть приймач:"),destinationSelectKeyboard(ctx,id)); });
bot.action(/^link_destination:(\d+):(\d+)$/, async ctx => { await answer(ctx); const sourceId=Number(ctx.match[1]), destinationId=Number(ctx.match[2]); const exists=db.prepare("SELECT id FROM links WHERE source_id=? AND destination_id=?").get(sourceId,destinationId); if(exists) return safeEdit(ctx,T(ctx,"⚠️ Такая связка уже существует.","⚠️ Такий зв’язок уже існує."),linkMenu(ctx)); const info=db.prepare("INSERT INTO links(source_id,destination_id) VALUES(?,?)").run(sourceId,destinationId); resetLinkSettings(Number(info.lastInsertRowid)); return safeEdit(ctx,T(ctx,"✅ Связка создана.","✅ Зв’язок створено."),linkMenu(ctx)); });
bot.action("link_delete", async ctx => { await answer(ctx); return safeEdit(ctx,linkListText(ctx),deleteKeyboard(ctx)); });
bot.action(/^link_delete_one:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); db.prepare("DELETE FROM link_stats WHERE link_id=?").run(id); db.prepare("DELETE FROM link_settings WHERE link_id=?").run(id); db.prepare("DELETE FROM links WHERE id=?").run(id); return safeEdit(ctx,T(ctx,"🗑 Связка удалена.","🗑 Зв’язок видалено."),linkMenu(ctx)); });
bot.action("link_menu", async ctx => { await answer(ctx); return safeEdit(ctx,linkListText(ctx),linkMenu(ctx)); });
bot.action(/^link_open:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); return safeEdit(ctx,linkCard(ctx,id),linkSettingsKeyboard(ctx,id)); });
bot.action(/^link_toggle:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); setLinkSetting(id,"enabled",getLinkSetting(id,"enabled","1")==="1"?"0":"1"); return safeEdit(ctx,linkCard(ctx,id),linkSettingsKeyboard(ctx,id)); });
bot.action(/^link_remove:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); setLinkSetting(id,"remove_links",getLinkSetting(id,"remove_links",getSetting("remove_links","0"))==="1"?"0":"1"); return safeEdit(ctx,linkCard(ctx,id),linkSettingsKeyboard(ctx,id)); });

const linkInputAction = {
  delay: "Введите задержку в секундах от 0 до 3600.",
  keywords: "Введите ключевые слова через запятую.",
  ban: "Введите запрещённые слова через запятую.",
  signature: "Введите подпись.",
  replace: "Введите замены: старое -> новое, по одной на строку."
};
for (const [action, key] of [["link_delay","delay"],["link_keywords","keywords"],["link_ban","ban_words"],["link_signature","signature"],["link_replace","replacements"]]) {
  bot.action(new RegExp(`^${action}:(\\d+)$`), async ctx => { await answer(ctx); const id=Number(ctx.match[1]); inputState.set(ctx.from.id,{type:"link_setting",id,key}); const uk={delay:"Введіть затримку в секундах від 0 до 3600.",keywords:"Введіть ключові слова через кому.",ban_words:"Введіть заборонені слова через кому.",replacements:"Введіть заміни: старе -> нове, по одній на рядок."}[key]; return ctx.reply(language(ctx)==="uk"?uk:linkInputAction[action.replace("link_","")] || "Введите значение."); });
}
bot.action(/^link_stats:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); const r=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN created_at>=datetime('now','start of day') THEN 1 ELSE 0 END) today,SUM(error IS NOT NULL) errors,MAX(created_at) last FROM link_stats WHERE link_id=?").get(id)||{}; return safeEdit(ctx,T(ctx,`📊 Статистика связки #${id}\n\nСегодня: ${r.today||0}\nВсего: ${r.total||0}\nОшибок: ${r.errors||0}\nПоследняя: ${r.last||"нет"}`,`📊 Статистика зв’язку #${id}\n\nСьогодні: ${r.today||0}\nВсього: ${r.total||0}\nПомилок: ${r.errors||0}\nОстання: ${r.last||"немає"}`),Markup.inlineKeyboard([[Markup.button.callback(T(ctx,"⬅️ Назад","⬅️ Назад"),`link_open:${id}`)]])); });
bot.action(/^link_reset:(\d+)$/, async ctx => { await answer(ctx); const id=Number(ctx.match[1]); resetLinkSettings(id); return safeEdit(ctx,linkCard(ctx,id),linkSettingsKeyboard(ctx,id)); });

bot.action("set_remove", async ctx => { await answer(ctx); setSetting("remove_links",getSetting("remove_links","0")==="1"?"0":"1"); return safeEdit(ctx,globalSettingsText(ctx),globalSettingsKeyboard(ctx)); });
bot.action("set_reset", async ctx => { await answer(ctx); for(const [k,v] of Object.entries(DEFAULTS)) setSetting(k,v); return safeEdit(ctx,globalSettingsText(ctx),globalSettingsKeyboard(ctx)); });
for (const [action,key] of [["set_delay","delay"],["set_keywords","keywords"],["set_ban","ban_words"],["set_signature","signature"],["set_replace","replacements"]]) {
  bot.action(action, async ctx => { await answer(ctx); inputState.set(ctx.from.id,{type:"global_setting",key}); const messages={delay:"Введіть затримку в секундах від 0 до 3600.",keywords:"Введіть ключові слова через кому.",ban_words:"Введіть заборонені слова через кому.",signature:"Введіть підпис.",replacements:"Введіть заміни: старе -> нове, по одній на рядок."}; return ctx.reply(language(ctx)==="uk"?messages[key]:messages[key]); });
}

bot.on("text", async ctx => {
  const st=inputState.get(ctx.from.id);
  if (!st) return;
  const text=String(ctx.message.text||"").trim();
  if (!text || text.startsWith("/")) return;
  try {
    if (st.type === "source_add" || st.type === "destination_add") {
      const info=await resolveInput(ctx,text);
      const table=st.type === "source_add" ? "sources" : "destinations";
      db.prepare(`INSERT INTO ${table}(chat_id,title,username) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`).run(info.id,info.title,info.username);
      inputState.delete(ctx.from.id);
      return ctx.reply(`✅ ${info.title}\nID: ${info.id}`,mainKeyboard());
    }
    if (st.type === "link_setting") {
      if(st.key === "delay" && (!/^\d{1,4}$/.test(text) || Number(text)>3600)) return ctx.reply("❌ Введіть число від 0 до 3600.");
      setLinkSetting(st.id,st.key,text);
      inputState.delete(ctx.from.id);
      return ctx.reply(T(ctx,"✅ Настройка сохранена.","✅ Налаштування збережено."),linkSettingsKeyboard(ctx,st.id));
    }
    if (st.type === "global_setting") {
      if(st.key === "delay" && (!/^\d{1,4}$/.test(text) || Number(text)>3600)) return ctx.reply("❌ Введіть число від 0 до 3600.");
      setSetting(st.key,text);
      inputState.delete(ctx.from.id);
      return ctx.reply(T(ctx,"✅ Настройка сохранена.","✅ Налаштування збережено."),globalSettingsKeyboard(ctx));
    }
  } catch (error) {
    return ctx.reply(`❌ ${error?.message || error}\n\n/cancel`);
  }
});

bot.catch(error => console.error("BOT ERROR:", error?.stack || error));

const app=express();
app.use(express.urlencoded({extended:false}));
app.get("/",(req,res)=>res.status(200).send("Telegram Post Cloner is running."));
app.get("/health",(req,res)=>res.json({ok:true,telegram:!!client,loginInProgress,telegramStarting,telegramError:telegramError||null,sessionSource:readSession()?"file":getSetting("mtproto_session")?"db":MT_SESSION?"env":"none",uptime:process.uptime()}));
app.get("/auth",async(req,res)=>{if(AUTH_KEY&&req.query.key!==AUTH_KEY)return res.status(403).send("Forbidden");if(!client&&!loginInProgress)await beginLogin();res.send("Авторизація запущена. Введіть номер, код і пароль 2FA через POST /auth.");});
app.post("/auth",async(req,res)=>{if(AUTH_KEY&&req.body.key!==AUTH_KEY)return res.status(403).send("Forbidden");if(!client&&!loginInProgress)await beginLogin();const step=String(req.body.step||""),value=String(req.body.value||"").trim();if(!value||!["phone","code","password"].includes(step))return res.status(400).send("Невірний крок або порожнє значення.");if(!provideAuth(step,value))return res.status(409).send(`Telegram не очікує крок ${step}.`);res.send("OK");});
app.listen(PORT,()=>console.log(`HTTP server on ${PORT}`));

(async()=>{
  try {
    console.log(`Starting management bot. ADMIN_IDS=${[...ADMIN_IDS].join(",")}`);
    await bot.telegram.deleteWebhook({drop_pending_updates:false});
    await bot.launch({drop_pending_updates:false});
    console.log("Management bot started.");
    console.log("TELEGRAM: starting saved-session check...");
    await connectSavedSession();
    console.log("TELEGRAM: startup check finished.");
  } catch (error) {
    console.error("FATAL START ERROR:",error?.stack||error);
    process.exitCode=1;
  }
})();
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
