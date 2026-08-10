// GramJS 2.26.x compatibility shim.
// Expose event builders as `require("telegram").events` for legacy code.
const Module = require("module");
const path = require("path");
const fs = require("fs");

// Hostinger creates a new version directory on each deployment.
// Keep the SQLite database (and therefore the saved MTProto session)
// outside the version directory so redeployments do not log the account out.
if (!process.env.DB_PATH) {
  const base = process.env.HOME || process.cwd();
  const dir = path.join(base, ".telegram-post-cloner");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  process.env.DB_PATH = path.join(dir, "cloner.db");
}

const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const mod = originalLoad.apply(this, arguments);

  if (request === "telegram" && mod) {
    let eventModule;
    try {
      eventModule = originalLoad.call(this, "telegram/events", parent, isMain);
    } catch (e) {
      console.error("GramJS events compatibility load error:", e);
      return mod;
    }

    // Most GramJS versions return an extensible CommonJS export object.
    // Assign directly first so destructuring `const { events } = require("telegram")`
    // receives the event module.
    try {
      mod.events = eventModule;
      if (mod.events === eventModule) return mod;
    } catch (_) {}

    // Fallback for a non-extensible export object.
    return new Proxy(mod, {
      get(target, prop, receiver) {
        if (prop === "events") return eventModule;
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (prop === "events") return true;
        return Reflect.has(target, prop);
      },
    });
  }

  return mod;
};
