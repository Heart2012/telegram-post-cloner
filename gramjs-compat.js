// GramJS 2.26.x compatibility shim.
// The application uses `const { TelegramClient, events } = require("telegram")`,
// while GramJS exposes event builders from `telegram/events`.
const Module = require("module");
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const mod = originalLoad.apply(this, arguments);

  if (request === "telegram" && mod && !mod.events) {
    const eventModule = originalLoad.call(this, "telegram/events", parent, isMain);

    // Normal CommonJS export object.
    try {
      Object.defineProperty(mod, "events", {
        value: eventModule,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return mod;
    } catch (_) {
      // Some package builds may expose a non-extensible export object.
    }

    // Fallback: return a proxy that exposes the missing `events` property.
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
