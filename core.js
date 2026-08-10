require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const events = require("telegram/events");
const { StringSession } = require("telegram/sessions");

const PERSISTENT_DIR = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
try { fs.mkdirSync(PERSISTENT_DIR, { recursive: true }); } catch (_) {}
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(PERSISTENT_DIR, "cloner.db");

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean).map(Number));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH;
const AUTH_KEY = process.env.AUTH_KEY || "";
const AUTH_URL = (process.env.AUTH_URL || "").replace(/\/$/, "");
const MT_SESSION = process.env.MT_SESSION || "";
const SESSION_PATH = process.env.MT_SESSION_FILE || path.join(PERSISTENT_DIR, "telegram.session");

if (!API_ID || !API_HASH || !BOT_TOKEN || !ADMIN_IDS.size) throw new Error("Заполни API_ID, API_HASH, BOT_TOKEN и ADMIN_IDS.");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER UNIQUE NOT NULL,title TEXT NOT NULL,username TEXT);
CREATE TABLE IF NOT EXISTS destinations(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER UNIQUE NOT NULL,title TEXT NOT NULL,username TEXT);
CREATE TABLE IF NOT EXISTS links(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id INTEGER NOT NULL,destination_id INTEGER NOT NULL,UNIQUE(source_id,destination_id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS copied(source_chat_id INTEGER NOT NULL,source_message_id INTEGER NOT NULL,destination_chat_id INTEGER NOT NULL,destination_message_id INTEGER,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(source_chat_id,source_message_id,destination_chat_id));
`);

const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key=?");
function getSetting(k,d=""){const r=getSettingStmt.get(k);return r?r.value:d;}
function setSetting(k,v){db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k,String(v));}
function clearSetting(k){db.prepare("DELETE FROM settings WHERE key=?").run(k);}
function isAdmin(id){return ADMIN_IDS.has(Number(id));}
function csv(v){return String(v||"").split(",").map(x=>x.trim()).filter(Boolean);}
function normalize(v){return String(v||"").trim().replace(/^https?:\/\/(?:www\.)?t\.me\//i,"").replace(/^@/i,"").replace(/\/$/,"");}

function readSessionFile(){try{if(!fs.existsSync(SESSION_PATH))return "";return fs.readFileSync(SESSION_PATH,"utf8").trim();}catch(e){console.error("Session file read error:",e?.message||e);return "";}}
function saveSession(session){const value=String(session||"").trim();if(!value)return false;setSetting("mtproto_session",value);try{fs.mkdirSync(path.dirname(SESSION_PATH),{recursive:true});const tmp=`${SESSION_PATH}.tmp`;fs.writeFileSync(tmp,value,"utf8");fs.renameSync(tmp,SESSION_PATH);return true;}catch(e){console.error("Session file save error:",e?.message||e);return false;}}
function clearSavedSession(){clearSetting("mtproto_session");try{if(fs.existsSync(SESSION_PATH))fs.unlinkSync(SESSION_PATH);}catch(e){console.error("Session file delete error:",e?.message||e);}}

function transformText(text){
  text=text||"";
  if(csv(getSetting("ban_words")).some(w=>text.toLowerCase().includes(w.toLowerCase())))return null;
  const keys=csv(getSetting("keywords"));
  if(keys.length&&!keys.some(w=>text.toLowerCase().includes(w.toLowerCase())))return null;
  if(getSetting("remove_links","0")==="1")text=text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi,"");
  for(const line of getSetting("replacements","").split(/\r?\n/)){if(!line.includes("->"))continue;const a=line.indexOf("->"),old=line.slice(0,a).trim(),neu=line.slice(a+2).trim();if(old)text=text.split(old).join(neu);}
  const sig=getSetting("signature","");
  if(sig)text=text.trim()?`${text.trim()}\n\n${sig}`:sig;
  return text.trim();
}

const sources=()=>db.prepare("SELECT id,chat_id,title,username FROM sources ORDER BY id").all();
const destinations=()=>db.prepare("SELECT id,chat_id,title,username FROM destinations ORDER BY id").all();
const links=()=>db.prepare(`SELECT l.id,s.id source_id,s.title source_title,d.id destination_id,d.title destination_title FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id ORDER BY l.id`).all();
const destFor=db.prepare(`SELECT d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);
const copied=db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?");
const mark=db.prepare(`INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id) VALUES(?,?,?,?)`);

let client=null;let loginInProgress=false;let telegramStarting=false;let telegramError="";
const auth={phone:null,code:null,password:null};const state=new Map();const locks=new Map();
function waitAuth(field){return new Promise((resolve,reject)=>{auth[field]={resolve,reject};});}
function provideAuth(field,value){const p=auth[field];if(!p||typeof p.resolve!=="function")return false;auth[field]=null;p.resolve(value);return true;}
function failAuth(err){for(const field of ["phone","code","password"]){const p=auth[field];if(p?.reject)p.reject(err);auth[field]=null;}}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

function authPage(message="",status="",key="",step="phone"){
  const selected=step==="code"?"code":step==="password"?"password":"phone";
  return `<!doctype html><html lang="uk"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Telegram авторизація</title><style>body{font-family:Arial,sans-serif;max-width:560px;margin:30px auto;padding:20px;background:#f5f5f5;color:#222}form{background:#fff;padding:24px;border-radius:16px;box-shadow:0 2px 14px #0001}input,button,select{width:100%;box-sizing:border-box;padding:14px;margin:8px 0;border-radius:10px;border:1px solid #ccc;font-size:16px}button{background:#6d3df5;color:#fff;border:0;font-weight:700}small{color:#666}.msg{padding:12px;background:#eef6ff;border-radius:10px;margin-bottom:12px}.ok{background:#eaf8ed}.err{background:#fff0f0}</style></head><body><h2>Telegram авторизація</h2>${message?`<div class="msg">${esc(message)}</div>`:""}${status?`<div class="msg ${status==='OK'?"ok":status==='ERROR'?"err":""}">${esc(status)}</div>`:""}<form method="post" action="/auth"><input type="hidden" name="key" value="${esc(key)}"><label>Крок</label><select name="step"><option value="phone" ${selected==="phone"?"selected":""}>1. Номер телефону</option><option value="code" ${selected==="code"?"selected":""}>2. Код Telegram</option><option value="password" ${selected==="password"?"selected":""}>3. Пароль 2FA</option></select><input name="value" autocomplete="off" placeholder="Введіть значення" required><button>Надіслати</button></form><p><small>Ця сторінка потрібна лише для першого входу. Після успішної авторизації сесія збережеться на сервері.</small></p></body></html>`;
}

async function resolve(value){const v=normalize(value);if(!v)throw new Error("Пустая ссылка/username.");try{return await client.getEntity(v);}catch(e){throw new Error("Не удалось найти Telegram-чат. Проверь username/ссылку и доступ аккаунта.");}}
async function info(entity){const id=Number(entity.id?.value??entity.id);const title=entity.title||[entity.firstName,entity.lastName].filter(Boolean).join(" ")||String(id);return{id,title,username:entity.username||null};}
async function add(value,table){if(!client)throw new Error("Telegram ещё не авторизован. Открой /auth.");const x=await info(await resolve(value));const sql=table==="sources"?`INSERT INTO sources(chat_id,title,username) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`:`INSERT INTO destinations(chat_id,title,username) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`;db.prepare(sql).run(x.id,x.title,x.username);return x;}
function forwardedChatFromMessage(message){const origin=message?.forward_origin;if(origin?.type==="channel"&&origin.chat)return origin.chat;if(origin?.type==="chat"&&origin.sender_chat)return origin.sender_chat;if(message?.forward_from_chat)return message.forward_from_chat;return null;}
async function addForwardedChat(message,table){if(!client)throw new Error("Telegram ещё не авторизован. Открой /auth.");const chat=forwardedChatFromMessage(message);if(!chat)throw new Error("Не удалось определить источник пересланного сообщения. Перешли сообщение именно из канала/группы.");const id=Number(chat.id);if(!id)throw new Error("Не удалось определить ID чата.");let title=chat.title||chat.username||String(id);let username=chat.username||null;try{const entity=await client.getEntity(id);title=entity.title||title;username=entity.username||username||null;}catch(_){}const sql=table==="sources"?`INSERT INTO sources(chat_id,title,username) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`:`INSERT INTO destinations(chat_id,title,username) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`;db.prepare(sql).run(id,title,username);return{id,title,username};}

async function copyOne(message,destination){const text=transformText(message.message||"");if(text===null)return null;if(message.media)return await client.sendFile(destination,{file:message.media,caption:text||undefined,forceDocument:false});if(!text)return null;return await client.sendMessage(destination,{message:text,linkPreview:false});}
async function copyAlbum(messages,destination){const items=[];for(const m of messages){const text=transformText(m.message||"");if(text===null)return null;if(m.media)items.push({file:m.media,caption:text||undefined});}if(!items.length)return null;return await client.sendFile(destination,items);}
async function enqueue(chatId,task){const previous=locks.get(chatId)||Promise.resolve();let release;const current=new Promise(r=>release=r);locks.set(chatId,current);await previous;try{return await task();}finally{release();if(locks.get(chatId)===current)locks.delete(chatId);}}
async function processMessages(messages){if(!messages?.length||!client)return;const sourceChatId=Number(messages[0].chatId?.value??messages[0].chatId);if(!sourceChatId||!db.prepare("SELECT 1 FROM sources WHERE chat_id=?").get(sourceChatId))return;for(const row of destFor.all(sourceChatId)){const destinationChatId=row.chat_id;if(messages.every(m=>!!copied.get(sourceChatId,Number(m.id),destinationChatId)))continue;await enqueue(destinationChatId,async()=>{const delay=Math.max(0,Math.min(3600,Number(getSetting("delay","0"))||0));if(delay)await new Promise(r=>setTimeout(r,delay*1000));try{const destination=await client.getEntity(destinationChatId);const sent=messages.length>1?await copyAlbum(messages,destination):await copyOne(messages[0],destination);if(!sent)return;const arr=Array.isArray(sent)?sent:[sent];messages.forEach((m,i)=>{if(arr[i])mark.run(sourceChatId,Number(m.id),destinationChatId,Number(arr[i].id));});console.log(`COPIED ${sourceChatId}:${messages.map(m=>m.id).join(",")} -> ${destinationChatId}`);}catch(e){console.error("Copy error:",e?.message||e);}});}}

function setupHandlers(){if(!client)return;client.addEventHandler(async e=>{try{const m=e.message;if(m&&!m.groupedId)await processMessages([m]);}catch(err){console.error("NewMessage:",err);}},new events.NewMessage({}));client.addEventHandler(async e=>{try{await processMessages((e.messages||[]).sort((a,b)=>Number(a.id)-Number(b.id)));}catch(err){console.error("Album:",err);}},new events.Album({}));}

async function connectSavedSession(){
  if(telegramStarting||client)return;
  const saved=readSessionFile()||getSetting("mtproto_session","")||MT_SESSION;
  if(!saved)return;
  telegramStarting=true;telegramError="";let c=null;
  try{c=new TelegramClient(new StringSession(saved),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true});await c.connect();if(!(await c.checkAuthorization())){await c.disconnect();clearSavedSession();telegramError="Сохранённая Telegram-сессия недействительна. Требуется повторная авторизация.";return;}const me=await c.getMe();client=c;saveSession(c.session.save());try{setupHandlers();}catch(e){console.error("Handler setup error after restore:",e);}console.log(`Telegram account restored: ${me.id} @${me.username||""}`);}catch(e){telegramError=e?.message||String(e);console.error("Session restore error:",e);if(c){try{await c.disconnect();}catch(_) {}}if(/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(String(e?.message||e)))clearSavedSession();}finally{telegramStarting=false;}
}

