// Direct entrypoint.
// Load the stable language/link runtime and then the cloner core.
require("./startup-fix.js");
require("./language.js");
require("./link-settings.js");
require("./link-runtime.js");
require("./core.js");
