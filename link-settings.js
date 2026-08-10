const path = require("path");
const fs = require("fs");
const Module = require("module");
const Database = require("better-sqlite3");
const { Composer, Markup } = require("telegraf");
const { lang } = require("./language.js");

const DIR = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
if (!process.env.DB_PATH) process.env.DB_PATH = path.join(DIR, "cloner.db");
const db = new Database(process.env.DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS link_settings(
  link_id INTEGER PRIMARY KEY,
  enabled TEXT DEFAULT '1',
  remove_links TEXT DEFAULT '0',
  delay TEXT DEFAULT '0',
  keywords TEXT DEFAULT '',
  ban_words TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  replacements TEXT DEFAULT ''
);`);

const state = new Map();
const defaults = {enabled:"1",remove_links:"0",delay:"0",keywords:"",ban_words:"",signature:"",replacements:""};
const ensure = id => db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(id);
const get = (id,key) => { ensure(id); return db.prepare(`SELECT ${key} value FROM link_settings WHERE link_id=?`).get(id)?.value ?? defaults[key]; };
const set = (id,key,value) => { ensure(id); db.prepare(`UPDATE link_settings SET ${key}=? WHERE link_id=?`).run(String(value),id); };
const reset = id => { for (const [k,v] of Object.entries(defaults)) set(id,k,v); };
const links = () => db.prepare(`SELECT l.id,s.id source_id,s.title source_title,d.id destination_id,d.title destination_title FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id ORDER BY l.id`).all();
const sources = () => db.prepare("SELECT id,title,username,chat_id FROM sources ORDER BY id").all();
const destinations = () => db.prepare("SELECT id,title,username,chat_id FROM destinations ORDER BY id").all();
const T = (ctx, ru, uk = ru) => lang(ctx.from?.id) === "uk" ? uk : ru;

function listText(ctx){
  const ls=links();
  if(!ls.length) return T(ctx,"🔗 Связки\n\nНет связок.\n\nВыбери действие:","🔗 Зв’язки\n\nНемає зв’язків.\n\nОберіть дію:");
  return T(ctx,`🔗 Связки\n\n${ls.map(x=>`${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}\n\nВыбери связку или действие:`,`🔗 Зв’язки\n\n${ls.map(x=>`${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}\n\nОберіть зв’язок або дію:`);
}

function card(ctx,id){
  const r=links().find(x=>x.id===id); if(!r)return null;
  return T(ctx,
    `🔗 Связка #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n${get(id,"enabled")==="1"?"🟢 Копирование: включено":"🔴 Копирование: выключено"}\n🔗 Удалять ссылки: ${get(id,"remove_links")==="1"?"🟢":"🔴"}\n⏱ Задержка: ${Number(get(id,"delay"))||0} сек.\n🔎 Белый фильтр: ${get(id,"keywords")||"нет"}\n🚫 Чёрный фильтр: ${get(id,"ban_words")||"нет"}\n✍️ Подпись: ${get(id,"signature")||"нет"}\n🔄 Замены: ${get(id,"replacements")||"нет"}`,
    `🔗 Зв’язок #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n${get(id,"enabled")==="1"?"🟢 Копіювання: увімкнено":"🔴 Копіювання: вимкнено"}\n🔗 Видаляти посилання: ${get(id,"remove_links")==="1"?"🟢":"🔴"}\n⏱ Затримка: ${Number(get(id,"delay"))||0} с\n🔎 Білий фільтр: ${get(id,"keywords")||"немає"}\n🚫 Чорний фільтр: ${get(id,"ban_words")||"немає"}\n✍️ Підпис: ${get(id,"signature")||"немає"}\n🔄 Заміни: ${get(id,"replacements")||"немає"}`
  );
}

function menu(ctx){
  const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,58),`ls_open_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"➕ Создать связку","➕ Створити зв’язок"),"link_create")]);
  if(links().length)rows.push([Markup.button.callback(T(ctx,"🗑 Удалить связку","🗑 Видалити зв’язок"),"link_delete_menu")]);
  rows.push([Markup.button.callback(T(ctx,"🔄 Обновить","🔄 Оновити"),"ls_menu")]);
  return Markup.inlineKeyboard(rows);
}

function settingsKeyboard(ctx,id){return Markup.inlineKeyboard([
  [Markup.button.callback(get(id,"enabled")==="1"?T(ctx,"⏸ Выключить","⏸ Вимкнути"):T(ctx,"▶️ Включить","▶️ Увімкнути"),`ls_toggle_${id}`)],
  [Markup.button.callback(`${T(ctx,"🔗 Удалять ссылки","🔗 Видаляти посилання")}: ${get(id,"remove_links")==="1"?"🟢":"🔴"}`,`ls_links_${id}`),Markup.button.callback(`⏱ ${Number(get(id,"delay"))||0} ${T(ctx,"сек.","с")}`,`ls_delay_${id}`)],
  [Markup.button.callback(T(ctx,"🔎 Белый фильтр","🔎 Білий фільтр"),`ls_keywords_${id}`),Markup.button.callback(T(ctx,"🚫 Чёрный фильтр","🚫 Чорний фільтр"),`ls_ban_${id}`)],
  [Markup.button.callback(T(ctx,"✍️ Подпись","✍️ Підпис"),`ls_signature_${id}`),Markup.button.callback(T(ctx,"🔄 Замены","🔄 Заміни"),`ls_replace_${id}`)],
  [Markup.button.callback(T(ctx,"🗑 Сбросить настройки","🗑 Скинути налаштування"),`ls_reset_${id}`)],
  [Markup.button.callback(T(ctx,"⬅️ К связкам","⬅️ До зв’язків"),"ls_menu")]
]);}

function sourceKeyboard(ctx){
  const rows=sources().map(r=>[Markup.button.callback(`📥 ${r.title}`.slice(0,60),`link_src_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"❌ Отмена","❌ Скасувати"),"link_create_cancel")]);
  return Markup.inlineKeyboard(rows);
}
function destinationKeyboard(ctx,sourceId){
  const rows=destinations().map(r=>[Markup.button.callback(`📤 ${r.title}`.slice(0,60),`link_dst_${sourceId}_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"⬅️ Назад к источникам","⬅️ Назад до джерел"),"link_create")]);
  rows.push([Markup.button.callback(T(ctx,"❌ Отмена","❌ Скасувати"),"link_create_cancel")]);
  return Markup.inlineKeyboard(rows);
}
function deleteKeyboard(ctx){
  const rows=links().map(r=>[Markup.button.callback(`🗑 ${r.id}. ${r.source_title} → ${r.destination_title}`.slice(0,60),`link_del_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"⬅️ Назад","⬅️ Назад"),"ls_menu")]);
  return Markup.inlineKeyboard(rows);
}

