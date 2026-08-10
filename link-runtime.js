const path = require("path");
const Database = require("better-sqlite3");
const { Telegraf, Markup } = require("telegraf");

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
)`);

const state = new Map();
const links = () => db.prepare(`SELECT l.id,s.title source_title,d.title destination_title
  FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id ORDER BY l.id`).all();
const sources = () => db.prepare("SELECT id,title FROM sources ORDER BY id").all();
const destinations = () => db.prepare("SELECT id,title FROM destinations ORDER BY id").all();
const ensure = id => db.prepare("INSERT OR IGNORE INTO link_settings(link_id) VALUES(?)").run(id);
const get = (id,key,def="") => { ensure(id); return db.prepare(`SELECT ${key} value FROM link_settings WHERE link_id=?`).get(id)?.value ?? def; };
const set = (id,key,value) => { ensure(id); db.prepare(`UPDATE link_settings SET ${key}=? WHERE link_id=?`).run(String(value),id); };
const lang = ctx => {
  try { return require("./language.js").lang(ctx.from?.id); } catch (_) { return "ru"; }
};
const T = (ctx,ru,uk) => lang(ctx) === "uk" ? uk : ru;

function listKeyboard(ctx) {
  const rows = links().map(r => [Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,58), `lr_open_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"➕ Создать связку","➕ Створити зв’язок"),"lr_create")]);
  if (links().length) rows.push([Markup.button.callback(T(ctx,"🗑 Удалить связку","🗑 Видалити зв’язок"),"lr_delete")]);
  rows.push([Markup.button.callback(T(ctx,"🔄 Обновить","🔄 Оновити"),"lr_menu")]);
  return Markup.inlineKeyboard(rows);
}
function listText(ctx) {
  const ls = links();
  if (!ls.length) return T(ctx,"🔗 Связки\n\nНет связок.\n\nВыбери действие:","🔗 Зв’язки\n\nНемає зв’язків.\n\nОберіть дію:");
  return T(ctx,`🔗 Связки\n\n${ls.map(x=>`${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}\n\nВыбери связку или действие:`,
    `🔗 Зв’язки\n\n${ls.map(x=>`${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}\n\nОберіть зв’язок або дію:`);
}
function card(ctx,id) {
  const r = links().find(x=>x.id===id); if (!r) return null;
  return T(ctx,
    `🔗 Связка #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n`+
    `${get(id,"enabled","1")==="1"?"🟢 Копирование включено":"🔴 Копирование выключено"}\n`+
    `🔗 Удалять ссылки: ${get(id,"remove_links","0")==="1"?"🟢":"🔴"}\n`+
    `⏱ Задержка: ${Number(get(id,"delay","0"))||0} сек.\n`+
    `🔎 Белый фильтр: ${get(id,"keywords")||"нет"}\n`+
    `🚫 Чёрный фильтр: ${get(id,"ban_words")||"нет"}\n`+
    `✍️ Подпись: ${get(id,"signature")||"нет"}\n`+
    `🔄 Замены: ${get(id,"replacements")||"нет"}`,
    `🔗 Зв’язок #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n`+
    `${get(id,"enabled","1")==="1"?"🟢 Копіювання увімкнено":"🔴 Копіювання вимкнено"}\n`+
    `🔗 Видаляти посилання: ${get(id,"remove_links","0")==="1"?"🟢":"🔴"}\n`+
    `⏱ Затримка: ${Number(get(id,"delay","0"))||0} с\n`+
    `🔎 Білий фільтр: ${get(id,"keywords")||"немає"}\n`+
    `🚫 Чорний фільтр: ${get(id,"ban_words")||"немає"}\n`+
    `✍️ Підпис: ${get(id,"signature")||"немає"}\n`+
    `🔄 Заміни: ${get(id,"replacements")||"немає"}`);
}
function settingsKeyboard(ctx,id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(get(id,"enabled","1")==="1"?T(ctx,"⏸ Выключить","⏸ Вимкнути"):T(ctx,"▶️ Включить","▶️ Увімкнути"),`lr_toggle_${id}`)],
    [Markup.button.callback(`🔗 ${T(ctx,"Удалять ссылки","Видаляти посилання")}: ${get(id,"remove_links","0")==="1"?"🟢":"🔴"}`,`lr_links_${id}`), Markup.button.callback(`⏱ ${get(id,"delay","0")} ${T(ctx,"сек.","с")}`,`lr_delay_${id}`)],
    [Markup.button.callback(T(ctx,"🔎 Белый фильтр","🔎 Білий фільтр"),`lr_keywords_${id}`),Markup.button.callback(T(ctx,"🚫 Чёрный фильтр","🚫 Чорний фільтр"),`lr_ban_${id}`)],
    [Markup.button.callback(T(ctx,"✍️ Подпись","✍️ Підпис"),`lr_signature_${id}`),Markup.button.callback(T(ctx,"🔄 Замены","🔄 Заміни"),`lr_replace_${id}`)],
    [Markup.button.callback(T(ctx,"🗑 Сбросить настройки","🗑 Скинути налаштування"),`lr_reset_${id}`)],
    [Markup.button.callback(T(ctx,"⬅️ К связкам","⬅️ До зв’язків"),"lr_menu")]
  ]);
}
function sourceKeyboard(ctx){
  const rows=sources().map(r=>[Markup.button.callback(`📥 ${r.title}`.slice(0,58),`lr_src_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"❌ Отмена","❌ Скасувати"),"lr_cancel")]);
  return Markup.inlineKeyboard(rows);
}
function destinationKeyboard(ctx,sourceId){
  const rows=destinations().map(r=>[Markup.button.callback(`📤 ${r.title}`.slice(0,58),`lr_dst_${sourceId}_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"⬅️ Назад","⬅️ Назад"),"lr_create")]);
  rows.push([Markup.button.callback(T(ctx,"❌ Отмена","❌ Скасувати"),"lr_cancel")]);
  return Markup.inlineKeyboard(rows);
}
function deleteKeyboard(ctx){
  const rows=links().map(r=>[Markup.button.callback(`🗑 ${r.id}. ${r.source_title} → ${r.destination_title}`.slice(0,58),`lr_del_${r.id}`)]);
  rows.push([Markup.button.callback(T(ctx,"⬅️ Назад","⬅️ Назад"),"lr_menu")]);
  return Markup.inlineKeyboard(rows);
}

