// Startup helper + reliable per-user Ukrainian/Russian interface.
// The cloner logic in index.js is not changed.

try {
  const fs = require("fs");
  const path = require("path");
  const { Telegraf } = require("telegraf");

  const persistentDir = path.join(process.env.HOME || process.cwd(), ".telegram-post-cloner");
  fs.mkdirSync(persistentDir, { recursive: true });
  const LANG_FILE = path.join(persistentDir, "languages.json");

  let languages = {};
  try {
    languages = JSON.parse(fs.readFileSync(LANG_FILE, "utf8")) || {};
  } catch (_) {
    languages = {};
  }

  function saveLanguages() {
    try {
      fs.writeFileSync(LANG_FILE, JSON.stringify(languages, null, 2), "utf8");
    } catch (e) {
      console.error("Language save error:", e?.message || e);
    }
  }

  function getLang(id) {
    return languages[String(id)] === "ru" ? "ru" : "uk";
  }

  function setLang(id, lang) {
    languages[String(id)] = lang === "ru" ? "ru" : "uk";
    saveLanguages();
  }

  const ADMIN_IDS = new Set(
    (process.env.ADMIN_IDS || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
      .map(Number)
  );

  function isAdmin(id) {
    return ADMIN_IDS.has(Number(id));
  }

  const translations = [
    ["Telegram Post Cloner\n\nВыбери раздел.", "Telegram Post Cloner\n\nОберіть розділ."],
    ["❌ Отменено.", "❌ Скасовано."],
    ["Ваш ID:", "Ваш ID:"],
    ["❌ Telegram не авторизован.", "❌ Telegram не авторизований."],
    ["✅ Telegram авторизован.", "✅ Telegram авторизований."],
    ["❌ Ошибка:", "❌ Помилка:"],
    ["❌ Session недоступна.", "❌ Сесія недоступна."],
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
    ["/session — получить MT_SESSION для Hostinger", "/session — отримати MT_SESSION для Hostinger"],
    ["Источник добавлен.", "Джерело додано."],
    ["Приёмник добавлен.", "Приймач додано."],
    ["Формат: /replace старое -> новое", "Формат: /replace старе -> нове"],
    ["Формат: /replace старое -> новое", "Формат: /replace старе -> нове"],
    ["Формат: /delay 5", "Формат: /delay 5"],
    ["Формат: /signature Текст", "Формат: /signature Текст"],
    ["Пустая ссылка/username.", "Порожнє посилання або username."],
    ["Не удалось найти Telegram-чат. Проверь username/ссылку и доступ аккаунта.", "Не вдалося знайти Telegram-чат. Перевір username або посилання та доступ акаунта."],
    ["Telegram ещё не авторизован. Открой /auth.", "Telegram ще не авторизований. Відкрий /auth."],
    ["Не удалось определить источник пересланного сообщения. Перешли сообщение именно из канала/группы.", "Не вдалося визначити джерело пересланого повідомлення. Перешли повідомлення саме з каналу або групи."],
    ["Не удалось определить ID чата.", "Не вдалося визначити ID чату."]
  ];

  function translate(text, lang) {
    if (typeof text !== "string" || lang === "ru") return text;
    let result = text;
    for (const [from, to] of translations) {
      result = result.split(from).join(to);
    }
    return result;
  }

  const inputMap = {
    "📥 Джерела": "📥 Источники",
    "📤 Приймачі": "📤 Приёмники",
    "🔗 Зв’язки": "🔗 Связки",
    "⚙️ Налаштування": "⚙️ Настройки",
    "📊 Статистика": "📊 Статистика",
    "❓ Допомога": "❓ Помощь"
  };

  function translateKeyboard(markup, lang) {
    if (!markup || !Array.isArray(markup.keyboard)) return markup;

    const keyboard = markup.keyboard.map(row =>
      row.map(button => {
        if (typeof button !== "string") return button;
        return translate(button, lang);
      })
    );

    const languageButton = "🌐 Мова / Язык";
    if (!keyboard.some(row => row.includes(languageButton))) {
      keyboard.push([languageButton]);
    }

    return { ...markup, keyboard };
  }

  function patchContext(ctx) {
    if (!ctx || ctx.__languagePatched) return;
    ctx.__languagePatched = true;

    const lang = getLang(ctx.from?.id);
    const originalReply = ctx.reply.bind(ctx);

    ctx.reply = (text, extra) => {
      let translatedExtra = extra;
      if (extra?.reply_markup) {
        translatedExtra = {
          ...extra,
          reply_markup: translateKeyboard(extra.reply_markup, lang)
        };
      }
      return originalReply(translate(text, lang), translatedExtra);
    };
  }

  const originalUse = Telegraf.prototype.use;
  let languageMiddlewareInstalled = false;

  Telegraf.prototype.use = function (...middlewares) {
    if (!languageMiddlewareInstalled) {
      languageMiddlewareInstalled = true;

      const languageMiddleware = async (ctx, next) => {
        if (!ctx.from || !isAdmin(ctx.from.id)) return next();

        patchContext(ctx);

        const text = ctx.message?.text;

        if (text === "🌐 Мова / Язык" || text === "🌐 Мова" || text === "🌐 Язык") {
          const lang = getLang(ctx.from.id);
          return ctx.reply(
            lang === "uk" ? "🌐 Оберіть мову:" : "🌐 Выберите язык:",
            {
              reply_markup: {
                keyboard: [
                  ["🇺🇦 Українська", "🇷🇺 Русский"],
                  ["↩️ Назад"]
                ],
                resize_keyboard: true,
                is_persistent: true
              }
            }
          );
        }

        if (text === "🇺🇦 Українська") {
          setLang(ctx.from.id, "uk");
          return ctx.reply("✅ Мову змінено на українську.", {
            reply_markup: {
              keyboard: [
                ["📥 Джерела", "📤 Приймачі"],
                ["🔗 Зв’язки", "⚙️ Налаштування"],
                ["📊 Статистика", "❓ Допомога"],
                ["🌐 Мова / Язык"]
              ],
              resize_keyboard: true,
              is_persistent: true
            }
          });
        }

        if (text === "🇷🇺 Русский") {
          setLang(ctx.from.id, "ru");
          return ctx.reply("✅ Язык изменён на русский.", {
            reply_markup: {
              keyboard: [
                ["📥 Источники", "📤 Приёмники"],
                ["🔗 Связки", "⚙️ Настройки"],
                ["📊 Статистика", "❓ Помощь"],
                ["🌐 Мова / Язык"]
              ],
              resize_keyboard: true,
              is_persistent: true
            }
          });
        }

        if (text === "↩️ Назад") {
          const lang = getLang(ctx.from.id);
          return ctx.reply(
            lang === "uk" ? "↩️ Головне меню." : "↩️ Главное меню.",
            {
              reply_markup: {
                keyboard: lang === "uk"
                  ? [
                      ["📥 Джерела", "📤 Приймачі"],
                      ["🔗 Зв’язки", "⚙️ Налаштування"],
                      ["📊 Статистика", "❓ Допомога"],
                      ["🌐 Мова / Язык"]
                    ]
                  : [
                      ["📥 Источники", "📤 Приёмники"],
                      ["🔗 Связки", "⚙️ Настройки"],
                      ["📊 Статистика", "❓ Помощь"],
                      ["🌐 Мова / Язык"]
                    ],
                resize_keyboard: true,
                is_persistent: true
              }
            }
          );
        }

        if (inputMap[text]) {
          ctx.message.text = inputMap[text];
        }

        return next();
      };

      return originalUse.call(this, languageMiddleware, ...middlewares);
    }

    return originalUse.apply(this, middlewares);
  };

  console.log("Language interface loaded: Ukrainian default, Russian switch available.");
} catch (e) {
  console.error("Language interface error:", e?.message || e);
}
