// Hostinger startup guard.
// The latest MTProto session is persisted in the SQLite database.
// Ignore a legacy MT_SESSION environment variable so an old session
// cannot override the freshly authorized session stored in the DB.
if (process.env.MT_SESSION) {
  console.log("Ignoring legacy MT_SESSION environment variable; using persistent DB session.");
  delete process.env.MT_SESSION;
}

// Ukrainian interface layer.
// index.js contains the original Russian UI text. This layer translates
// outgoing bot messages and keyboard buttons without changing the cloner logic.
try {
  const { Context, Markup } = require("telegraf");

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
    ["Формат: /unlink 3", "Формат: /unlink 3"],
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
    ["Формат: 1 2", "Формат: 1 2"],
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
    ["Формат: /replace старое -> новое", "Формат: /replace старе -> нове"]
  ];

  function translate(value) {
    if (typeof value !== "string") return value;
    let result = value;
    for (const [from, to] of replacements) {
      result = result.split(from).join(to);
    }
    return result;
  }

  function translateExtra(extra) {
    if (!extra || typeof extra !== "object") return extra;
    if (!extra.reply_markup) return extra;

    const copy = { ...extra };
    const markup = extra.reply_markup;

    if (Array.isArray(markup.keyboard)) {
      copy.reply_markup = {
        ...markup,
        keyboard: markup.keyboard.map(row =>
          row.map(button =>
            typeof button === "string"
              ? translate(button)
              : button
          )
        )
      };
    }

    return copy;
  }

  if (Context?.prototype?.reply) {
    const originalReply = Context.prototype.reply;
    Context.prototype.reply = function (text, extra) {
      return originalReply.call(
        this,
        translate(text),
        translateExtra(extra)
      );
    };
  }

  if (Markup?.keyboard) {
    const originalKeyboard = Markup.keyboard;
    Markup.keyboard = function (keyboard, ...args) {
      const translated = Array.isArray(keyboard)
        ? keyboard.map(row =>
            Array.isArray(row)
              ? row.map(button =>
                  typeof button === "string"
                    ? translate(button)
                    : button
                )
              : row
          )
        : keyboard;

      return originalKeyboard.call(
        this,
        translated,
        ...args
      );
    };
  }

  console.log("Ukrainian Telegram UI translation layer loaded.");
} catch (e) {
  console.error(
    "Ukrainian UI translation layer error:",
    e?.message || e
  );
}
