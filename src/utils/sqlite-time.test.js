// Regression coverage for a real display bug (2026-08-30): SQLite's CURRENT_TIMESTAMP
// ("YYYY-MM-DD HH:MM:SS") is UTC but carries no timezone marker, so `new Date(ts)` parses
// it as the BROWSER's local time instead — silently shifting every "last scan"/"as of"
// timestamp in the UI by the viewer's own UTC offset. parseSqliteUtc/formatSqliteUtc
// (public/js/utils/sqlite-time.js) are the one fix point every such display must go
// through instead of `new Date(ts)` directly.
//
// Run with: node src/utils/sqlite-time.test.js

const path = require('path');

const { parseSqliteUtc, formatSqliteUtc } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'sqlite-time.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('parseSqliteUtc/formatSqliteUtc');

console.log('\n── The bug this exists to prevent ' + '─'.repeat(38));
// A SQLite CURRENT_TIMESTAMP string has no 'Z' and no 'T' — new Date() on it directly is
// parsed as LOCAL time by every JS engine, not UTC. Confirm the naive parse and the fixed
// parse disagree by exactly the process's own UTC offset (0 only when the test runner's TZ
// happens to be UTC, which is why this asserts the DIFFERENCE, not a fixed wall-clock
// value — the fix must hold in any timezone).
const raw = '2026-08-30 17:50:03';
const naive = new Date(raw);
const fixed = parseSqliteUtc(raw);
const offsetMs = fixed.getTimezoneOffset() * 60 * 1000;
ok('the naive `new Date(ts)` parse and the fixed parse disagree by exactly the local UTC offset',
    Math.abs((fixed.getTime() - naive.getTime()) - offsetMs) < 1000,
    { naive: naive.toISOString(), fixed: fixed.toISOString(), offsetMs });
ok('the fixed parse reads as the UTC instant the string actually names',
    fixed.getUTCFullYear() === 2026 && fixed.getUTCMonth() === 7 && fixed.getUTCDate() === 30
    && fixed.getUTCHours() === 17 && fixed.getUTCMinutes() === 50 && fixed.getUTCSeconds() === 3,
    fixed.toISOString());

console.log('\n── Degenerate inputs ' + '─'.repeat(51));
ok('null returns null, not a bogus Date', parseSqliteUtc(null) === null);
ok('empty string returns null', parseSqliteUtc('') === null);
ok('garbage text returns null, not an Invalid Date object', parseSqliteUtc('not a date') === null);

console.log('\n── formatSqliteUtc ' + '─'.repeat(53));
ok('a missing value uses the fallback', formatSqliteUtc(null, undefined, 'never') === 'never');
ok('a default fallback of an em dash when none is given', formatSqliteUtc(null) === '—');
const formatted = formatSqliteUtc(raw);
ok('a valid timestamp formats to a non-empty, non-fallback string',
    typeof formatted === 'string' && formatted.length > 0 && formatted !== '—', formatted);
ok('formatting respects the options object (a custom format actually changes the output)',
    formatSqliteUtc(raw, { year: 'numeric' }) === String(fixed.getFullYear()), formatSqliteUtc(raw, { year: 'numeric' }));

console.log('\n' + '─'.repeat(77));
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
