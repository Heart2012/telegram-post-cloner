// Hostinger startup guard + per-user Russian/Ukrainian interface.
// The cloner logic in index.js is intentionally left unchanged.
// Language preference is stored separately in ~/.telegram-post-cloner/languages.json.

try {
  const fs = require("fs");
  const path = require("path");
  const { Context, Markup, Composer } = require("telegraf");

  const persistentDir = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
  fs.mkdirSync(persistentDir, { recursive: true });
  const LANG_FILE = path.join(persistentDir, "languages.json");

  let languages = {};
  try { languages = JSON.parse(fs.readFileSync(LANG_FILE, "utf8")) || {}; } catch (_) { languages = {}; }
  const saveLanguages = () => {
    try { fs.writeFileSync(LANG_FILE, JSON.stringify(languages, null, 2), "utf8"); } catch (_) {}
  };

  const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean).map(Number));
  const isAdmin = id => ADMIN_IDS.has(Number(id));
  const getLang = id => languages[String(id)] === "ru" ? "ru" : "uk";
  const setLang = (id, lang) => { languages[String(id)] = lang === "ru" ? "ru" : "uk"; saveLanguages(); };

  const replacements = [
    ["Заполни API_ID, API_HASH, BOT_TOKEN и ADMIN_IDS.", "Заповни API_ID, API_HASH, BOT_TOKEN та ADMIN_IDS."],
    ["Пустая ссылка/username.", "Порожнє посилання або username."],
    ["Не удалось найти Telegram-чат. Проверь username/ссылку и доступ аккаунта.", "Не вдалося знайти Telegram-чат. Перевір username або посилання та доступ акаунта."],
    ["Telegram ещё не авторизован. Открой /auth.", "Telegram ще не авторизований. Відкрий /auth."],
    ["Не удалось определить источник пересланного сообщения. Перешли сообщение именно из канала/группы.", "Не вдалося визначити джерело пересланого повідомлення. Перешли повідомлення саме з каналу або групи."],
    ["Не удалось определить ID чата.", "Не вдалося визначити ID чату."],
    ["Telegram Post Cloner\n\nВыбери раздел.", "Telegram Post Cloner\n\nОберіть розділ."],
    ["❌ Отменено.", "❌ Скасовано."],
    ["❌ Telegram не авторизован.", "❌ Telegram не авторизований."],
    ["Telegram авторизован.", "Telegram авторизований."],
    ["Session недоступна.", "Сесія недоступна."],
    ["Секретная строка. Не отправляй её другим людям и после копирования удали это сообщение.", "Це секретний рядок. Не передавай його іншим людям. Після копіювання видали це повідомлення."],
    ["📥 Источники", "📥 Джерела"],
    ["📤 Приёмники", "📤 Приймачі"],
    ["🔗 Связки", "🔗 Зв’язки"],
    ["⚙️ Настройки", "⚙️ Налаштування"],
    ["📊 Статистика", "📊 Статистика"],
    ["❓ Помощь", "❓ Допомога"],
    ["Нет источников.", "Немає джерел."],
    ["Нет приёмников.", "Немає приймачів."],
    ["Нет связок.", "Немає зв’язків."],
    ["Можешь отправить @username или ссылку.", "Можеш надіслати @username або посилання."],
    ["Или просто ПЕРЕШЛИ сюда любое сообщение из нужного канала.", "Або просто ПЕРЕШЛИ сюди будь-яке повідомлення з потрібного каналу."],
    ["Или просто ПЕРЕШЛИ сюда любое сообщение из нужного канала/группы.", "Або просто ПЕРЕШЛИ сюди будь-яке повідомлення з потрібного каналу або групи."],
    ["Создать: 1 2", "Створити: 1 2"],
    ["Удалить: /unlink ID", "Видалити: /unlink ID"],
    ["Связка создана.", "Зв’язок створено."],
    ["Связка ", "Зв’язок "],
    [" удалена.", " видалено."],
    ["⚙️ Настройки\nУдалять ссылки:", "⚙️ Налаштування\nВидалення посилань:"],
    ["Задержка:", "Затримка:"],
    ["Белый фильтр:", "Білий фільтр:"],
    ["Чёрный фильтр:", "Чорний фільтр:"],
    ["Подпись:", "Підпис:"],
    ["Замены:", "Заміни:"],
    ["нет", "немає"],
    ["Включено.", "Увімкнено."],
    ["Отключено.", "Вимкнено."],
    ["Задержка сохранена.", "Затримку збережено."],
    ["Задержка отключена.", "Затримку вимкнено."],
    ["Подпись сохранена.", "Підпис збережено."],
    ["Подпись отключена.", "Підпис вимкнено."],
    ["Фильтр сохранён.", "Фільтр збережено."],
    ["Фильтр очищен.", "Фільтр очищено."],
    ["Чёрный фильтр сохранён.", "Чорний фільтр збережено."],
    ["Чёрный фильтр очищен.", "Чорний фільтр очищено."],
    ["Замена добавлена.", "Заміну додано."],
    ["Замены очищены.", "Заміни очищено."],
    ["Источник не найден.", "Джерело не знайдено."],
    ["Приёмник не найден.", "Приймач не знайдено."],
    ["📊 Статистика\n\n📥 Источников:", "📊 Статистика\n\n📥 Джерел:"],
    ["📤 Приёмников:", "📤 Приймачів:"],
    ["🔗 Связок:", "🔗 Зв’язків:"],
    ["📨 Скопировано:", "📨 Скопійовано:"],
    ["❓ Добавь источник, приёмник и связку. После этого новые посты копируются автоматически.", "❓ Додай джерело, приймач і зв’язок. Після цього нові публікації копіюватимуться автоматично."],
    ["/status — статус Telegram", "/status — статус Telegram"],
    ["/session — получить MT_SESSION для Hostinger", "/session — отримати MT_SESSION для Hostinger"],
    ["Источник добавлен.", "Джерело додано."],
    ["Приёмник добавлен.", "Приймач додано."],
    ["Формат: /replace старое -> новое", "Формат: /replace старе -> нове"],
    ["Формат: /delay 5", "Формат: /delay 5"],
    ["Формат: /signature Текст", "Формат: /signature Текст"]
  ];

  const ukToRu = new Map(replacements.map(([ru, uk]) => [uk, ru]));

  function translate(value, lang) {
    if (typeof value !== "string" || lang === "ru") return value;
    let result = value;
    for (const [from, to] of replacements) result = result.split(from).join(to);
    return result;
  }

  function mainKeyboard(lang) {
    const rows = lang === "ru"
      ? [["📥 Источники", "📤 Приёмники"], ["🔗 Связки", "⚙️ Настройки"], ["📊 Статистика", "❓ Помощь"]]
      : [["📥 Джерела", "📤 Приймачі"], ["🔗 Зв’язки", "⚙️ Налаштування"], ["📊 Статистика", "❓ Допомога"]];
    rows.push(["🌐 Мова / Язык"]);
    return Markup.keyboard(rows).resize().persistent();
  }

  function languageKeyboard() {
    return Markup.keyboard([["🇺🇦 Українська", "🇷🇺 Русский"], ["↩️ Назад"]]).resize().persistent();
  }

  function translateExtra(extra, lang) {
    if (!extra || typeof extra !== "object" || !extra.reply_markup) return extra;
    const copy = { ...extra };
    const markup = extra.reply_markup;
    if (Array.isArray(markup.keyboard)) {
      const containsLanguageChoice = markup.keyboard.some(row => row.some(button => button === "🇺🇦 Українська" || button === "🇷🇺 Русский"));
      if (containsLanguageChoice) return copy;
      const keyboard = markup.keyboard.map(row => row.map(button =>
        typeof button === "string" ? translate(button, lang) : button
      ));
      if (!keyboard.some(row => row.some(button => button === "🌐 Мова / Язык"))) keyboard.push(["🌐 Мова / Язык"]);
      copy.reply_markup = { ...markup, keyboard };
    }
    return copy;
  }

  if (Context?.prototype?.reply) {
    const originalReply = Context.prototype.reply;
    Context.prototype.reply = function (text, extra) {
      const lang = getLang(this.from?.id);
      return originalReply.call(this, translate(text, lang), translateExtra(extra, lang));
    };
  }

  const normalizeIncomingText = ctx => {
    const text = ctx?.message?.text;
    if (!text || typeof text !== "string") return text;
    const lang = getLang(ctx.from?.id);
    if (lang !== "uk") return text;
    if (ukToRu.has(text)) {
      ctx.message.text = ukToRu.get(text);
      return ctx.message.text;
    }
    const direct = {
      "📥 Джерела": "📥 Источники",
      "📤 Приймачі": "📤 Приёмники",
      "🔗 Зв’язки": "🔗 Связки",
      "⚙️ Налаштування": "⚙️ Настройки",
      "📊 Статистика": "📊 Статистика",
      "❓ Допомога": "❓ Помощь"
    };
    if (direct[text]) ctx.message.text = direct[text];
    return ctx.message.text;
  };

  const languageButton = "🌐 Мова / Язык";
  const ukButton = "🇺🇦 Українська";
  const ruButton = "🇷🇺 Русский";
  const backButton = "↩️ Назад";

  if (Composer?.prototype?.use) {
    const originalUse = Composer.prototype.use;
    Composer.prototype.use = function (...middlewares) {
      if (!this.__languageMiddlewareInstalled) {
        this.__languageMiddlewareInstalled = true;
        const languageMiddleware = async (ctx, next) => {
          if (!ctx.from || !isAdmin(ctx.from.id)) return next();
          const text = ctx.message?.text;
          if (text === languageButton || text === "🌐 Мова" || text === "🌐 Язык") {
            const lang = getLang(ctx.from.id);
            return ctx.reply(lang === "uk" ? "🌐 Оберіть мову:" : "🌐 Выберите язык:", languageKeyboard());
          }
          if (text === ukButton) {
            setLang(ctx.from.id, "uk");
            return ctx.reply("✅ Мову змінено на українську.", mainKeyboard("uk"));
          }
          if (text === ruButton) {
            setLang(ctx.from.id, "ru");
            return ctx.reply("✅ Язык изменён на русский.", mainKeyboard("ru"));
          }
          if (text === backButton) {
            const lang = getLang(ctx.from.id);
            return ctx.reply(lang === "uk" ? "↩️ Головне меню." : "↩️ Главное меню.", mainKeyboard(lang));
          }
          normalizeIncomingText(ctx);
          return next();
        };
        return originalUse.call(this, languageMiddleware, ...middlewares);
      }
      return originalUse.apply(this, middlewares);
    };
  }

  console.log("Language switcher loaded: Ukrainian default, Russian available.");
} catch (e) {
  console.error("Language switcher error:", e?.message || e);
}
