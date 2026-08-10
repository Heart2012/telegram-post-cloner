const path = require("path");
const Database = require("better-sqlite3");
const { Composer, Markup } = require("telegraf");

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
const links = () => db.prepare(`SELECT l.id,s.title source_title,d.title destination_title FROM links l JOIN sources s ON s.id=l.source_id JOIN destinations d ON d.id=l.destination_id ORDER BY l.id`).all();

function listText(){const ls=links();return ls.length?`🔗 Связки\n\n${ls.map(x=>`${x.id}. ${x.source_title} → ${x.destination_title}`).join("\n")}\n\nВыбери связку или действие:`:"🔗 Связки\n\nНет связок.\n\nВыбери действие:"}
function card(id){const r=links().find(x=>x.id===id);if(!r)return null;return `🔗 Связка #${id}\n\n📥 ${r.source_title}\n        ↓\n📤 ${r.destination_title}\n\n${get(id,"enabled")==="1"?"🟢 Копирование: включено":"🔴 Копирование: выключено"}\n🔗 Удалять ссылки: ${get(id,"remove_links")==="1"?"🟢":"🔴"}\n⏱ Задержка: ${Number(get(id,"delay"))||0} сек.\n🔎 Белый фильтр: ${get(id,"keywords")||"нет"}\n🚫 Чёрный фильтр: ${get(id,"ban_words")||"нет"}\n✍️ Подпись: ${get(id,"signature")||"нет"}\n🔄 Замены: ${get(id,"replacements")||"нет"}`;}
function menu(){const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,58),`ls_open_${r.id}`)]);rows.push([Markup.button.callback("➕ Создать связку","link_create")]);if(links().length)rows.push([Markup.button.callback("🗑 Удалить связку","link_delete_menu")]);rows.push([Markup.button.callback("🔄 Обновить","ls_menu")]);return Markup.inlineKeyboard(rows);}
function settingsKeyboard(id){return Markup.inlineKeyboard([
  [Markup.button.callback(get(id,"enabled")==="1"?"⏸ Выключить":"▶️ Включить",`ls_toggle_${id}`)],
  [Markup.button.callback(`🔗 Удалять ссылки: ${get(id,"remove_links")==="1"?"🟢":"🔴"}`,`ls_links_${id}`),Markup.button.callback(`⏱ ${Number(get(id,"delay"))||0} сек.`,`ls_delay_${id}`)],
  [Markup.button.callback("🔎 Белый фильтр",`ls_keywords_${id}`),Markup.button.callback("🚫 Чёрный фильтр",`ls_ban_${id}`)],
  [Markup.button.callback("✍️ Подпись",`ls_signature_${id}`),Markup.button.callback("🔄 Замены",`ls_replace_${id}`)],
  [Markup.button.callback("🗑 Сбросить настройки",`ls_reset_${id}`)],
  [Markup.button.callback("⬅️ К связкам","ls_menu")]
]);}
const labels={keywords:"🔎 Белый фильтр",ban_words:"🚫 Чёрный фильтр",signature:"✍️ Подпись",replacements:"🔄 Замены"};

if (!Composer.prototype.__linkSettingsPatch) {
  const originalUse = Composer.prototype.use;
  Composer.prototype.use = function(...middlewares) {
    const middleware = async (ctx,next) => {
      if (!ctx.from) return next();
      const data = ctx.callbackQuery?.data || "";
      const text = ctx.message?.text || "";

      if (text === "🔗 Связки") return ctx.reply(listText(),menu());
      if (data === "ls_menu") { await ctx.answerCbQuery(); return ctx.editMessageText(listText(),menu()); }

      let m=/^ls_open_(\d+)$/.exec(data);
      if(m){const id=Number(m[1]);if(!links().some(x=>x.id===id))return ctx.reply("❌ Связка не найдена.");ensure(id);await ctx.answerCbQuery();return ctx.editMessageText(card(id),settingsKeyboard(id));}

      m=/^ls_(toggle|links|reset)_(\d+)$/.exec(data);
      if(m){const action=m[1],id=Number(m[2]);ensure(id);await ctx.answerCbQuery();if(action==="toggle")set(id,"enabled",get(id,"enabled")==="1"?"0":"1");if(action==="links")set(id,"remove_links",get(id,"remove_links")==="1"?"0":"1");if(action==="reset")reset(id);return ctx.editMessageText(card(id),settingsKeyboard(id));}

      m=/^ls_(delay|keywords|ban|signature|replace)_(\d+)$/.exec(data);
      if(m){const id=Number(m[2]),key={delay:"delay",keywords:"keywords",ban:"ban_words",signature:"signature",replace:"replacements"}[m[1]];state.set(ctx.from.id,{type:"link_setting",linkId:id,key});await ctx.answerCbQuery();return ctx.reply(`${key==="delay"?"⏱ Задержка":labels[key]}\n\n${key==="delay"?"Отправь число секунд от 0 до 3600.":"Отправь новое значение. Для очистки отправь: -"}`,Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад",`ls_open_${id}`)]]));}

      const st=state.get(ctx.from.id);
      if(st?.type==="link_setting" && ctx.message?.text){const v=text.trim(),id=st.linkId,key=st.key;if(key==="delay"){const n=Number(v);if(!Number.isFinite(n)||n<0||n>3600)return ctx.reply("❌ Введи число от 0 до 3600.");set(id,key,Math.floor(n));}else set(id,key,["-","нет","очистить"].includes(v.toLowerCase())?"":v);state.delete(ctx.from.id);return ctx.reply("✅ Настройка связки сохранена.",Markup.inlineKeyboard([[Markup.button.callback("⚙️ Открыть связку",`ls_open_${id}`)]]));}
      return next();
    };
    return originalUse.call(this,middleware,...middlewares);
  };
  Composer.prototype.__linkSettingsPatch=true;
}
