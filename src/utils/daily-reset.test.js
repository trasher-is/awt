// Regression coverage for the once-a-day (00:00 Europe/Berlin + buffer) scheduling helper
// used by the galaxy auto-seed and battle-report sync — replacing their old every-few-
// minutes polling now that both are confirmed to only get fresh data once per day, at the
// reset (2026-09-12).
//
// Run with: node src/utils/daily-reset.test.js

const path = require('path');

const { nextDailyWindow, berlinDateKey } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'daily-reset.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('nextDailyWindow / berlinDateKey');

console.log('\n── Before today\'s window: lands later today ' + '─'.repeat(30));
{
    // 2026-06-15 is deep in CEST (UTC+2) — 00:00 Berlin = 22:00 UTC the day before.
    const now = new Date('2026-06-15T21:00:00Z'); // 23:00 Berlin (still before midnight)
    const next = nextDailyWindow(5, now);
    ok('fires at 00:05 Berlin (22:05 UTC) the same UTC day', next.toISOString() === '2026-06-15T22:05:00.000Z', next.toISOString());
}

console.log('\n── After today\'s window: rolls to tomorrow ' + '─'.repeat(31));
{
    const now = new Date('2026-06-15T22:10:00Z'); // 00:10 Berlin — 5 minutes past the 00:05 window
    const next = nextDailyWindow(5, now);
    ok('rolls to tomorrow\'s window, not a negative/immediate one', next.toISOString() === '2026-06-16T22:05:00.000Z', next.toISOString());
}

console.log('\n── Exactly at the window ' + '─'.repeat(49));
{
    const now = new Date('2026-06-15T22:05:00Z'); // exactly 00:05 Berlin
    const next = nextDailyWindow(5, now);
    ok('exactly at the window rolls to tomorrow (>= today\'s), never fires twice the same moment',
        next.toISOString() === '2026-06-16T22:05:00.000Z', next.toISOString());
}

console.log('\n── DST-safe: Europe/Berlin auto-shifts across the CET/CEST boundary ' + '─'.repeat(6));
{
    // 2026's spring-forward is 2026-03-29 (clocks jump 02:00 -> 03:00 CET->CEST).
    // The day before, Berlin is still UTC+1: 00:05 Berlin = 23:05 UTC the prior day.
    const beforeDst = new Date('2026-03-28T12:00:00Z'); // midday, well before that night's window
    const next = nextDailyWindow(5, beforeDst);
    ok('still CET (UTC+1) the day before the DST jump', next.toISOString() === '2026-03-28T23:05:00.000Z', next.toISOString());

    // The day after, Berlin is UTC+2: 00:05 Berlin = 22:05 UTC.
    const afterDst = new Date('2026-03-30T12:00:00Z');
    const next2 = nextDailyWindow(5, afterDst);
    ok('CEST (UTC+2) the day after the DST jump — no manual offset needed',
        next2.toISOString() === '2026-03-30T22:05:00.000Z', next2.toISOString());
}

console.log('\n── berlinDateKey ' + '─'.repeat(58));
{
    // 23:30 UTC on 2025-12-31 is already 00:30 the next day in Berlin (UTC+1 in January).
    ok('a date that has not yet rolled over in UTC but already has in Berlin reads as the Berlin day',
        berlinDateKey(new Date('2025-12-31T23:30:00Z')) === '2026-01-01');
    ok('a date safely inside a Berlin day reads as that day',
        berlinDateKey(new Date('2026-06-15T12:00:00Z')) === '2026-06-15');
    ok('two moments on either side of the Berlin midnight produce different keys', (() => {
        const before = berlinDateKey(new Date('2026-06-15T21:59:00Z'));
        const after = berlinDateKey(new Date('2026-06-15T22:01:00Z'));
        return before !== after;
    })());
}

console.log('\n' + '─'.repeat(77));
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