async function beginLogin(){if(client)return true;if(loginInProgress)return true;loginInProgress=true;telegramError="";telegramStarting=true;const c=new TelegramClient(new StringSession(""),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true});client=c;c.start({phoneNumber:async()=>waitAuth("phone"),password:async()=>waitAuth("password"),phoneCode:async()=>waitAuth("code"),onError:e=>console.error("Telegram auth:",e)}).then(async()=>{try{saveSession(c.session.save());const me=await c.getMe();try{setupHandlers();}catch(e){console.error("Handler setup error after login:",e);}console.log(`Telegram account authorized: ${me.id} @${me.username||""}`);telegramError="";}catch(e){telegramError=e?.message||String(e);console.error("Post-login initialization error:",e);if(client===c)client=null;try{await c.disconnect();}catch(_) {}}}).catch(e=>{telegramError=e?.message||String(e);console.error("Telegram authorization error:",e);if(client===c)client=null;failAuth(e);}).finally(()=>{loginInProgress=false;telegramStarting=false;});return true;}

function keyboard(){return Markup.keyboard([["📥 Источники","📤 Приёмники"],["🔗 Связки","⚙️ Настройки"],["📊 Статистика","❓ Помощь"]]).resize().persistent();}
function linksKeyboard(){return Markup.inlineKeyboard([[Markup.button.callback("➕ Создать связку","link_create")],[Markup.button.callback("🗑 Удалить связку","link_delete_menu")],[Markup.button.callback("🔄 Обновить","link_menu")]]);}
function sourceSelectKeyboard(){const rows=sources().map(r=>[Markup.button.callback(`📥 ${String(r.title).slice(0,45)}`,`link_src_${r.id}`)]);rows.push([Markup.button.callback("❌ Отмена","link_cancel")]);return Markup.inlineKeyboard(rows);}
function destinationSelectKeyboard(){const rows=destinations().map(r=>[Markup.button.callback(`📤 ${String(r.title).slice(0,45)}`,`link_dst_${r.id}`)]);rows.push([Markup.button.callback("❌ Отмена","link_cancel")]);return Markup.inlineKeyboard(rows);}
function linkListText(){let t="🔗 Связки\n\n";const ls=links();if(!ls.length)t+="Немає зв'язків.\n";else for(const r of ls)t+=`${r.id}. ${r.source_title} → ${r.destination_title}\n`;return t;}

