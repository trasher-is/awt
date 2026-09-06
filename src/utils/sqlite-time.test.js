// Regression coverage for a real display bug (2026-08-30): SQLite's CURRENT_TIMESTAMP
// ("YYYY-MM-DD HH:MM:SS") is UTC but carries no timezone marker, so `new Date(ts)` parses
// it as the BROWSER's local time instead — silently shifting every "last scan"/"as of"
// timestamp in the UI by the viewer's own UTC offset. parseSqliteUtc/formatSqliteUtc
// (public/js/utils/sqlite-time.js) are the one fix point every such display must go
// through instead of `new Date(ts)` directly.
//
// Run with: node src/utils/sqlite-time.test.js
//
// ─── WHY THIS SUITE FORKS ITSELF ──────────────────────────────────────────────
// Node fixes its timezone when the process starts; setting process.env.TZ afterwards does
// nothing. So the parent process below spawns one child per zone with TZ in the child's
// environment, and every child runs the same assertions. UTC alone would prove nothing —
// in UTC the naive parse and the fixed parse agree by accident, which is exactly how the
// original sign error in this file's offset arithmetic went unnoticed (issue #131: the suite
// passed 9/9 under TZ=UTC and failed 8/9 in Europe/Warsaw and America/New_York).

const path = require('path');
const { spawnSync } = require('child_process');

const ZONES = ['UTC', 'Europe/Warsaw', 'America/New_York'];

// Both samples sit well clear of any DST transition hour, so the offset at the naive
// (local) reading and at the fixed (UTC) reading is the same one.
const SAMPLES = [
    { label: 'summer', raw: '2026-08-30 17:50:03', iso: '2026-08-30T17:50:03.000Z',
      utc: [2026, 7, 30, 17, 50, 3],
      // Minutes east of UTC, i.e. -getTimezoneOffset(), per zone at that instant.
      offsetMinutes: { 'UTC': 0, 'Europe/Warsaw': 120, 'America/New_York': -240 } },
    { label: 'winter', raw: '2026-01-15 09:00:00', iso: '2026-01-15T09:00:00.000Z',
      utc: [2026, 0, 15, 9, 0, 0],
      offsetMinutes: { 'UTC': 0, 'Europe/Warsaw': 60, 'America/New_York': -300 } },
];

const zoneArg = process.argv.find(a => a.startsWith('--zone='));

if (!zoneArg) {
    // ─── PARENT: one child process per zone ──────────────────────────────────
    console.log('parseSqliteUtc/formatSqliteUtc — one process per timezone');
    const results = [];
    for (const zone of ZONES) {
        console.log(`\n${'─'.repeat(75)}\n▶ TZ=${zone}\n${'─'.repeat(75)}`);
        const r = spawnSync(process.execPath, [__filename, `--zone=${zone}`], {
            stdio: 'inherit',
            env: Object.assign({}, process.env, { TZ: zone }),
        });
        results.push({ zone, code: r.status == null ? 1 : r.status });
    }
    console.log('\n' + '─'.repeat(75));
    for (const r of results) console.log(`  ${r.code === 0 ? '✅' : '❌'} TZ=${r.zone}`);
    const failed = results.filter(r => r.code !== 0);
    console.log(`${results.length - failed.length}/${results.length} timezones passed`);
    process.exit(failed.length ? 1 : 0);
}

// ─── CHILD: the actual assertions, under one fixed TZ ─────────────────────────
const zone = zoneArg.slice('--zone='.length);
const { parseSqliteUtc, formatSqliteUtc } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'sqlite-time.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log(`parseSqliteUtc/formatSqliteUtc in ${zone}`);

// The child must actually be running in the zone it was asked for. If TZ were ignored
// (or the zone database missing) every zone would silently degrade to the same offset and
// the three runs would prove nothing more than one.
console.log('\n── The process really is in this timezone ' + '─'.repeat(31));
ok('process.env.TZ names the zone under test', process.env.TZ === zone, process.env.TZ);
for (const s of SAMPLES) {
    const expected = s.offsetMinutes[zone];
    const actual = -parseSqliteUtc(s.raw).getTimezoneOffset();
    ok(`${s.label}: the local offset is ${expected} minutes east of UTC`, actual === expected, { expected, actual });
}

