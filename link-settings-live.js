const path = require('path');
const fs = require('fs');
const Module = require('module');
const Database = require('better-sqlite3');
const { Telegraf, Markup } = require('telegraf');
let langFn = () => 'ru';
try { langFn = require('./language.js').lang || langFn; } catch (_) {}

const DIR = path.join(process.env.HOME || process.cwd(), '.telegram-post-cloner');
fs.mkdirSync(DIR, { recursive: true });
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(DIR, 'cloner.db');
const db = new Database(process.env.DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS link_settings(
  link_id INTEGER PRIMARY KEY,
  enabled TEXT DEFAULT '1', remove_links TEXT DEFAULT '0', delay TEXT DEFAULT '0',
  keywords TEXT DEFAULT '', ban_words TEXT DEFAULT '', signature TEXT DEFAULT '', replacements TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS link_stats(
  link_id INTEGER NOT NULL, source_message_id INTEGER NOT NULL, destination_message_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, error TEXT,
  PRIMARY KEY(link_id, source_message_id)
);`);

const ensure = id => db.prepare('INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)').run(id);
const get = (id, key, fallback='') => {
  ensure(id);
  const allowed = new Set(['enabled','remove_links','delay','keywords','ban_words','signature','replacements']);
  if (!allowed.has(key)) return fallback;
  const r = db.prepare(`SELECT ${key} value FROM link_settings WHERE link_id=?`).get(id);
  return r && r.value !== null && r.value !== undefined && String(r.value) !== '' ? String(r.value) : fallback;
};
const set = (id,key,value) => { ensure(id); db.prepare(`UPDATE link_settings SET ${key}=? WHERE link_id=?`).run(String(value),id); };
const reset = id => ['enabled','remove_links','delay','keywords','ban_words','signature','replacements'].forEach(k=>set(id,k,{enabled:'1',remove_links:'0',delay:'0',keywords:'',ban_words:'',signature:'',replacements:''}[k]));
const links = () => db.prepare(`SELECT l.id,s.title source_title,d.title destination_title FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id ORDER BY l.id`).all();
const T=(ctx,ru,uk=ru)=>{try{return langFn(ctx.from?.id)==='uk'?uk:ru}catch(_){return ru}};

function card(ctx,id){const r=links().find(x=>x.id===id);if(!r)return '❌ Связка не найдена.';return T(ctx,
`🔗 Связка #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n${get(id,'enabled','1')==='1'?'🟢 Копирование: включено':'🔴 Копирование: выключено'}\n🔗 Удалять ссылки: ${get(id,'remove_links','0')==='1'?'🟢':'🔴'}\n⏱ Задержка: ${Number(get(id,'delay','0'))||0} сек.\n🔎 Белый фильтр: ${get(id,'keywords','')||'нет'}\n🚫 Чёрный фильтр: ${get(id,'ban_words','')||'нет'}\n✍️ Подпись: ${get(id,'signature','')||'нет'}\n🔄 Замены: ${get(id,'replacements','')||'нет'}`,
`🔗 Зв’язок #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n${get(id,'enabled','1')==='1'?'🟢 Копіювання: увімкнено':'🔴 Копіювання: вимкнено'}\n🔗 Видаляти посилання: ${get(id,'remove_links','0')==='1'?'🟢':'🔴'}\n⏱ Затримка: ${Number(get(id,'delay','0'))||0} с\n🔎 Білий фільтр: ${get(id,'keywords','')||'немає'}\n🚫 Чорний фільтр: ${get(id,'ban_words','')||'немає'}\n✍️ Підпис: ${get(id,'signature','')||'немає'}\n🔄 Заміни: ${get(id,'replacements','')||'немає'}`);}
function settingsKb(ctx,id){return Markup.inlineKeyboard([
[Markup.button.callback(get(id,'enabled','1')==='1'?T(ctx,'⏸ Выключить','⏸ Вимкнути'):T(ctx,'▶️ Включить','▶️ Увімкнути'),`lk_t_${id}`)],
[Markup.button.callback(`${T(ctx,'🔗 Удалять ссылки','🔗 Видаляти посилання')}: ${get(id,'remove_links','0')==='1'?'🟢':'🔴'}`,`lk_l_${id}`),Markup.button.callback(`⏱ ${Number(get(id,'delay','0'))||0}`,`lk_d_${id}`)],
[Markup.button.callback(T(ctx,'🔎 Белый фильтр','🔎 Білий фільтр'),`lk_k_${id}`),Markup.button.callback(T(ctx,'🚫 Чёрный фильтр','🚫 Чорний фільтр'),`lk_b_${id}`)],
[Markup.button.callback(T(ctx,'✍️ Подпись','✍️ Підпис'),`lk_s_${id}`),Markup.button.callback(T(ctx,'🔄 Замены','🔄 Заміни'),`lk_r_${id}`)],
[Markup.button.callback(T(ctx,'📊 Статистика','📊 Статистика'),`lk_stat_${id}`)],
[Markup.button.callback(T(ctx,'🧹 Сбросить настройки','🧹 Скинути налаштування'),`lk_reset_${id}`)],
[Markup.button.callback(T(ctx,'⬅️ К связкам','⬅️ До зв’язків'),'lk_menu')]
]);}
function menu(ctx){const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,60),`lk_open_${r.id}`)]);rows.push([Markup.button.callback(T(ctx,'🔄 Обновить','🔄 Оновити'),'lk_menu')]);return Markup.inlineKeyboard(rows);}
function list(ctx){const ls=links();return T(ctx,ls.length?`🔗 Связки\n\n${ls.map(r=>`${r.id}. ${r.source_title} → ${r.destination_title}`).join('\n')}\n\nВыбери связку:`:'🔗 Связки\n\nНет связок.\n\nВыбери действие:',ls.length?`🔗 Зв’язки\n\n${ls.map(r=>`${r.id}. ${r.source_title} → ${r.destination_title}`).join('\n')}\n\nОберіть зв’язок:`:'🔗 Зв’язки\n\nНемає зв’язків.\n\nОберіть дію:');}
function stat(ctx,id){const r=db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN created_at>=datetime('now','start of day') THEN 1 ELSE 0 END) today,SUM(CASE WHEN created_at>=datetime('now','-6 days') THEN 1 ELSE 0 END) week,SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) errors,MAX(created_at) last FROM link_stats WHERE link_id=?`).get(id)||{};return T(ctx,`📊 Статистика связки #${id}\n\n📅 Сегодня: ${r.today||0}\n📆 За 7 дней: ${r.week||0}\n📦 Всего: ${r.total||0}\n❌ Ошибок: ${r.errors||0}\n🕐 Последняя публикация: ${r.last||'нет'}`,`📊 Статистика зв’язку #${id}\n\n📅 Сьогодні: ${r.today||0}\n📆 За 7 днів: ${r.week||0}\n📦 Всього: ${r.total||0}\n❌ Помилок: ${r.errors||0}\n🕐 Остання публікація: ${r.last||'немає'}`);}