const bot=new Telegraf(BOT_TOKEN);
bot.use(async(ctx,next)=>{if(ctx.from&&isAdmin(ctx.from.id))return next();});
bot.start(ctx=>ctx.reply("🤖 Telegram Post Cloner\n\nВыбери раздел.",keyboard()));
bot.command("auth",async ctx=>{
  if(client&&!loginInProgress)return ctx.reply("✅ Telegram уже авторизован.");
  if(!AUTH_URL)return ctx.reply("🔐 Авторизация Telegram\n\nСначала укажи в настройках Hostinger/Render переменную AUTH_URL — полный адрес сервиса, например https://your-service.onrender.com");
  await beginLogin();
  const url=`${AUTH_URL}/auth${AUTH_KEY?`?key=${encodeURIComponent(AUTH_KEY)}`:""}`;
  return ctx.reply("🔐 Авторизация Telegram\n\nНажми кнопку ниже. Откроется защищённая страница авторизации.\n\n1️⃣ Номер телефона\n2️⃣ Код из Telegram\n3️⃣ Пароль 2FA (если включён)",Markup.inlineKeyboard([[Markup.button.url("🔐 Авторизовать Telegram",url)]]));
});
bot.command("cancel",ctx=>{state.delete(ctx.from.id);return ctx.reply("❌ Отменено.",keyboard());});
bot.command("id",ctx=>ctx.reply(`Ваш ID: ${ctx.from.id}`));
bot.command("status",async ctx=>{if(!client)return ctx.reply("❌ Telegram не авторизован.");try{const me=await client.getMe();saveSession(client.session.save());return ctx.reply(`✅ Telegram авторизован.\nID: ${me.id}\nUsername: @${me.username||"—"}`);}catch(e){return ctx.reply(`❌ Ошибка: ${e.message||e}`);}});
bot.command("session",ctx=>{const session=client?.session?.save?.()||readSessionFile()||getSetting("mtproto_session","");if(!session)return ctx.reply("❌ Telegram не авторизован и сохранённая Session отсутствует.");return ctx.reply(`🔐 MT_SESSION\n\n${session}\n\n⚠️ Секретная строка. Не отправляй её другим людям и после копирования удали это сообщение.`,{protect_content:true});});
bot.hears("📥 Источники",ctx=>{let t="📥 Источники\n\n";for(const r of sources())t+=`${r.id}. ${r.title} — ${r.username||r.chat_id}\n`;if(!sources().length)t+="Нет источников.\n";state.set(ctx.from.id,"source");return ctx.reply(t+"\nМожешь отправить @username или ссылку.\nИли просто ПЕРЕШЛИ сюда любое сообщение из нужного канала.\n/cancel");});
bot.hears("📤 Приёмники",ctx=>{let t="📤 Приёмники\n\n";for(const r of destinations())t+=`${r.id}. ${r.title} — ${r.username||r.chat_id}\n`;if(!destinations().length)t+="Нет приёмников.\n";state.set(ctx.from.id,"destination");return ctx.reply(t+"\nМожешь отправить @username или ссылку.\nИли просто ПЕРЕШЛИ сюда любое сообщение из нужного канала.\n/cancel");});