if (!Telegraf.prototype.__linkRuntimeInstalled) {
  const originalUse = Telegraf.prototype.use;
  let installed = false;
  Telegraf.prototype.use = function(...middlewares) {
    if (!installed) {
      installed = true;
      const middleware = async (ctx,next) => {
        if (!ctx.from || !Number((process.env.ADMIN_IDS||"").split(",").map(x=>x.trim()).find(x=>Number(x)===Number(ctx.from.id)))) return next();
        const data = ctx.callbackQuery?.data || "";
        const text = ctx.message?.text || "";
        if (text === "🔗 Связки" || text === "🔗 Зв’язки") { state.delete(ctx.from.id); return ctx.reply(listText(ctx),listKeyboard(ctx)); }
        if (data === "lr_menu") { await ctx.answerCbQuery(); return ctx.editMessageText(listText(ctx),listKeyboard(ctx)); }
        if (data === "lr_cancel") { state.delete(ctx.from.id); await ctx.answerCbQuery(); return ctx.editMessageText(listText(ctx),listKeyboard(ctx)); }
        if (data === "lr_create") {
          await ctx.answerCbQuery();
          if (!sources().length) return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n❌ Сначала добавь источник.","🔗 Створення зв’язку\n\n❌ Спочатку додайте джерело."),listKeyboard(ctx));
          if (!destinations().length) return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n❌ Сначала добавь приёмник.","🔗 Створення зв’язку\n\n❌ Спочатку додайте приймач."),listKeyboard(ctx));
          state.set(ctx.from.id,{type:"create"});
          return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n1️⃣ Выбери источник:","🔗 Створення зв’язку\n\n1️⃣ Оберіть джерело:"),sourceKeyboard(ctx));
        }
        let m=/^lr_src_(\d+)$/.exec(data);
        if(m){ const sourceId=Number(m[1]); state.set(ctx.from.id,{type:"create",sourceId}); await ctx.answerCbQuery(); return ctx.editMessageText(T(ctx,"🔗 Создание связки\n\n1️⃣ Источник выбран.\n\n2️⃣ Выбери приёмник:","🔗 Створення зв’язку\n\n1️⃣ Джерело обрано.\n\n2️⃣ Оберіть приймач:"),destinationKeyboard(ctx,sourceId)); }
        m=/^lr_dst_(\d+)_(\d+)$/.exec(data);
        if(m){ const sourceId=Number(m[1]),destinationId=Number(m[2]); const st=state.get(ctx.from.id); if(!st?.sourceId) return ctx.reply(T(ctx,"❌ Сначала выбери источник.","❌ Спочатку оберіть джерело.")); const ex=db.prepare("SELECT id FROM links WHERE source_id=? AND destination_id=?").get(sourceId,destinationId); const id=ex?.id||Number(db.prepare("INSERT INTO links(source_id,destination_id) VALUES(?,?)").run(sourceId,destinationId).lastInsertRowid); ensure(id); state.delete(ctx.from.id); await ctx.answerCbQuery(); return ctx.editMessageText(T(ctx,`✅ Связка создана!\n\n🔗 Связка #${id}\n\nНастрой её ниже.`,`✅ Зв’язок створено!\n\n🔗 Зв’язок #${id}\n\nНалаштуйте його нижче.`),settingsKeyboard(ctx,id)); }
        if(data === "lr_delete"){ await ctx.answerCbQuery(); return ctx.editMessageText(T(ctx,"🗑 Удаление связки\n\nВыбери связку:","🗑 Видалення зв’язку\n\nОберіть зв’язок:"),deleteKeyboard(ctx)); }
        m=/^lr_del_(\d+)$/.exec(data);
        if(m){ const id=Number(m[1]); db.prepare("DELETE FROM links WHERE id=?").run(id); db.prepare("DELETE FROM link_settings WHERE link_id=?").run(id); await ctx.answerCbQuery(); return ctx.editMessageText(T(ctx,"✅ Связка удалена.","✅ Зв’язок видалено."),listKeyboard(ctx)); }
        m=/^lr_open_(\d+)$/.exec(data);
        if(m){ const id=Number(m[1]); ensure(id); await ctx.answerCbQuery(); return ctx.editMessageText(card(ctx,id),settingsKeyboard(ctx,id)); }
        m=/^lr_(toggle|links|reset)_(\d+)$/.exec(data);
        if(m){ const id=Number(m[2]); ensure(id); if(m[1]==="toggle")set(id,"enabled",get(id,"enabled","1")==="1"?"0":"1"); if(m[1]==="links")set(id,"remove_links",get(id,"remove_links","0")==="1"?"0":"1"); if(m[1]==="reset")for(const k of ["enabled","remove_links","delay","keywords","ban_words","signature","replacements"])set(id,k,k==="enabled"?"1":k==="delay"?"0":""); await ctx.answerCbQuery(); return ctx.editMessageText(card(ctx,id),settingsKeyboard(ctx,id)); }
        m=/^lr_(delay|keywords|ban|signature|replace)_(\d+)$/.exec(data);
        if(m){ const id=Number(m[2]); const key={delay:"delay",keywords:"keywords",ban:"ban_words",signature:"signature",replace:"replacements"}[m[1]]; state.set(ctx.from.id,{type:"setting",id,key}); await ctx.answerCbQuery(); return ctx.reply(T(ctx, key==="delay"?"⏱ Отправь задержку в секундах (0–3600).":"Отправь новое значение. Для очистки отправь: -", key==="delay"?"⏱ Надішліть затримку в секундах (0–3600).":"Надішліть нове значення. Для очищення надішліть: -")); }
        const st=state.get(ctx.from.id);
        if(st?.type==="setting" && ctx.message?.text){ const v=text.trim(); if(st.key==="delay"){const n=Number(v); if(!Number.isFinite(n)||n<0||n>3600)return ctx.reply(T(ctx,"❌ Число от 0 до 3600.","❌ Число від 0 до 3600.")); set(st.id,st.key,Math.floor(n));} else set(st.id,st.key,["-","нет","немає"].includes(v.toLowerCase())?"":v); state.delete(ctx.from.id); return ctx.reply(T(ctx,"✅ Настройка связки сохранена.","✅ Налаштування зв’язку збережено."),Markup.inlineKeyboard([[Markup.button.callback(T(ctx,"⚙️ Открыть связку","⚙️ Відкрити зв’язок"),`lr_open_${st.id}`)]])); }
        return next();
      };
      return originalUse.call(this,middleware,...middlewares);
    }
    return originalUse.apply(this,middlewares);
  };
  Telegraf.prototype.__linkRuntimeInstalled = true;
}
console.log("Link runtime loaded: button-based links UI enabled.");
