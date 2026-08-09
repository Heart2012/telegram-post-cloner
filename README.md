# Telegram Post Cloner — Node.js

Версия для Hostinger Node.js Hosting.

## Возможности
- Каналы и группы как источники и приёмники.
- Несколько связок источник → приёмник.
- Динамическое добавление источников без перезапуска.
- Текст, фото, видео, документы, аудио, GIF и альбомы.
- Фильтры, замены, подпись, удаление ссылок.
- Задержка публикации.
- Защита от дублей.
- SQLite.
- Управление через Telegram-бота.

## Установка
```bash
npm install
npm start
```

Node.js 20 или 22 рекомендуется.

## Переменные окружения
```env
API_ID=123456
API_HASH=xxxxxxxx
BOT_TOKEN=123456:ABC
ADMIN_IDS=123456789
SESSION_NAME=telegram-cloner
PORT=3000
DB_PATH=cloner.db
```

API ID/HASH: https://my.telegram.org
BOT TOKEN: @BotFather

При первом запуске потребуется авторизация Telegram-аккаунта. Будет создан `.session` файл.

## Меню
📥 Источники
📤 Приёмники
🔗 Связки
⚙️ Настройки
📊 Статистика
❓ Помощь

Команды:
`/start`, `/cancel`, `/id`, `/unlink 3`,
`/links_on`, `/links_off`,
`/delay 5`, `/delay_clear`,
`/signature Текст`, `/signature_clear`,
`/keywords слово1, слово2`, `/keywords_clear`,
`/ban_words слово1, слово2`, `/ban_words_clear`,
`/replace старое -> новое`, `/replace_clear`

Важно: обычный Web Hosting должен держать Node.js процесс постоянно. Если Hostinger останавливает долгоживущие процессы, потребуется VPS.
