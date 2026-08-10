const fs = require("fs");
const path = require("path");
const { Context, Composer, Markup } = require("telegraf");

const DIR = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
const FILE = path.join(DIR, "language.json");
let langs = {};
try { langs = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (_) {}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(langs, null, 2), "utf8"); } catch (_) {} }
function lang(id) { return langs[String(id)] === "ru" ? "ru" : "uk"; }
function setLang(id, value) { langs[String(id)] = value === "ru" ? "ru" : "uk"; save(); }

const RU_UK = [
  ["🤖 Telegram Post Cloner\n\nВыбери раздел.", "🤖 Telegram Post Cloner\n\nОберіть розділ."],
  ["📥 Источники", "📥 Джерела"], ["📤 Приёмники", "📤 Приймачі"],
  ["🔗 Связки", "🔗 Зв’язки"], ["⚙️ Настройки", "⚙️ Налаштування"],
  ["📊 Статистика", "📊 Статистика"], ["❓ Помощь", "❓ Допомога"],
  ["➕ Создать связку", "➕ Створити зв’язок"], ["🗑 Удалить связку", "🗑 Видалити зв’язок"],
  ["🔄 Обновить", "🔄 Оновити"], ["⬅️ Назад", "⬅️ Назад"], ["❌ Отмена", "❌ Скасувати"],
  ["❌ Отменить", "❌ Скасувати"], ["🇺🇦 Украинский", "🇺🇦 Українська"],
  ["🌐 Язык", "🌐 Мова"], ["🌐 Мова / Язык", "🌐 Мова / Язык"],
  ["Выбери действие:", "Оберіть дію:"], ["Выбери источник:", "Оберіть джерело:"],
  ["Выбери приёмник:", "Оберіть приймач:"], ["Выбери язык:", "Оберіть мову:"],
  ["1️⃣ Выбери источник:", "1️⃣ Оберіть джерело:"], ["2️⃣ Выбери приёмник:", "2️⃣ Оберіть приймач:"],
  ["Создание связки", "Створення зв’язку"], ["Связка создана!", "Зв’язок створено!"],
  ["Связка удалена", "Зв’язок видалено"], ["Нет связок.", "Немає зв’язків."],
  ["Нет связок для удаления.", "Немає зв’язків для видалення."],
  ["Сначала добавь хотя бы один источник.", "Спочатку додайте хоча б одне джерело."],
  ["Сначала добавь хотя бы один приёмник.", "Спочатку додайте хоча б один приймач."],
  ["Сессия создания связки устарела. Нажми «🔗 Связки» ещё раз.", "Сесія створення зв’язку застаріла. Натисніть «🔗 Зв’язки» ще раз."],
  ["Источник не найден.", "Джерело не знайдено."], ["Приёмник не найден.", "Приймач не знайдено."],
  ["Отменено.", "Скасовано."], ["Создание связки отменено.", "Створення зв’язку скасовано."],
  ["Удалять ссылки:", "Видаляти посилання:"], ["Задержка:", "Затримка:"],
  ["Белый фильтр:", "Білий фільтр:"], ["Чёрный фильтр:", "Чорний фільтр:"],
  ["Подпись:", "Підпис:"], ["Замены:", "Заміни:"], ["Включено.", "Увімкнено."],
  ["Отключено.", "Вимкнено."], ["Задержка сохранена.", "Затримку збережено."],
  ["Задержка отключена.", "Затримку вимкнено."], ["Подпись сохранена.", "Підпис збережено."],
  ["Подпись отключена.", "Підпис вимкнено."], ["Фильтр сохранён.", "Фільтр збережено."],
  ["Фильтр очищен.", "Фільтр очищено."], ["Чёрный фильтр сохранён.", "Чорний фільтр збережено."],
  ["Чёрный фильтр очищен.", "Чорний фільтр очищено."], ["Замена добавлена.", "Заміну додано."],
  ["Замены очищены.", "Заміни очищено."], ["Нет источников.", "Немає джерел."],
  ["Нет приёмников.", "Немає приймачів."], ["Можешь отправить @username или ссылку.", "Можете надіслати @username або посилання."],
  ["Или просто ПЕРЕШЛИ сюда любое сообщение из нужного канала.", "Або просто ПЕРЕШЛІТЬ сюди будь-яке повідомлення з потрібного каналу."],
  ["❌ Telegram не авторизован.", "❌ Telegram не авторизований."], ["Telegram авторизован.", "Telegram авторизований."],
  ["Ошибка:", "Помилка:"], ["Источник добавлен.", "Джерело додано."], ["Приёмник добавлен.", "Приймач додано."],
  ["Добавь источник, приёмник и связку. После этого новые посты копируются автоматически.", "Додайте джерело, приймач і зв’язок. Після цього нові публікації копіюватимуться автоматично."],
  ["Мову змінено на українську.", "Язык изменён на русский."],
  ["Язык изменён на русский.", "Мову змінено на українську."],
  ["↩️ Главное меню.", "↩️ Головне меню."],
  ["❌ Нет связок для удаления.", "❌ Немає зв’язків для видалення."]
];