bot.hears("🔗 Связки",async ctx=>{state.delete(ctx.from.id);return ctx.reply(linkListText()+"\nВыбери действие:",linksKeyboard());});
bot.action("link_menu",async ctx=>{await ctx.answerCbQuery();return ctx.editMessageText(linkListText()+"\nВыбери действие:",linksKeyboard());});
bot.action("link_create",async ctx=>{await ctx.answerCbQuery();if(!sources().length)return ctx.reply("❌ Сначала добавь хотя бы один источник.",keyboard());if(!destinations().length)return ctx.reply("❌ Сначала добавь хотя бы один приёмник.",keyboard());state.set(ctx.from.id,{type:"link",step:"source"});return ctx.reply("🔗 Создание связки\n\n1️⃣ Выбери источник:",sourceSelectKeyboard());});
bot.action(/^link_src_(\d+)$/,async ctx=>{await ctx.answerCbQuery();const sourceId=Number(ctx.match[1]);if(!db.prepare("SELECT 1 FROM sources WHERE id=?").get(sourceId))return ctx.reply("❌ Источник не найден.");state.set(ctx.from.id,{type:"link",step:"destination",sourceId});return ctx.reply("🔗 Создание связки\n\n2️⃣ Выбери приёмник:",destinationSelectKeyboard());});
bot.action(/^link_dst_(\d+)$/,async ctx=>{await ctx.answerCbQuery();const st=state.get(ctx.from.id);if(!st||st.type!=="link"||st.step!=="destination")return ctx.reply("❌ Сессия создания связки устарела. Нажми «🔗 Связки» ещё раз.",keyboard());const destinationId=Number(ctx.match[1]);if(!db.prepare("SELECT 1 FROM destinations WHERE id=?").get(destinationId))return ctx.reply("❌ Приёмник не найден.");db.prepare("INSERT OR IGNORE INTO links(source_id,destination_id) VALUES(?,?)").run(st.sourceId,destinationId);state.delete(ctx.from.id);return ctx.reply("✅ Связка создана!",keyboard());});
bot.action("link_delete_menu",async ctx=>{await ctx.answerCbQuery();const ls=links();if(!ls.length)return ctx.reply("❌ Нет связок для удаления.");const rows=ls.map(r=>[Markup.button.callback(`🗑 ${r.source_title} → ${r.destination_title}`.slice(0,60),`link_del_${r.id}`)]);rows.push([Markup.button.callback("⬅️ Назад","link_menu")]);return ctx.reply("🗑 Выбери связку для удаления:",Markup.inlineKeyboard(rows));});
bot.action(/^link_del_(\d+)$/,async ctx=>{await ctx.answerCbQuery("Удалено");const id=Number(ctx.match[1]);db.prepare("DELETE FROM links WHERE id=?").run(id);return ctx.reply(`✅ Связка ${id} удалена.`,keyboard());});
bot.action("link_cancel",async ctx=>{await ctx.answerCbQuery();state.delete(ctx.from.id);return ctx.reply("❌ Создание связки отменено.",keyboard());});

