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

function readSessionFile(){try{if(!fs.existsSync(SESSION_PATH))return "";return fs.readFileSync(SESSION_PATH,"utf8").trim();}catch(e){console.error("SESSION FILE READ ERROR:",e?.message||e);return "";}}
function saveSession(session){const value=String(session||"").trim();if(!value)return false;setSetting("mtproto_session",value);try{fs.mkdirSync(path.dirname(SESSION_PATH),{recursive:true});const tmp=`${SESSION_PATH}.tmp`;fs.writeFileSync(tmp,value,"utf8");fs.renameSync(tmp,SESSION_PATH);console.log(`SESSION: saved to ${SESSION_PATH}`);return true;}catch(e){console.error("SESSION FILE SAVE ERROR:",e?.stack||e);return false;}}
function clearSavedSession(){clearSetting("mtproto_session");try{if(fs.existsSync(SESSION_PATH))fs.unlinkSync(SESSION_PATH);}catch(e){console.error("SESSION FILE DELETE ERROR:",e?.message||e);}}

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

async function setupHandlers(){
  if(!client)return;
  client.addEventHandler(async e=>{try{const m=e.message;if(m&&!m.groupedId)await processMessages([m]);}catch(err){console.error("NewMessage:",err);}},new events.NewMessage({}));
  client.addEventHandler(async e=>{try{await processMessages((e.messages||[]).sort((a,b)=>Number(a.id)-Number(b.id)));}catch(err){console.error("Album:",err);}},new events.Album({}));
  console.log("FORWARDER: event handlers registered.");
}

async function connectSavedSession(){
  if(telegramStarting||client){console.log(`TELEGRAM: connectSavedSession skipped (client=${!!client}, starting=${telegramStarting})`);return;}
  const fileSession=readSessionFile();
  const dbSession=getSetting("mtproto_session","");
  const saved=fileSession||dbSession||MT_SESSION;
  console.log(`TELEGRAM: session check file=${fileSession?"YES":"NO"} db=${dbSession?"YES":"NO"} env=${MT_SESSION?"YES":"NO"}`);
  if(!saved){telegramError="NO TELEGRAM SESSION. Use /auth.";console.error("TELEGRAM: NO SAVED SESSION — use /auth");return;}

  telegramStarting=true;telegramError="";let c=null;
  try{
    console.log("TELEGRAM: creating TelegramClient...");
    c=new TelegramClient(new StringSession(saved),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true});
    console.log("TELEGRAM: connecting...");
    await c.connect();
    console.log("TELEGRAM: connect() completed.");
    const authorized=await c.checkAuthorization();
    console.log(`TELEGRAM: checkAuthorization=${authorized}`);
    if(!authorized){await c.disconnect();clearSavedSession();telegramError="SAVED SESSION INVALID. Use /auth.";console.error("TELEGRAM: saved session is invalid — use /auth");return;}
    const me=await c.getMe();
    client=c;
    saveSession(c.session.save());
    console.log(`TELEGRAM: ACCOUNT RESTORED id=${me.id} username=@${me.username||"—"}`);
    await setupHandlers();
    console.log("TELEGRAM: READY — forwarding is active.");
  }catch(e){
    telegramError=e?.message||String(e);
    console.error("TELEGRAM: SESSION RESTORE ERROR:",e?.stack||e);
    if(c){try{await c.disconnect();}catch(_) {}}
    if(/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(String(e?.message||e)))clearSavedSession();
  }finally{telegramStarting=false;}
}

async function beginLogin(){
  if(client)return true;if(loginInProgress)return true;
  loginInProgress=true;telegramError="";telegramStarting=true;
  const c=new TelegramClient(new StringSession(""),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true});client=c;
  c.start({phoneNumber:async()=>waitAuth("phone"),password:async()=>waitAuth("password"),phoneCode:async()=>waitAuth("code"),onError:e=>console.error("Telegram auth:",e)}).then(async()=>{
    try{
      saveSession(c.session.save());
      const me=await c.getMe();
      await setupHandlers();
      console.log(`TELEGRAM: ACCOUNT AUTHORIZED id=${me.id} username=@${me.username||"—"}`);
      console.log("TELEGRAM: READY — forwarding is active.");
      telegramError="";
    }catch(e){telegramError=e?.message||String(e);console.error("TELEGRAM: POST-LOGIN ERROR:",e?.stack||e);if(client===c)client=null;try{await c.disconnect();}catch(_) {}}
  }).catch(e=>{telegramError=e?.message||String(e);console.error("Telegram authorization error:",e);if(client===c)client=null;failAuth(e);}).finally(()=>{loginInProgress=false;telegramStarting=false;});
  return true;
}