const toUk = new Map(RU_UK);
const toRu = new Map(RU_UK.map(([ru, uk]) => [uk, ru]));
function tr(value, l) {
  if (typeof value !== "string") return value;
  const map = l === "uk" ? toUk : toRu;
  let out = value;
  for (const [a, b] of map) out = out.split(a).join(b);
  return out;
}

const LANG = "🌐 Мова / Язык";
const UK = "🇺🇦 Українська";
const RU = "🇷🇺 Русский";
const BACK = "⬅️ Назад";
function languageKeyboard() { return Markup.keyboard([[UK, RU], [BACK]]).resize().persistent(); }
function addLanguageButton(extra, l) {
  if (!extra || !extra.reply_markup || !Array.isArray(extra.reply_markup.keyboard)) return extra;
  const copy = { ...extra, reply_markup: { ...extra.reply_markup } };
  const keyboard = extra.reply_markup.keyboard.map(row => row.map(b => typeof b === "string" ? tr(b, l) : b));
  if (!keyboard.some(row => row.includes(LANG))) keyboard.push([LANG]);
  copy.reply_markup.keyboard = keyboard;
  return copy;
}

if (Context.prototype.reply && !Context.prototype.__postClonerLanguage) {
  const originalReply = Context.prototype.reply;
  Context.prototype.reply = function(text, extra) {
    const l = lang(this.from?.id);
    return originalReply.call(this, tr(text, l), addLanguageButton(extra, l));
  };
  Context.prototype.__postClonerLanguage = true;
}

if (!Composer.prototype.__postClonerLanguage) {
  const originalUse = Composer.prototype.use;
  Composer.prototype.use = function(...middlewares) {
    if (!this.__postClonerLanguageMiddleware) {
      this.__postClonerLanguageMiddleware = true;
      const languageMiddleware = async (ctx, next) => {
        const text = ctx.message?.text;
        if (text === LANG || text === "🌐 Язык" || text === "🌐 Мова") {
          return ctx.reply(lang(ctx.from?.id) === "uk" ? "🌐 Оберіть мову:" : "🌐 Выберите язык:", languageKeyboard());
        }
        if (text === UK) {
          setLang(ctx.from?.id, "uk");
          return ctx.reply("Мову змінено на українську.");
        }
        if (text === RU) {
          setLang(ctx.from?.id, "ru");
          return ctx.reply("Язык изменён на русский.");
        }
        if (text === BACK) {
          return ctx.reply(lang(ctx.from?.id) === "uk" ? "↩️ Головне меню." : "↩️ Главное меню.");
        }
        if (text && lang(ctx.from?.id) === "uk") ctx.message.text = tr(text, "ru");
        return next();
      };
      return originalUse.call(this, languageMiddleware, ...middlewares);
    }
    return originalUse.apply(this, middlewares);
  };
  Composer.prototype.__postClonerLanguage = true;
}

module.exports = { lang, setLang, tr };