// Apply per-link settings to the existing cloner without duplicating index.js.
if (!Module._extensions.__linkSettingsLoader) {
  const originalLoader = Module._extensions[".js"];
  const loader = function(module, filename) {
    if (path.basename(filename) !== "index.js") return originalLoader(module, filename);
    let source = fs.readFileSync(filename, "utf8");
    source = source.replace('const destFor=db.prepare(`SELECT d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);','const destFor=db.prepare(`SELECT l.id link_id,d.chat_id FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id WHERE s.chat_id=? ORDER BY d.id`);');
    const marker='const sources=()=>db.prepare("SELECT id,chat_id,title,username FROM sources ORDER BY id").all();';
    const helpers=`
function getLinkSetting(linkId,key,fallback=""){
  try{
    db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(linkId);
    const allowed=new Set(["enabled","remove_links","delay","keywords","ban_words","signature","replacements"]);
    if(!allowed.has(key))return fallback;
    const row=db.prepare(\`SELECT \${key} value FROM link_settings WHERE link_id=?\`).get(linkId);
    if(row&&row.value!==null&&row.value!==undefined&&String(row.value)!=="")return String(row.value);
  }catch(e){console.error("Link settings read error:",e?.message||e);}
  return fallback;
}
function linkTransformText(linkId,text){
  text=text||"";
  const ban=csv(getLinkSetting(linkId,"ban_words",getSetting("ban_words","")));
  const keys=csv(getLinkSetting(linkId,"keywords",getSetting("keywords","")));
  if(ban.some(w=>text.toLowerCase().includes(w.toLowerCase())))return null;
  if(keys.length&&!keys.some(w=>text.toLowerCase().includes(w.toLowerCase())))return null;
  if(getLinkSetting(linkId,"remove_links",getSetting("remove_links","0"))==="1")text=text.replace(/https?:\\/\\/\\S+|(?:https?:\\/\\/)?t\\.me\\/\\S+/gi,"");
  const replacements=getLinkSetting(linkId,"replacements",getSetting("replacements",""));
  for(const line of replacements.split(/\\r?\\n/)){if(!line.includes("->"))continue;const a=line.indexOf("->"),old=line.slice(0,a).trim(),neu=line.slice(a+2).trim();if(old)text=text.split(old).join(neu);}
  const sig=getLinkSetting(linkId,"signature",getSetting("signature",""));
  if(sig)text=text.trim()?\`${text.trim()}\\n\\n\${sig}\`:sig;
  return text.trim();
}
`;
    if(!source.includes("function getLinkSetting(linkId,key,fallback=\"\")"))source=source.replace(marker,helpers+"\n"+marker);
    source=source.replace('async function copyOne(message,destination){const text=transformText(message.message||"");','async function copyOne(message,destination,linkId){const text=linkTransformText(linkId,message.message||"");');
    source=source.replace('async function copyAlbum(messages,destination){const items=[];for(const m of messages){const text=transformText(m.message||"");','async function copyAlbum(messages,destination,linkId){const items=[];for(const m of messages){const text=linkTransformText(linkId,m.message||"");');
    const oldProcess='for(const row of destFor.all(sourceChatId)){const destinationChatId=row.chat_id;if(messages.every(m=>!!copied.get(sourceChatId,Number(m.id),destinationChatId)))continue;await enqueue(destinationChatId,async()=>{const delay=Math.max(0,Math.min(3600,Number(getSetting("delay","0"))||0));if(delay)await new Promise(r=>setTimeout(r,delay*1000));try{const destination=await client.getEntity(destinationChatId);const sent=messages.length>1?await copyAlbum(messages,destination):await copyOne(messages[0],destination);';
    const newProcess='for(const row of destFor.all(sourceChatId)){const destinationChatId=row.chat_id;const linkId=Number(row.link_id);if(getLinkSetting(linkId,"enabled","1")!=="1")continue;if(messages.every(m=>!!copied.get(sourceChatId,Number(m.id),destinationChatId)))continue;await enqueue(destinationChatId,async()=>{const delay=Math.max(0,Math.min(3600,Number(getLinkSetting(linkId,"delay",getSetting("delay","0")))||0));if(delay)await new Promise(r=>setTimeout(r,delay*1000));try{const destination=await client.getEntity(destinationChatId);const sent=messages.length>1?await copyAlbum(messages,destination,linkId):await copyOne(messages[0],destination,linkId);';
    source=source.replace(oldProcess,newProcess);
    module._compile(source,filename);
  };
  Module._extensions[".js"]=loader;
  Module._extensions.__linkSettingsLoader=true;
}

