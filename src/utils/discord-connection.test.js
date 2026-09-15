// The Discord watchdog's restart rule.
//
// ─── TWO BUGS, AND THE ONE THAT MATTERS ───────────────────────────────────────
// First the bot died silently (2026-09-15): the gateway spent a while answering 503, the
// client was torn down, and the hub's entire reconnection strategy was one `.catch()` on the
// initial login. The process kept scraping and serving pages while every announcement —
// incoming attacks included — went nowhere for an hour.
//
// Then the fix for that did not work either, which is the more useful failure. It added an
// in-process reconnect: on noticing the bot was down, destroy() the client and login() again.
// login() resolved every time, so the code reset its counters and declared victory, and the
// client was never actually ready. The logs read "offline for 2 checks — reconnecting" over
// and over, forever, and the bot stayed dead until a human restarted it.
//
// The reason it shipped is worth more than the fix: it was verified with a probe that only
// exercised the FAILURE path — destroy() then login() with an invalid token, which reaches
// token validation and rejects. Seeing the expected error proved the call was reachable and
// proved nothing whatever about whether reconnecting works. Measuring the success path
// against the real gateway takes one minute and says the opposite:
//
//   login() -> READY -> destroy() -> login()   login() RESOLVES, never reaches READY
//   login(bad) -> rejects -> login(good)       login() RESOLVES, never reaches READY
//
// A discord.js 14.26 client is single-use. So the only recovery is a fresh process, and the
// rule below is simply "how long do we wait before asking pm2 for one".
//
// Run with: node src/utils/discord-connection.test.js

const { shouldRestartProcess, OFFLINE_CHECKS_BEFORE_RESTART } = require('./discord-connection');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('discord-connection.test.js');

console.log('\n── A healthy bot is never restarted ' + '─'.repeat(41));
{
    ok('ready wins over any amount of history',
        shouldRestartProcess({ ready: true, consecutiveNotReady: 9999 }) === false);
    // The counter is reset on every ready check by the caller, so a bot that flickers back
    // for one check has to earn the full count again before anything drastic happens.
    ok('a single ready check is enough to call it recovered',
        shouldRestartProcess({ ready: true, consecutiveNotReady: OFFLINE_CHECKS_BEFORE_RESTART }) === false);
}

console.log('\n── Restarting is a last resort, not a first response ' + '─'.repeat(24));
{
    // discord.js recovers from ordinary blips by itself within seconds. Restarting the whole
    // hub over one of those would trade a self-healing hiccup for interrupted scraping.
    ok('one missed check does nothing', shouldRestartProcess({ ready: false, consecutiveNotReady: 1 }) === false);
    ok('nor does being down for half the window',
        shouldRestartProcess({ ready: false, consecutiveNotReady: Math.floor(OFFLINE_CHECKS_BEFORE_RESTART / 2) }) === false);
    ok('nor the check just before the threshold',
        shouldRestartProcess({ ready: false, consecutiveNotReady: OFFLINE_CHECKS_BEFORE_RESTART - 1 }) === false);
    ok(`but ${OFFLINE_CHECKS_BEFORE_RESTART} consecutive misses does`,
        shouldRestartProcess({ ready: false, consecutiveNotReady: OFFLINE_CHECKS_BEFORE_RESTART }) === true);
    ok('and it keeps saying so while it stays down',
        shouldRestartProcess({ ready: false, consecutiveNotReady: OFFLINE_CHECKS_BEFORE_RESTART + 50 }) === true);

    // At one check a minute this is the restart rate during a full Discord outage. Too eager
    // and the hub spends an outage restarting itself; too patient and the alliance goes
    // without incoming-attack alerts during exactly the event that needs them.
    ok('the window is measured in minutes, not seconds or hours',
        OFFLINE_CHECKS_BEFORE_RESTART >= 5 && OFFLINE_CHECKS_BEFORE_RESTART <= 30,
        OFFLINE_CHECKS_BEFORE_RESTART);
}

console.log('\n── Replaying the loop that shipped broken ' + '─'.repeat(35));
{
    // The old rule fired at 2 checks and then "reconnected" in-process, which reset the
    // counter without ever reaching ready — so it re-fired every 2 checks and never escaped.
    // Nothing resets the counter now except the client genuinely coming back, so a bot that
    // stays down walks all the way to a restart instead of circling.
    let notReady = 0;
    let restarted = false;
    for (let tick = 1; tick <= OFFLINE_CHECKS_BEFORE_RESTART * 3; tick++) {
        notReady++;
        if (shouldRestartProcess({ ready: false, consecutiveNotReady: notReady })) { restarted = true; break; }
    }
    ok('a bot that never comes back reaches a restart rather than looping forever',
        restarted && notReady === OFFLINE_CHECKS_BEFORE_RESTART, { restarted, notReady });

    // And the case the very first version missed entirely: no error, no event, the client
    // just quietly stops being ready. Readiness is the only signal that catches that.
    ok('a bot that goes quiet with no error at all is still caught',
        shouldRestartProcess({ ready: false, consecutiveNotReady: OFFLINE_CHECKS_BEFORE_RESTART }) === true);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
