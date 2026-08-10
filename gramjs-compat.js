// Compatibility shim for GramJS 2.26.x.
// The project imports `events` from `telegram`, while current GramJS
// exposes event builders from `telegram/events` instead.
const Module = require("module");
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const mod = originalLoad.apply(this, arguments);
  if (request === "telegram" && mod && !mod.events) {
    mod.events = require("telegram/events");
  }
  return mod;
};