console.log('\n── The bug this exists to prevent ' + '─'.repeat(38));
for (const s of SAMPLES) {
    // A SQLite CURRENT_TIMESTAMP string has no 'Z' and no 'T' — new Date() on it directly
    // is parsed as LOCAL time by every JS engine, not UTC. The naive parse therefore lands
    // getTimezoneOffset() minutes AFTER the instant the string names (east of UTC the local
    // wall clock is ahead, so the same digits read as local mean an EARLIER instant, and
    // naive − fixed is negative... in getTimezoneOffset's own sign convention, which is
    // minutes WEST of UTC: Warsaw in summer is −120). So: naive − fixed === offsetMs.
    //
    // The original assertion had fixed − naive on the left, which is the same number with
    // the opposite sign — zero only in UTC, which is the one zone where it happened to pass.
    const naive = new Date(s.raw);
    const fixed = parseSqliteUtc(s.raw);
    const offsetMs = fixed.getTimezoneOffset() * 60 * 1000;
    ok(`${s.label}: naive − fixed is exactly the local UTC offset (${offsetMs} ms)`,
        Math.abs((naive.getTime() - fixed.getTime()) - offsetMs) < 1000,
        { naive: naive.toISOString(), fixed: fixed.toISOString(), offsetMs });

    // The explicit instant, so a UTC-only run can never hide a parser regression behind an
    // offset of zero: the string names 17:50:03Z, and that is what must come back.
    const [Y, M, D, h, m, sec] = s.utc;
    ok(`${s.label}: the fixed parse reads as the UTC instant the string names`,
        fixed.getUTCFullYear() === Y && fixed.getUTCMonth() === M && fixed.getUTCDate() === D
        && fixed.getUTCHours() === h && fixed.getUTCMinutes() === m && fixed.getUTCSeconds() === sec,
        fixed.toISOString());
    ok(`${s.label}: ...and serialises to exactly ${s.iso}`, fixed.toISOString() === s.iso, fixed.toISOString());

    if (zone !== 'UTC') {
        ok(`${s.label}: outside UTC the naive parse really does disagree — the bug is reproducible here`,
            naive.getTime() !== fixed.getTime(), { naive: naive.toISOString(), fixed: fixed.toISOString() });
    }
}

console.log('\n── Degenerate inputs ' + '─'.repeat(51));
ok('null returns null, not a bogus Date', parseSqliteUtc(null) === null);
ok('empty string returns null', parseSqliteUtc('') === null);
ok('garbage text returns null, not an Invalid Date object', parseSqliteUtc('not a date') === null);

console.log('\n── formatSqliteUtc ' + '─'.repeat(53));
const raw = SAMPLES[0].raw;
const fixed = parseSqliteUtc(raw);
ok('a missing value uses the fallback', formatSqliteUtc(null, undefined, 'never') === 'never');
ok('a default fallback of an em dash when none is given', formatSqliteUtc(null) === '—');
const formatted = formatSqliteUtc(raw);
ok('a valid timestamp formats to a non-empty, non-fallback string',
    typeof formatted === 'string' && formatted.length > 0 && formatted !== '—', formatted);
ok('formatting respects the options object (a custom format actually changes the output)',
    formatSqliteUtc(raw, { year: 'numeric' }) === String(fixed.getFullYear()), formatSqliteUtc(raw, { year: 'numeric' }));
// The formatted local hour must be the UTC hour shifted by THIS zone's offset — the
// display-side half of the same bug.
const localHour = Number(formatSqliteUtc(raw, { hour: 'numeric', hour12: false, timeZone: zone }));
const expectedHour = (17 + SAMPLES[0].offsetMinutes[zone] / 60 + 24) % 24;
ok(`the displayed local hour is ${expectedHour} in ${zone}`, localHour % 24 === expectedHour, { localHour, expectedHour });

console.log('\n' + '─'.repeat(77));
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
