// When has the Discord bot been down long enough that only a fresh process will fix it.
//
// ─── WHY THERE IS NO IN-PROCESS RECONNECT ─────────────────────────────────────
// There was one, for about an hour, and it did not work. A discord.js 14.26 Client cannot be
// revived once its connection has failed — measured directly against the real gateway, twice:
//
//   login() -> READY -> destroy() -> login()      login() RESOLVES, never reaches READY
//   login(bad) -> rejects -> login(good)          login() RESOLVES, never reaches READY
//
// Both leave a client that reports success and then sits there not ready, forever. That is
// what the first attempt at this shipped: a watchdog that dutifully noticed the bot was down
// every two minutes, called destroy() and login(), saw login() resolve, congratulated itself
// by resetting its counters, and looped — which is exactly how the logs read, the same
// "offline for 2 checks" line over and over with no connection ever coming back.
//
// The lesson worth keeping: that code was shipped on a probe that only ever exercised the
// FAILURE path (destroy + login with an invalid token, which reaches token validation and
// rejects). Watching the error arrive proved the call was reachable and proved nothing at all
// about whether it works. The success path is the one that had to be tested.
//
// So recovery is a fresh process. pm2 has autorestart on, express-session is backed by
// SQLite so nobody is logged out by a restart, and a restart has recovered the bot every
// single time it has been tried. Exiting is not a workaround here — it is the only mechanism
// that actually reconnects.

// How many consecutive 60s checks of "not ready" before handing the process back to pm2.
// Generous on purpose. discord.js recovers from ordinary blips on its own within seconds, so
// anything short-lived never gets here; ten minutes of continuous silence means it has truly
// given up. It is also the restart rate during a long Discord outage — roughly six an hour,
// a few seconds of downtime each — so making it much smaller trades a dead bot for a hub
// that keeps interrupting its own scraping.
const OFFLINE_CHECKS_BEFORE_RESTART = 10;

// The watchdog's one decision, kept out of the timer so it is readable and testable rather
// than three conditions buried in a setInterval.
//
//   ready               client.isReady() — a live gateway session
//   consecutiveNotReady how many checks in a row have seen ready === false
function shouldRestartProcess({ ready, consecutiveNotReady, ticksBeforeRestart = OFFLINE_CHECKS_BEFORE_RESTART }) {
    if (ready) return false;
    return consecutiveNotReady >= ticksBeforeRestart;
}

module.exports = { shouldRestartProcess, OFFLINE_CHECKS_BEFORE_RESTART };
