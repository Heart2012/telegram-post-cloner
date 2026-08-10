// Direct entrypoint.
// Startup helpers are loaded before core so the stable core remains unchanged.
require("./startup-fix.js");
require("./language.js");
require("./link-settings-live.js");
require("./core.js");