bot.hears("⚙️ Настройки",ctx=>ctx.reply(`⚙️ Настройки\nУдалять ссылки: ${getSetting("remove_links","0")==="1"?"🟢":"🔴"}\nЗадержка: ${getSetting("delay","0")} сек.\nБелый фильтр: ${getSetting("keywords","нет")}\nЧёрный фильтр: ${getSetting("ban_words","нет")}\nПодпись: ${getSetting("signature","нет")}\nЗамены: ${getSetting("replacements","нет")}\n\n/links_on\n/links_off\n/delay 5\n/delay_clear\n/signature Текст\n/signature_clear\n/keywords слово1, слово2\n/keywords_clear\n/ban_words слово1, слово2\n/ban_words_clear\n/replace старое -> новое\n/replace_clear`));
bot.command("links_on",ctx=>{setSetting("remove_links","1");return ctx.reply("✅ Включено.");});
bot.command("links_off",ctx=>{setSetting("remove_links","0");return ctx.reply("✅ Отключено.");});
bot.command("delay",ctx=>{const n=Number((ctx.message.text||"").split(/\s+/)[1]);if(!Number.isFinite(n))return ctx.reply("Формат: /delay 5");setSetting("delay",Math.max(0,Math.min(3600,Math.floor(n))));return ctx.reply("✅ Задержка сохранена.");});
bot.command("delay_clear",ctx=>{clearSetting("delay");return ctx.reply("✅ Задержка отключена.");});
bot.command("signature",ctx=>{const v=(ctx.message.text||"").split(" ").slice(1).join(" ").trim();if(!v)return ctx.reply("Формат: /signature Текст");setSetting("signature",v);return ctx.reply("✅ Подпись сохранена.");});
bot.command("signature_clear",ctx=>{clearSetting("signature");return ctx.reply("✅ Подпись отключена.");});
bot.command("keywords",ctx=>{setSetting("keywords",(ctx.message.text||"").split(" ").slice(1).join(" ").trim());return ctx.reply("✅ Фильтр сохранён.");});
bot.command("keywords_clear",ctx=>{clearSetting("keywords");return ctx.reply("✅ Фильтр очищен.");});
bot.command("ban_words",ctx=>{setSetting("ban_words",(ctx.message.text||"").split(" ").slice(1).join(" ").trim());return ctx.reply("✅ Чёрный фильтр сохранён.");});
bot.command("ban_words_clear",ctx=>{clearSetting("ban_words");return ctx.reply("✅ Чёрный фильтр очищен.");});
bot.command("replace",ctx=>{const v=(ctx.message.text||"").split(" ").slice(1).join(" ").trim();if(!v.includes("->"))return ctx.reply("Формат: /replace старое -> новое");const old=getSetting("replacements","");setSetting("replacements",old?old+"\n"+v:v);return ctx.reply("✅ Замена добавлена.");});
bot.command("replace_clear",ctx=>{clearSetting("replacements");return ctx.reply("✅ Замены очищены.");});
bot.hears("📊 Статистика",ctx=>{const c=t=>db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;return ctx.reply(`📊 Статистика\n\n📥 Источников: ${c("sources")}\n📤 Приёмников: ${c("destinations")}\n🔗 Связок: ${c("links")}\n📨 Скопировано: ${c("copied")}`);});
bot.hears("❓ Помощь",ctx=>ctx.reply("❓ Добавь источник, приёмник и связку. После этого новые посты копируются автоматически.\n\n/auth — авторизация Telegram\n/status — статус Telegram\n/session — получить MT_SESSION для Hostinger"));

