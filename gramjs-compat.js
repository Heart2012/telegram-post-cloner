// GramJS 2.26.x compatibility shim.
// The application uses `const { TelegramClient, events } = require("telegram")`,
// while GramJS exposes event builders from `telegram/events`.
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

  if (request === "telegram" && mod && !mod.events) {
    const eventModule = originalLoad.call(this, "telegram/events", parent, isMain);

    try {
      Object.defineProperty(mod, "events", {
        value: eventModule,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return mod;
    } catch (_) {}

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
