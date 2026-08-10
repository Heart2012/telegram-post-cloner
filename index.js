// Direct entrypoint: always load the language and button-based link UI before the cloner core.
// This also fixes deployments that start the bot with `node index.js` instead of `npm start`.
require("./startup-fix.js");
require("./language.js");
require("./link-settings.js");
require("./link-runtime.js");
require("./force-link-ui.js");
require("./core.js");