if (!Module._extensions.__liveLinkCore) {
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function(module, filename) {
    if (path.basename(filename) !== 'core.js') return original(module, filename);
    let s = fs.readFileSync(filename,'utf8');
    s = s.replace('const destFor=db.prepare(`SELECT d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);','const destFor=db.prepare(`SELECT l.id link_id,d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);');
    const marker='const sources=()=>db.prepare("SELECT id,chat_id,title,username FROM sources ORDER BY id").all();';
    const helper=`\nfunction __liveLinkSetting(id,k,d){try{const a=new Set(["enabled","remove_links","delay","keywords","ban_words","signature","replacements"]);if(!a.has(k))return d;db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(id);const r=db.prepare(\`SELECT \${k} value FROM link_settings WHERE link_id=?\`).get(id);return r&&r.value!==null&&String(r.value)!==""?String(r.value):d}catch(_){return d}}\nfunction __liveLinkTransform(id,text){text=text||\"\";const ban=String(__liveLinkSetting(id,\"ban_words\",\"\")).split(\",\").map(x=>x.trim()).filter(Boolean);const keys=String(__liveLinkSetting(id,\"keywords\",\"\")).split(\",\").map(x=>x.trim()).filter(Boolean);if(ban.some(w=>text.toLowerCase().includes(w.toLowerCase())))return null;if(keys.length&&!keys.some(w=>text.toLowerCase().includes(w.toLowerCase())))return null;if(__liveLinkSetting(id,\"remove_links\",\"0\")==\"1\")text=text.replace(/https?:\\/\\/\\S+|(?:https?:\\/\\/)?t\\.me\\/\\S+/gi,\"\");for(const line of String(__liveLinkSetting(id,\"replacements\",\"\")).split(/\\r?\\n/)){if(!line.includes(\"->\"))continue;const a=line.indexOf(\"->\");const old=line.slice(0,a).trim(),neu=line.slice(a+2).trim();if(old)text=text.split(old).join(neu)}const sig=__liveLinkSetting(id,\"signature\",\"\");if(sig)text=text.trim()?text.trim()+\"\\n\\n\"+sig:sig;return text.trim()}\n`;
    if(!s.includes('function __liveLinkSetting(')) s=s.replace(marker,helper+marker);
    s=s.replace('async function copyOne(message,destination){const text=transformText(message.message||"");','async function copyOne(message,destination,linkId){const text=__liveLinkTransform(linkId,message.message||"");');
    s=s.replace('async function copyAlbum(messages,destination){const items=[];for(const m of messages){const text=transformText(m.message||"");','async function copyAlbum(messages,destination,linkId){const items=[];for(const m of messages){const text=__liveLinkTransform(linkId,m.message||"");');
    const old='for(const row of destFor.all(sourceChatId)){const destinationChatId=row.chat_id;if(messages.every(m=>!!copied.get(sourceChatId,Number(m.id),destinationChatId)))continue;await enqueue(destinationChatId,async()=>{const delay=Math.max(0,Math.min(3600,Number(getSetting("delay","0"))||0));if(delay)await new Promise(r=>setTimeout(r,delay*1000));try{const destination=await client.getEntity(destinationChatId);const sent=messages.length>1?await copyAlbum(messages,destination):await copyOne(messages[0],destination);';
    const neu='for(const row of destFor.all(sourceChatId)){const destinationChatId=row.chat_id;const linkId=Number(row.link_id);if(__liveLinkSetting(linkId,"enabled","1")!=="1")continue;if(messages.every(m=>!!copied.get(sourceChatId,Number(m.id),destinationChatId)))continue;await enqueue(destinationChatId,async()=>{const delay=Math.max(0,Math.min(3600,Number(__liveLinkSetting(linkId,"delay",getSetting("delay","0")))||0));if(delay)await new Promise(r=>setTimeout(r,delay*1000));try{const destination=await client.getEntity(destinationChatId);const sent=messages.length>1?await copyAlbum(messages,destination,linkId):await copyOne(messages[0],destination,linkId);';
    s=s.replace(old,neu);
    s=s.replace('if(arr[i])mark.run(sourceChatId,Number(m.id),destinationChatId,Number(arr[i].id));','if(arr[i]){mark.run(sourceChatId,Number(m.id),destinationChatId,Number(arr[i].id));try{db.prepare("INSERT OR REPLACE INTO link_stats(link_id,source_message_id,destination_message_id,error) VALUES(?,?,?,NULL)").run(linkId,Number(m.id),Number(arr[i].id));}catch(_){}}');
    s=s.replace('console.error("Copy error:",e?.message||e);','console.error("Copy error:",e?.message||e);try{db.prepare("INSERT OR REPLACE INTO link_stats(link_id,source_message_id,destination_message_id,error) VALUES(?,?,NULL,?)").run(linkId,Number(messages[0].id),String(e?.message||e));}catch(_){}}');
    module._compile(s,filename);
  };
  Module._extensions.__liveLinkCore=true;
}