bot.on("message",async(ctx,next)=>{const s=state.get(ctx.from.id);if(s!=="source"&&s!=="destination")return next();const chat=forwardedChatFromMessage(ctx.message);if(!chat)return next();try{const x=await addForwardedChat(ctx.message,s==="source"?"sources":"destinations");state.delete(ctx.from.id);const label=s==="source"?"Источник":"Приёмник";return ctx.reply(`✅ ${label} добавлен.\n\n📌 ${x.title}\n🆔 ${x.id}${x.username?`\n👤 @${x.username}`:""}`,keyboard());}catch(e){return ctx.reply(`❌ ${e.message||e}`);}});
bot.on("text",async ctx=>{const s=state.get(ctx.from.id),v=(ctx.message.text||"").trim();if(!s||!v||v.startsWith("/"))return;try{if(s==="source"){const x=await add(v,"sources");state.delete(ctx.from.id);return ctx.reply(`✅ Источник добавлен.\n${x.title}\nID: ${x.id}`,keyboard());}if(s==="destination"){const x=await add(v,"destinations");state.delete(ctx.from.id);return ctx.reply(`✅ Приёмник добавлен.\n${x.title}\nID: ${x.id}`,keyboard());}}catch(e){return ctx.reply(`❌ ${e.message||e}`);}});
bot.catch(e=>console.error("Bot error:",e));

