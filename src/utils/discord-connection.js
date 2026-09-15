// When may the hub try to reconnect its Discord bot, and how long should it wait first.
//
// THE FAILURE THIS EXISTS FOR (2026-09-15): the bot connected normally at 14:41 and was
// dead by 15:46 — `!bio` came back "Expected token to be set for this request, but none was
// present", which is discord.js saying the client had been torn down underneath us. Discord's
// gateway had been answering 503, and once discord.js gives up on a session it does not come
// back on its own. The hub's entire reconnection strategy was one `.catch()` on the initial
// login that printed a line and returned, so the process kept running, kept scraping, kept
// serving the web UI, and quietly announced nothing at all. Nobody found out until someone
// typed a command an hour later.
//
// The logic lives here, apart from the client, because every rule below is a judgement call
// worth being able to test: too eager a reconnect tears down a connection that was merely
// still handshaking, and too slow a backoff leaves the alliance without incoming-attack
// alerts during exactly the outage that makes them matter.

// A gateway outage is usually seconds, occasionally an hour. Start fast enough to ride out a
// blip unnoticed, give up trying quickly enough to not hammer Discord while it is down, and
// never back off so far that recovery waits on a human.
const RETRY_BASE_MS = 15 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

// How many consecutive "not ready" observations before the watchdog intervenes. Never 1:
// a client that is merely still connecting reads exactly the same as a dead one from the
// outside, and tearing down a handshake in progress would turn a slow start into a loop
// that can never finish. At the default 60s tick this waits two minutes before acting.
const NOT_READY_TICKS_BEFORE_RELOGIN = 2;

// Exponential, capped. `failures` is the number of attempts that have already failed, so the
// first retry (failures = 1) waits the base delay rather than zero.
function nextRetryDelayMs(failures, { base = RETRY_BASE_MS, max = RETRY_MAX_MS } = {}) {
    const n = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 1;
    // 2 ** 30 is already past any sane cap; clamping the exponent keeps this finite rather
    // than relying on Math.min to rescue an Infinity.
    return Math.min(base * Math.pow(2, Math.min(n - 1, 30)), max);
}

// The watchdog's one decision. Split out from the timer so the conditions are readable in
// one place and provable in a test, rather than being three `&&`s inside a setInterval.
//
//   ready              client.isReady() — a live gateway session
//   loginInFlight      an attempt is already running; a second login() throws
//   consecutiveNotReady how many ticks in a row have seen ready === false
function shouldAttemptRelogin({ ready, loginInFlight, consecutiveNotReady, ticksBeforeRelogin = NOT_READY_TICKS_BEFORE_RELOGIN }) {
    if (ready) return false;
    if (loginInFlight) return false;
    return consecutiveNotReady >= ticksBeforeRelogin;
}

module.exports = {
    nextRetryDelayMs, shouldAttemptRelogin,
    RETRY_BASE_MS, RETRY_MAX_MS, NOT_READY_TICKS_BEFORE_RELOGIN,
};