function keyboard(){return Markup.keyboard([["📥 Источники","📤 Приёмники"],["🔗 Связки","⚙️ Настройки"],["📊 Статистика","❓ Помощь"]]).resize().persistent();}
const bot=new Telegraf(BOT_TOKEN);
bot.use(async(ctx,next)=>{if(ctx.from&&isAdmin(ctx.from.id))return next();});
bot.start(ctx=>ctx.reply("🤖 Telegram Post Cloner\n\nВыбери раздел.",keyboard()));
bot.command("auth",async ctx=>{await beginLogin();const url=AUTH_URL?`${AUTH_URL}/auth${AUTH_KEY?`?key=${encodeURIComponent(AUTH_KEY)}`:""}`:"/auth";return ctx.reply(`🔐 Авторизація Telegram\n\n${url}`);});
bot.command("cancel",ctx=>{state.delete(ctx.from.id);return ctx.reply("❌ Скасовано.",keyboard());});
bot.command("status",async ctx=>{if(!client)return ctx.reply(`❌ Telegram не авторизований.\n\n${telegramError||"Використай /auth."}`);try{const me=await client.getMe();return ctx.reply(`✅ Telegram авторизований.\nID: ${me.id}\nUsername: @${me.username||"—"}`);}catch(e){return ctx.reply(`❌ Помилка: ${e.message||e}`);}});

appPlaceholder: null;

const app=express();
app.use(express.urlencoded({extended:false}));
app.get("/",(req,res)=>res.status(200).send("Telegram Post Cloner is running."));
app.get("/health",(req,res)=>res.json({ok:true,telegram:!!client&&!loginInProgress,loginInProgress,telegramStarting,telegramError:telegramError||null,sessionSource:readSessionFile()?"file":getSetting("mtproto_session","")?"db":MT_SESSION?"env":"none",sessionPath:SESSION_PATH,dbPath:DB_PATH,uptime:process.uptime()}));
app.get("/auth",async(req,res)=>{if(AUTH_KEY&&req.query.key!==AUTH_KEY)return res.status(403).send("Forbidden");if(client&&!loginInProgress)return res.send("Telegram уже авторизован.");await beginLogin();res.send("Авторизація запущена. Введи номер, код і пароль 2FA через форму авторизації.");});
app.post("/auth",async(req,res)=>{if(AUTH_KEY&&req.body.key!==AUTH_KEY)return res.status(403).send("Forbidden");await beginLogin();const step=String(req.body.step||"");const value=String(req.body.value||"").trim();if(!value)return res.status(400).send("Порожнє значення.");if(!["phone","code","password"].includes(step))return res.status(400).send("Невірний крок.");if(!provideAuth(step,value))return res.status(409).send(`Telegram зараз не очікує крок «${step}».`);res.send("Дані передані Telegram. Перевір наступний крок авторизації.");});

app.listen(PORT,()=>console.log(`HTTP server on ${PORT}`));

(async()=>{
  try{
    console.log(`Starting management bot. ADMIN_IDS=${[...ADMIN_IDS].join(",")||"NONE"}`);
    await bot.telegram.deleteWebhook({drop_pending_updates:false});
    await bot.launch({drop_pending_updates:false});
    console.log("Management bot started.");
    console.log("TELEGRAM: starting saved-session check...");
    await connectSavedSession();
    console.log("TELEGRAM: startup check finished.");
  }catch(e){console.error("FATAL BOT START ERROR:",e?.stack||e);process.exitCode=1;}
  process.once("SIGINT",()=>bot.stop("SIGINT"));process.once("SIGTERM",()=>bot.stop("SIGTERM"));
})();
