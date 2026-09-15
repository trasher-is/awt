// The Discord reconnection rules.
//
// Written after the bot died silently in production (2026-09-15): it connected normally at
// 14:41 and by 15:46 `!bio` was answering "Expected token to be set for this request, but
// none was present" — discord.js reporting that the client had been torn down underneath us
// after the gateway spent a while returning 503. The hub's whole reconnection strategy was a
// single `.catch()` on the initial login that printed one line and returned, so the process
// kept scraping and serving pages while every announcement went nowhere. Nobody noticed for
// an hour, and only then because somebody typed a command.
//
// Run with: node src/utils/discord-connection.test.js

const {
    nextRetryDelayMs, shouldAttemptRelogin,
    RETRY_BASE_MS, RETRY_MAX_MS, NOT_READY_TICKS_BEFORE_RELOGIN,
} = require('./discord-connection');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('discord-connection.test.js');

console.log('\n── Backoff climbs, then stops climbing ' + '─'.repeat(38));
{
    ok('the first retry waits the base delay, not zero — a failure must never spin',
        nextRetryDelayMs(1) === RETRY_BASE_MS, nextRetryDelayMs(1));
    ok('each further failure doubles the wait',
        nextRetryDelayMs(2) === RETRY_BASE_MS * 2 && nextRetryDelayMs(3) === RETRY_BASE_MS * 4,
        [nextRetryDelayMs(2), nextRetryDelayMs(3)]);
    ok('but it is capped, so recovery never waits on a human',
        nextRetryDelayMs(50) === RETRY_MAX_MS, nextRetryDelayMs(50));
    // 2 ** 1000 is Infinity, and Math.min(Infinity, max) happens to be right — but only by
    // luck. A NaN or negative count reaching the timer would be a hang, not a slow retry.
    ok('an absurd or nonsense failure count still yields a real, finite delay',
        [1000, 0, -5, NaN, undefined].every(n => {
            const d = nextRetryDelayMs(n);
            return Number.isFinite(d) && d >= RETRY_BASE_MS && d <= RETRY_MAX_MS;
        }), [1000, 0, -5, NaN, undefined].map(nextRetryDelayMs));
}

console.log('\n── The watchdog waits before it intervenes ' + '─'.repeat(34));
{
    const decide = (o) => shouldAttemptRelogin({ loginInFlight: false, consecutiveNotReady: 0, ...o });

    ok('a connected bot is left alone', decide({ ready: true, consecutiveNotReady: 99 }) === false);

    // The whole reason this is not a one-tick trigger: a client still completing its
    // handshake is indistinguishable from a dead one, and tearing that down would restart
    // the handshake — forever.
    ok('one missed check is not yet a problem — it may just be still connecting',
        decide({ ready: false, consecutiveNotReady: 1 }) === false);
    ok(`${NOT_READY_TICKS_BEFORE_RELOGIN} in a row is`,
        decide({ ready: false, consecutiveNotReady: NOT_READY_TICKS_BEFORE_RELOGIN }) === true);
    ok('and it keeps trying while it stays down',
        decide({ ready: false, consecutiveNotReady: 17 }) === true);

    // login() throws on a client that is already logging in, so a second attempt would turn
    // one outage into a stream of errors that each look like a new failure.
    ok('never while an attempt is already running',
        decide({ ready: false, consecutiveNotReady: 17, loginInFlight: true }) === false);
}

console.log('\n── The actual production failure ' + '─'.repeat(44));
{
    // What made this one nasty: no event fired. The client was simply not ready any more,
    // which is precisely what a readiness poll notices and an event listener cannot.
    let notReady = 0;
    let reconnected = false;
    for (let tick = 0; tick < 5; tick++) {
        notReady++;
        if (shouldAttemptRelogin({ ready: false, loginInFlight: false, consecutiveNotReady: notReady })) {
            reconnected = true;
            break;
        }
    }
    ok('a bot that goes quiet with no error at all is still picked up within a few ticks',
        reconnected && notReady === NOT_READY_TICKS_BEFORE_RELOGIN, { reconnected, notReady });
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
