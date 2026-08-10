// Direct entrypoint.
// Startup helpers are loaded before core so the stable core remains unchanged.
require("./startup-fix.js");
require("./language.js");
require("./links-ui-fix.js");
require("./link-settings-live2.js");
require("./core.js");
