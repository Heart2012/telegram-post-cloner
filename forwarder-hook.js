// Stable MTProto polling forwarder.
// It starts from TelegramClient.connect(), so it does not depend on update events.
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
const settingStmt=db.prepare("SELECT value FROM settings WHERE key=?");
const sourceRows=db.prepare("SELECT chat_id,title,username FROM sources ORDER BY id");
const destinationsFor=db.prepare(`SELECT d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);
const copiedStmt=db.prepare("SELECT 1 FROM copied WHERE source_chat_id=? AND source_message_id=? AND destination_chat_id=?");
const markStmt=db.prepare("INSERT OR IGNORE INTO copied(source_chat_id,source_message_id,destination_chat_id,destination_message_id) VALUES(?,?,?,?)");
const locks=new Map();const lastSeen=new Map();const running=new WeakSet();
function setting(k,d=""){const r=settingStmt.get(k);return r?r.value:d;}
function idOf(v){if(v===null||v===undefined)return 0;if(typeof v==="bigint")return Number(v);if(typeof v==="number")return v;if(typeof v==="string")return Number(v)||0;if(v.value!==undefined)return Number(v.value)||0;return Number(v)||0;}
function csv(v){return String(v||"").split(",").map(x=>x.trim()).filter(Boolean);}
function transformText(text){text=text||"";const lower=text.toLowerCase();if(csv(setting("ban_words")).some(w=>lower.includes(w.toLowerCase())))return null;const keys=csv(setting("keywords"));if(keys.length&&!keys.some(w=>lower.includes(w.toLowerCase())))return null;if(setting("remove_links","0")==="1")text=text.replace(/https?:\/\/\S+|(?:https?:\/\/)?t\.me\/\S+/gi,"");for(const line of setting("replacements","").split(/\r?\n/)){if(!line.includes("->"))continue;const p=line.indexOf("->"),a=line.slice(0,p).trim(),b=line.slice(p+2).trim();if(a)text=text.split(a).join(b);}const sig=setting("signature","");if(sig)text=text.trim()?`${text.trim()}\n\n${sig}`:sig;return text.trim();}
async function withLock(id,task){const prev=locks.get(id)||Promise.resolve();let release;const cur=new Promise(r=>release=r);locks.set(id,cur);await prev;try{return await task();}finally{release();if(locks.get(id)===cur)locks.delete(id);}}
async function copyMessage(client,m,destination){const text=transformText(m.message||"");if(text===null)return null;if(m.media)return client.sendFile(destination,{file:m.media,caption:text||undefined,forceDocument:false});if(!text)return null;return client.sendMessage(destination,{message:text,linkPreview:false});}
async function processOne(client,sourceId,m){const rows=destinationsFor.all(sourceId);console.log(`FORWARDER: source=${sourceId} message=${idOf(m.id)} destinations=${rows.length}`);for(const row of rows){const dest=idOf(row.chat_id);if(!dest||copiedStmt.get(sourceId,idOf(m.id),dest))continue;await withLock(dest,async()=>{try{const entity=await client.getEntity(dest);const sent=await copyMessage(client,m,entity);if(!sent){console.log(`FORWARDER: filtered/empty ${sourceId}:${idOf(m.id)}`);return;}markStmt.run(sourceId,idOf(m.id),dest,idOf(sent.id));console.log(`FORWARDER COPIED ${sourceId}:${idOf(m.id)} -> ${dest}`);}catch(e){console.error(`FORWARDER COPY ERROR ${sourceId} -> ${dest}:`,e?.stack||e?.message||e);}});}}
async function pollSource(client,row){const sourceId=idOf(row.chat_id);const ref=row.username?`@${row.username}`:sourceId;try{const entity=await client.getEntity(ref);const newest=await client.getMessages(entity,{limit:1});if(!newest?.length)return;const newestId=idOf(newest[0].id);const previous=lastSeen.get(sourceId);if(previous===undefined){lastSeen.set(sourceId,newestId);console.log(`FORWARDER: watching ${sourceId} (${row.title}), last=${newestId}`);return;}if(newestId<=previous)return;const messages=await client.getMessages(entity,{minId:previous,maxId:newestId,limit:Math.min(100,Math.max(1,newestId-previous))});const fresh=(messages||[]).filter(m=>idOf(m.id)>previous&&idOf(m.id)<=newestId).sort((a,b)=>idOf(a.id)-idOf(b.id));lastSeen.set(sourceId,newestId);console.log(`FORWARDER: found ${fresh.length} new message(s) in ${sourceId}`);for(const m of fresh)await processOne(client,sourceId,m);}catch(e){console.error(`FORWARDER POLL ERROR ${sourceId}:`,e?.stack||e?.message||e);}}
async function start(client){if(!client||running.has(client))return;running.add(client);console.log("FORWARDER: Telegram client ready; polling every 2 seconds.");const loop=async()=>{try{const rows=sourceRows.all();console.log(`FORWARDER: sources=${rows.length}`);for(const row of rows)await pollSource(client,row);}catch(e){console.error("FORWARDER LOOP ERROR:",e?.stack||e?.message||e);}setTimeout(loop,2000);};await loop();}

if(!TelegramClient.prototype.__postClonerConnectHook){
  const originalConnect=TelegramClient.prototype.connect;
  TelegramClient.prototype.connect=async function(...args){
    const result=await originalConnect.apply(this,args);
    console.log("FORWARDER: Telegram connect() completed; starting poller.");
    setImmediate(()=>start(this).catch(e=>console.error("FORWARDER START ERROR:",e?.stack||e?.message||e)));
    return result;
  };
  TelegramClient.prototype.__postClonerConnectHook=true;
}
console.log("Stable MTProto forwarder hook loaded.");