if (!Telegraf.prototype.__liveLinkUI) {
  const originalUse=Telegraf.prototype.use;
  Telegraf.prototype.use=function(...middlewares){
    const ui=async(ctx,next)=>{
      if(!ctx.from)return next();
      const data=ctx.callbackQuery?.data||'';
      const text=ctx.message?.text||'';
      if(text==='🔗 Связки'||text==='🔗 Зв’язки'){await ctx.reply(list(ctx),menu(ctx));return;}
      if(data==='lk_menu'){await ctx.answerCbQuery();await ctx.editMessageText(list(ctx),menu(ctx));return;}
      let m=/^lk_open_(\d+)$/.exec(data);
      if(m){const id=Number(m[1]);await ctx.answerCbQuery();await ctx.editMessageText(card(ctx,id),settingsKb(ctx,id));return;}
      m=/^lk_t_(\d+)$/.exec(data);if(m){const id=Number(m[1]);set(id,'enabled',get(id,'enabled','1')==='1'?'0':'1');await ctx.answerCbQuery();await ctx.editMessageText(card(ctx,id),settingsKb(ctx,id));return;}
      m=/^lk_l_(\d+)$/.exec(data);if(m){const id=Number(m[1]);set(id,'remove_links',get(id,'remove_links','0')==='1'?'0':'1');await ctx.answerCbQuery();await ctx.editMessageText(card(ctx,id),settingsKb(ctx,id));return;}
      m=/^lk_(d|k|b|s|r)_(\d+)$/.exec(data);
      if(m){const id=Number(m[2]),key={d:'delay',k:'keywords',b:'ban_words',s:'signature',r:'replacements'}[m[1]];ctx.from.__linkPending={id,key};await ctx.answerCbQuery();const ru={delay:'⏱ Введи задержку в секундах. 0 = без задержки.',keywords:'🔎 Введи ключевые слова через запятую.',ban_words:'🚫 Введи запрещённые слова через запятую.',signature:'✍️ Введи подпись.',replacements:'🔄 Введи замены, по одной на строку: старое -> новое'}[key];const uk={delay:'⏱ Введіть затримку в секундах. 0 = без затримки.',keywords:'🔎 Введіть ключові слова через кому.',ban_words:'🚫 Введіть заборонені слова через кому.',signature:'✍️ Введіть підпис.',replacements:'🔄 Введіть заміни, по одній на рядок: старе -> нове'}[key];await ctx.reply(T(ctx,ru,uk));return;}
      m=/^lk_stat_(\d+)$/.exec(data);if(m){const id=Number(m[1]);await ctx.answerCbQuery();await ctx.editMessageText(stat(ctx,id),Markup.inlineKeyboard([[Markup.button.callback(T(ctx,'⬅️ К настройкам','⬅️ До налаштувань'),`lk_open_${id}`)]]));return;}
      m=/^lk_reset_(\d+)$/.exec(data);if(m){const id=Number(m[1]);reset(id);await ctx.answerCbQuery();await ctx.editMessageText(card(ctx,id),settingsKb(ctx,id));return;}
      const pending=ctx.from.__linkPending;
      if(pending&&text){const {id,key}=pending;if(key==='delay'&&(!/^\d{1,4}$/.test(text.trim())||Number(text.trim())>3600)){await ctx.reply(T(ctx,'❌ Введи число от 0 до 3600.','❌ Введіть число від 0 до 3600.'));return;}set(id,key,text.trim());delete ctx.from.__linkPending;await ctx.reply(T(ctx,'✅ Настройка сохранена.','✅ Налаштування збережено.'),settingsKb(ctx,id));return;}
      return next();
    };
    return originalUse.call(this,ui,...middlewares);
  };
  Telegraf.prototype.__liveLinkUI=true;
}

console.log('Per-link settings runtime loaded.');
