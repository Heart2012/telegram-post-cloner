require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const { Telegraf, Markup } = require("telegraf");
const { TelegramClient, events } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "")
  .split(",").map(x => x.trim()).filter(Boolean).map(Number));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || "cloner.db";

if (!API_ID || !API_HASH || !BOT_TOKEN || !ADMIN_IDS.size) {
  throw new Error("Заполни API_ID, API_HASH, BOT_TOKEN и ADMIN_IDS.");
}

const db = new Database(DB_PATH);
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
CREATE TABLE IF NOT EXISTS settings(
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS copied(
 source_chat_id INTEGER NOT NULL,
 source_message_id INTEGER NOT NULL,
 destination_chat_id INTEGER NOT NULL,
 destination_message_id INTEGER,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_chat_id,source_message_id,destination_chat_id)
);
`);

const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key=?");
function getSetting(k, d=""){ const r=getSettingStmt.get(k); return r ? r.value : d; }
function setSetting(k,v){ db.prepare(`
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k,String(v)); }
function clearSetting(k){ db.prepare("DELETE FROM settings WHERE key=?").run(k); }
function isAdmin(id){ return ADMIN_IDS.has(Number(id)); }
function csv(v){ return String(v||"").split(",").map(x=>x.trim()).filter(Boolean); }
function normalize(v){ return String(v||"").trim().replace(/^https?:\/\/(?:www\.)?t\.me\//i,"").replace(/\/$/,""); }

function transformText(text){
  text=text||"";
  if(csv(getSetting("ban_words")).some(w=>text.toLowerCase().includes(w.toLowerCase()))) return null;
  const keys=csv(getSetting("keywords"));
  if(keys.length && !keys.some(w=>text.toLowerCase().includes(w.toLowerCase()))) return null;
  if(getSetting("remove_links","0")==="1") text=text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi,"");
  for(const line of getSetting("replacements","").split(/\r?\n/)){
    if(!line.includes("->")) continue;
    const a=line.indexOf("->");
    const old=line.slice(0,a).trim(), neu=line.slice(a+2).trim();
    if(old) text=text.split(old).join(neu);
  }
  const sig=getSetting("signature","");
  if(sig) text=text.trim()?`${text.trim()}\n\n${sig}`:sig;
  return text.trim();
}

const sources=()=>db.prepare("SELECT id,chat_id,title,username FROM sources ORDER BY id").all();
const destinations=()=>db.prepare("SELECT id,chat_id,title,username FROM destinations ORDER BY id").all();
const links=()=>db.prepare(`
SELECT l.id,s.id source_id,s.title source_title,d.id destination_id,d.title destination_title
FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id
ORDER BY l.id`).all();

const destFor= db.prepare(`
SELECT d.chat_id FROM links l JOIN sources s ON s.id=l.source_id
JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);
const copied= db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?");
const mark= db.prepare(`INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id) VALUES(?,?,?,?)`);

let client;
const state=new Map();
const locks=new Map();

async function resolve(value){
  const v=normalize(value);
  if(!v) throw new Error("Пустая ссылка/username.");
  try{return await client.getEntity(v);}
  catch(e){throw new Error("Не удалось найти Telegram-чат. Проверь username/ссылку и доступ аккаунта.");}
}

async function info(entity){
  const id=Number(entity.id?.value ?? entity.id);
  const title=entity.title || [entity.firstName,entity.lastName].filter(Boolean).join(" ") || String(id);
  return {id,title,username:entity.username||null};
}

async function add(value, table){
  const x=await info(await resolve(value));
  const sql=table==="sources"
    ? `INSERT INTO sources(chat_id,title,username) VALUES(?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`
    : `INSERT INTO destinations(chat_id,title,username) VALUES(?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,username=excluded.username`;
  db.prepare(sql).run(x.id,x.title,x.username);
  return x;
}

async function copyOne(message,destination){
  const text=transformText(message.message||"");
  if(text===null) return null;
  if(message.media) return await client.sendFile(destination,{file:message.media,caption:text||undefined,forceDocument:false});
  if(!text) return null;
  return await client.sendMessage(destination,{message:text,linkPreview:false});
}

async function copyAlbum(messages,destination){
  const items=[];
  for(const m of messages){
    const text=transformText(m.message||"");
    if(text===null) return null;
    if(m.media) items.push({file:m.media,caption:text||undefined});
  }
  if(!items.length) return null;
  return await client.sendFile(destination,items);
}

async function enqueue(chatId,task){
  const previous=locks.get(chatId)||Promise.resolve();
  let release; const current=new Promise(r=>release=r); locks.set(chatId,current);
  await previous;
  try{return await task();} finally{release(); if(locks.get(chatId)===current) locks.delete(chatId);}
}

async function processMessages(messages){
  if(!messages?.length) return;
  const sourceChatId=Number(messages[0].chatId?.value ?? messages[0].chatId);
  if(!sourceChatId || !db.prepare("SELECT 1 FROM sources WHERE chat_id=?").get(sourceChatId)) return;
  const ds=destFor.all(sourceChatId);
  for(const row of ds){
    const destinationChatId=row.chat_id;
    if(messages.every(m=>!!copied.get(sourceChatId,Number(m.id),destinationChatId))) continue;
    await enqueue(destinationChatId,async()=>{
      const delay=Math.max(0,Math.min(3600,Number(getSetting("delay","0"))||0));
      if(delay) await new Promise(r=>setTimeout(r,delay*1000));
      try{
        const destination=await client.getEntity(destinationChatId);
        let sent=messages.length>1?await copyAlbum(messages,destination):await copyOne(messages[0],destination);
        if(!sent) return;
        const arr=Array.isArray(sent)?sent:[sent];
        messages.forEach((m,i)=>{
          if(arr[i]) mark.run(sourceChatId,Number(m.id),destinationChatId,Number(arr[i].id));
        });
        console.log(`COPIED ${sourceChatId}:${messages.map(m=>m.id).join(",")} -> ${destinationChatId}`);
      }catch(e){console.error("Copy error:",e?.message||e);}
    });
  }
}

function keyboard(){return Markup.keyboard([
  ["📥 Источники","📤 Приёмники"],
  ["🔗 Связки","⚙️ Настройки"],
  ["📊 Статистика","❓ Помощь"]
]).resize().persistent();}

const bot=new Telegraf(BOT_TOKEN);
bot.use(async(ctx,next)=>{if(ctx.from&&isAdmin(ctx.from.id)) return next();});

bot.start(ctx=>ctx.reply("🤖 Telegram Post Cloner\n\nВыбери раздел.",keyboard()));
bot.command("cancel",ctx=>{state.delete(ctx.from.id);return ctx.reply("❌ Отменено.",keyboard());});
bot.command("id",ctx=>ctx.reply(`Ваш ID: ${ctx.from.id}`));

bot.hears("📥 Источники",ctx=>{
  let t="📥 Источники\n\n";
  for(const r of sources()) t+=`${r.id}. ${r.title} — ${r.username||r.chat_id}\n`;
  if(!sources().length)t+="Нет источников.\n";
  state.set(ctx.from.id,"source"); return ctx.reply(t+"\nОтправь @username или ссылку.\n/cancel");
});
bot.hears("📤 Приёмники",ctx=>{
  let t="📤 Приёмники\n\n";
  for(const r of destinations()) t+=`${r.id}. ${r.title} — ${r.username||r.chat_id}\n`;
  if(!destinations().length)t+="Нет приёмников.\n";
  state.set(ctx.from.id,"destination"); return ctx.reply(t+"\nОтправь @username или ссылку.\n/cancel");
});
bot.hears("🔗 Связки",ctx=>{
  let t="🔗 Связки\n\n";
  for(const r of links()) t+=`${r.id}. ${r.source_title} → ${r.destination_title}\n`;
  if(!links().length)t+="Нет связок.\n";
  state.set(ctx.from.id,"link"); return ctx.reply(t+"\nСоздать: 1 2\nУдалить: /unlink ID");
});
bot.command("unlink",ctx=>{
  const id=Number((ctx.message.text||"").split(/\s+/)[1]);
  if(!Number.isInteger(id)) return ctx.reply("Формат: /unlink 3");
  db.prepare("DELETE FROM links WHERE id=?").run(id); return ctx.reply(`✅ Связка ${id} удалена.`);
});

bot.hears("⚙️ Настройки",ctx=>ctx.reply(
`⚙️ Настройки
Удалять ссылки: ${getSetting("remove_links","0")==="1"?"🟢":"🔴"}
Задержка: ${getSetting("delay","0")} сек.
Белый фильтр: ${getSetting("keywords","нет")}
Чёрный фильтр: ${getSetting("ban_words","нет")}
Подпись: ${getSetting("signature","нет")}
Замены: ${getSetting("replacements","нет")}

/links_on
/links_off
/delay 5
/delay_clear
/signature Текст
/signature_clear
/keywords слово1, слово2
/keywords_clear
/ban_words слово1, слово2
/ban_words_clear
/replace старое -> новое
/replace_clear`
));

for(const [cmd,key] of [["links_on","remove_links"]]){
  bot.command(cmd,ctx=>{setSetting(key,"1");return ctx.reply("✅ Включено.");});
}
bot.command("links_off",ctx=>{setSetting("remove_links","0");return ctx.reply("✅ Отключено.");});
bot.command("delay",ctx=>{const n=Number((ctx.message.text||"").split(/\s+/)[1]);if(!Number.isFinite(n))return ctx.reply("Формат: /delay 5");setSetting("delay",Math.max(0,Math.min(3600,Math.floor(n))));return ctx.reply("✅ Задержка сохранена.");});
bot.command("delay_clear",ctx=>{clearSetting("delay");return ctx.reply("✅ Задержка отключена.");});
bot.command("signature",ctx=>{const v=(ctx.message.text||"").split(" ").slice(1).join(" ").trim();if(!v)return ctx.reply("Формат: /signature Текст");setSetting("signature",v);return ctx.reply("✅ Подпись сохранена.");});
bot.command("signature_clear",ctx=>{clearSetting("signature");return ctx.reply("✅ Подпись отключена.");});
bot.command("keywords",ctx=>{setSetting("keywords",(ctx.message.text||"").split(" ").slice(1).join(" ").trim());return ctx.reply("✅ Фильтр сохранён.");});
bot.command("keywords_clear",ctx=>{clearSetting("keywords");return ctx.reply("✅ Фильтр очищен.");});
bot.command("ban_words",ctx=>{setSetting("ban_words",(ctx.message.text||"").split(" ").slice(1).join(" ").trim());return ctx.reply("✅ Чёрный фильтр сохранён.");});
bot.command("ban_words_clear",ctx=>{clearSetting("ban_words");return ctx.reply("✅ Чёрный фильтр очищен.");});
bot.command("replace",ctx=>{
  const v=(ctx.message.text||"").split(" ").slice(1).join(" ").trim();
  if(!v.includes("->"))return ctx.reply("Формат: /replace старое -> новое");
  const old=getSetting("replacements",""); setSetting("replacements",old?old+"\n"+v:v); return ctx.reply("✅ Замена добавлена.");
});
bot.command("replace_clear",ctx=>{clearSetting("replacements");return ctx.reply("✅ Замены очищены.");});
bot.hears("📊 Статистика",ctx=>{
  const c=t=>db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  return ctx.reply(`📊 Статистика\n\n📥 Источников: ${c("sources")}\n📤 Приёмников: ${c("destinations")}\n🔗 Связок: ${c("links")}\n📨 Скопировано: ${c("copied")}`);
});
bot.hears("❓ Помощь",ctx=>ctx.reply("❓ Добавь источник, приёмник и связку. После этого новые посты копируются автоматически."));

bot.on("text",async ctx=>{
  const s=state.get(ctx.from.id), v=(ctx.message.text||"").trim();
  if(!s||!v||v.startsWith("/")) return;
  try{
    if(s==="source"){const x=await add(v,"sources");state.delete(ctx.from.id);return ctx.reply(`✅ Источник добавлен.\n${x.title}\nID: ${x.id}`,keyboard());}
    if(s==="destination"){const x=await add(v,"destinations");state.delete(ctx.from.id);return ctx.reply(`✅ Приёмник добавлен.\n${x.title}\nID: ${x.id}`,keyboard());}
    if(s==="link"){
      const p=v.split(/\s+/); if(p.length!==2||!p.every(x=>/^\d+$/.test(x))) return ctx.reply("Формат: 1 2");
      if(!db.prepare("SELECT 1 FROM sources WHERE id=?").get(Number(p[0]))) return ctx.reply("❌ Источник не найден.");
      if(!db.prepare("SELECT 1 FROM destinations WHERE id=?").get(Number(p[1]))) return ctx.reply("❌ Приёмник не найден.");
      db.prepare("INSERT OR IGNORE INTO links(source_id,destination_id) VALUES(?,?)").run(Number(p[0]),Number(p[1]));
      state.delete(ctx.from.id); return ctx.reply("✅ Связка создана.",keyboard());
    }
  }catch(e){return ctx.reply(`❌ ${e.message||e}`);}
});
bot.catch(e=>console.error("Bot error:",e));

const app=express();
app.get("/",(req,res)=>res.status(200).send("Telegram Post Cloner is running."));
app.get("/health",(req,res)=>res.json({ok:true,telegram:!!client,uptime:process.uptime()}));
app.listen(PORT,()=>console.log(`HTTP server on ${PORT}`));

(async()=>{
  try{
    const saved=getSetting("mtproto_session","");
    client=new TelegramClient(new StringSession(saved),API_ID,API_HASH,{connectionRetries:10,autoReconnect:true});
    await client.start({
      phoneNumber:async()=>input.text("Telegram phone number: "),
      password:async()=>input.text("Telegram 2FA password: "),
      phoneCode:async()=>input.text("Telegram code: "),
      onError:e=>console.error("Telegram auth:",e)
    });
    setSetting("mtproto_session",client.session.save());
    const me=await client.getMe();
    console.log(`Telegram account: ${me.id} @${me.username||""}`);

    client.addEventHandler(async e=>{
      try{
        const m=e.message;
        if(m&&!m.groupedId) await processMessages([m]);
      }catch(err){console.error("NewMessage:",err);}
    },new events.NewMessage({}));

    client.addEventHandler(async e=>{
      try{await processMessages((e.messages||[]).sort((a,b)=>Number(a.id)-Number(b.id)));}catch(err){console.error("Album:",err);}
    },new events.Album({}));

    await bot.launch();
    console.log("Management bot started.");
    process.once("SIGINT",()=>bot.stop("SIGINT"));
    process.once("SIGTERM",()=>bot.stop("SIGTERM"));
  }catch(e){console.error("FATAL:",e);process.exit(1);}
})();
