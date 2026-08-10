// Prevent Telegraf startup/network waiting from blocking the MTProto session restore.
// The main core currently awaits bot.launch() before connectSavedSession().
// On some hosts that await can remain pending, so Telegram never gets restored.
const { Telegraf } = require("telegraf");

if (!Telegraf.prototype.__postClonerNonBlockingLaunch) {
  const originalLaunch = Telegraf.prototype.launch;
  Telegraf.prototype.launch = function (...args) {
    const promise = originalLaunch.apply(this, args);
    Promise.resolve(promise).catch(err => {
      console.error("TELEGRAM BOT LAUNCH ERROR:", err?.stack || err?.message || err);
    });
    // Let core.js continue immediately to restore the MTProto user session.
    return Promise.resolve();
  };
  Telegraf.prototype.__postClonerNonBlockingLaunch = true;
}

console.log("Startup order fix loaded: MTProto session restore will not wait for bot polling.");