if(!Composer.prototype.__linkSettingsPatch){
  const originalUse=Composer.prototype.use;
  Composer.prototype.use=function(...middlewares){
    const middleware=async(ctx,next)=>{
      if(!ctx.from)return next();
      const data=ctx.callbackQuery?.data||"";
      const text=ctx.message?.text||"";

      if(text==="🔗 Связки"||text==="🔗 Зв’язки")return ctx.reply(listText(ctx),menu(ctx));
      if(data==="ls_menu"){await ctx.answerCbQuery();return ctx.editMessageText(listText(ctx),menu(ctx));}

      // Create: choose source, choose destination, then immediately open settings.
      if(data==="link_create"){
        await ctx.answerCbQuery();
        if(!sources().length)return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n❌ Сначала добавь хотя бы один источник.","🔗 Створення зв’язку\n\n❌ Спочатку додайте хоча б одне джерело."),menu(ctx));
        if(!destinations().length)return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n❌ Сначала добавь хотя бы один приёмник.","🔗 Створення зв’язку\n\n❌ Спочатку додайте хоча б один приймач."),menu(ctx));
        state.set(ctx.from.id,{type:"link_create"});
        return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n1️⃣ Выбери источник:","🔗 Створення зв’язку\n\n1️⃣ Оберіть джерело:"),sourceKeyboard(ctx));
      }
      if(data==="link_create_cancel"){state.delete(ctx.from.id);await ctx.answerCbQuery();return ctx.editMessageText(listText(ctx),menu(ctx));}

      let m=/^link_src_(\d+)$/.exec(data);
      if(m){
        const sourceId=Number(m[1]);
        if(!sources().some(x=>x.id===sourceId)){await ctx.answerCbQuery();return ctx.reply(T(ctx,"❌ Источник не найден.","❌ Джерело не знайдено."));}
        state.set(ctx.from.id,{type:"link_create",sourceId});await ctx.answerCbQuery();
        return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n1️⃣ Источник выбран.\n\n2️⃣ Выбери приёмник:","🔗 Створення зв’язку\n\n1️⃣ Джерело обрано.\n\n2️⃣ Оберіть приймач:"),destinationKeyboard(ctx,sourceId));
      }

      m=/^link_dst_(\d+)_(\d+)$/.exec(data);
      if(m){
        const sourceId=Number(m[1]),destinationId=Number(m[2]);
        if(!sources().some(x=>x.id===sourceId)){await ctx.answerCbQuery();return ctx.reply(T(ctx,"❌ Источник не найден.","❌ Джерело не знайдено."));}
        if(!destinations().some(x=>x.id===destinationId)){await ctx.answerCbQuery();return ctx.reply(T(ctx,"❌ Приёмник не найден.","❌ Приймач не знайдено."));}
        const existing=db.prepare("SELECT id FROM links WHERE source_id=? AND destination_id=?").get(sourceId,destinationId);
        let linkId=existing?.id;
        if(!linkId){const result=db.prepare("INSERT INTO links(source_id,destination_id) VALUES(?,?)").run(sourceId,destinationId);linkId=Number(result.lastInsertRowid);}
        ensure(linkId);state.delete(ctx.from.id);await ctx.answerCbQuery();
        return ctx.editMessageText(T(ctx,`✅ Связка создана!\n\n🔗 Связка #${linkId}\n\nТеперь можешь настроить её ниже.`,`✅ Зв’язок створено!\n\n🔗 Зв’язок #${linkId}\n\nТепер ви можете налаштувати його нижче.`),settingsKeyboard(ctx,linkId));
      }

      // Delete by buttons, including cleanup of per-link settings.
      if(data==="link_delete_menu"){
        await ctx.answerCbQuery();
        if(!links().length)return ctx.editMessageText(T(ctx,"❌ Нет связок для удаления.","❌ Немає зв’язків для видалення."),menu(ctx));
        return ctx.editMessageText(T(ctx,"🗑 Удаление связки\n\nВыбери связку:","🗑 Видалення зв’язку\n\nОберіть зв’язок:"),deleteKeyboard(ctx));
      }
      m=/^link_del_(\d+)$/.exec(data);
      if(m){
        const id=Number(m[1]);await ctx.answerCbQuery();
        db.prepare("DELETE FROM links WHERE id=?").run(id);
        db.prepare("DELETE FROM link_settings WHERE link_id=?").run(id);
        state.delete(ctx.from.id);
        return ctx.editMessageText(T(ctx,"✅ Связка удалена.","✅ Зв’язок видалено."),menu(ctx));
      }

      m=/^ls_open_(\d+)$/.exec(data);
      if(m){const id=Number(m[1]);if(!links().some(x=>x.id===id))return ctx.reply(T(ctx,"❌ Связка не найдена.","❌ Зв’язок не знайдено."));ensure(id);await ctx.answerCbQuery();return ctx.editMessageText(card(ctx,id),settingsKeyboard(ctx,id));}

      m=/^ls_(toggle|links|reset)_(\d+)$/.exec(data);
      if(m){const action=m[1],id=Number(m[2]);ensure(id);await ctx.answerCbQuery();if(action==="toggle")set(id,"enabled",get(id,"enabled")==="1"?"0":"1");if(action==="links")set(id,"remove_links",get(id,"remove_links")==="1"?"0":"1");if(action==="reset")reset(id);return ctx.editMessageText(card(ctx,id),settingsKeyboard(ctx,id));}

      m=/^ls_(delay|keywords|ban|signature|replace)_(\d+)$/.exec(data);
      if(m){
        const id=Number(m[2]),key={delay:"delay",keywords:"keywords",ban:"ban_words",signature:"signature",replace:"replacements"}[m[1]];
        state.set(ctx.from.id,{type:"link_setting",linkId:id,key});await ctx.answerCbQuery();
        const label=key==="delay"?T(ctx,"⏱ Задержка","⏱ Затримка"):T(ctx,{keywords:"🔎 Белый фильтр",ban_words:"🚫 Чёрный фильтр",signature:"✍️ Подпись",replacements:"🔄 Замены"}[key],{keywords:"🔎 Білий фільтр",ban_words:"🚫 Чорний фільтр",signature:"✍️ Підпис",replacements:"🔄 Заміни"}[key]);
        const hint=key==="delay"?T(ctx,"Отправь число секунд от 0 до 3600.","Надішліть кількість секунд від 0 до 3600."):T(ctx,"Отправь новое значение. Для очистки отправь: -","Надішліть нове значення. Для очищення надішліть: -");
        return ctx.reply(`${label}\n\n${hint}`);
      }

      const st=state.get(ctx.from.id);
      if(st?.type==="link_setting"&&ctx.message?.text){
        const v=text.trim(),id=st.linkId,key=st.key;
        if(key==="delay"){const n=Number(v);if(!Number.isFinite(n)||n<0||n>3600)return ctx.reply(T(ctx,"❌ Введи число от 0 до 3600.","❌ Введіть число від 0 до 3600."));set(id,key,Math.floor(n));}
        else set(id,key,["-","нет","немає","очистить","очистити"].includes(v.toLowerCase())?"":v);
        state.delete(ctx.from.id);
        return ctx.reply(T(ctx,"✅ Настройка связки сохранена.","✅ Налаштування зв’язку збережено."),Markup.inlineKeyboard([[Markup.button.callback(T(ctx,"⚙️ Открыть связку","⚙️ Відкрити зв’язок"),`ls_open_${id}`)]]));
      }
      return next();
    };
    return originalUse.call(this,middleware,...middlewares);
  };
  Composer.prototype.__linkSettingsPatch=true;
}