const app=express();app.use(express.urlencoded({extended:false}));
app.get("/",(req,res)=>res.status(200).send("Telegram Post Cloner is running."));
app.get("/health",(req,res)=>res.json({ok:true,telegram:!!client&&!loginInProgress,loginInProgress,telegramStarting,telegramError:telegramError||null,sessionSource:readSessionFile()?"file":getSetting("mtproto_session","")?"db":MT_SESSION?"env":"none",sessionPath:SESSION_PATH,dbPath:DB_PATH,uptime:process.uptime()}));
app.get("/auth",async(req,res)=>{if(AUTH_KEY&&req.query.key!==AUTH_KEY)return res.status(403).send("Forbidden");if(client&&!loginInProgress)return res.send(authPage("Telegram уже авторизован.","OK",AUTH_KEY));await beginLogin();const step=auth.phone?"code":auth.password?"password":"phone";res.send(authPage("Введи номер телефона, затем код из Telegram. Если включён 2FA — после кода введи пароль.",telegramError?"ERROR":"Авторизация готова",AUTH_KEY,step));});
app.post("/auth",async(req,res)=>{if(AUTH_KEY&&req.body.key!==AUTH_KEY)return res.status(403).send("Forbidden");if(client&&!loginInProgress)return res.send(authPage("Telegram уже авторизован.","OK",AUTH_KEY));await beginLogin();const step=String(req.body.step||"");const value=String(req.body.value||"").trim();if(!value)return res.send(authPage("Пустое значение.","ERROR",AUTH_KEY,step));if(!["phone","code","password"].includes(step))return res.send(authPage("Неверный шаг.","ERROR",AUTH_KEY));if(!provideAuth(step,value))return res.send(authPage(`Telegram сейчас не ожидает шаг «${step}». Сначала введи предыдущий шаг.`,"ERROR",AUTH_KEY,step));const next=step==="phone"?"code":step==="code"?"password":"phone";res.send(authPage(step==="phone"?"Код отправлен в Telegram.":step==="code"?"Код передан. Если включена 2FA, введи пароль.":"Пароль передан. Жди завершения авторизации.","OK",AUTH_KEY,next));});

app.listen(PORT,()=>console.log(`HTTP server on ${PORT}`));
(async()=>{try{console.log(`Starting management bot. ADMIN_IDS=${[...ADMIN_IDS].join(",")||"NONE"}`);await bot.telegram.deleteWebhook({drop_pending_updates:false});await bot.launch({drop_pending_updates:false});console.log("Management bot started.");await connectSavedSession();}catch(e){console.error("FATAL BOT START ERROR:",e?.stack||e);process.exitCode=1;}process.once("SIGINT",()=>bot.stop("SIGINT"));process.once("SIGTERM",()=>bot.stop("SIGTERM"));})();
