// Direct entrypoint.
// Keep startup minimal: the core already contains the bot handlers.
// The extra link runtime monkey-patched Telegraf and could prevent handlers from working.
require("./startup-fix.js");
require("./language.js");
require("./core.js");
