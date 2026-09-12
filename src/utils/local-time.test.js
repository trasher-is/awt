// Issue #193: en-US must never select AM/PM or 24:00, and UTC storage must render
// correctly for each viewer, including fractional offsets and daylight saving changes.
const { spawnSync } = require('child_process');
const zones = ['UTC', 'Europe/Warsaw', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe'];
if (!process.argv.includes('--child')) {
    let failed = 0;
    for (const zone of zones) {
        const child = spawnSync(process.execPath, [__filename, '--child'], {
            stdio: 'inherit', env: { ...process.env, TZ: zone, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        });
        if (child.status !== 0) failed++;
    }
    console.log(`${zones.length - failed}/${zones.length} local-time zones passed`);
    process.exit(failed ? 1 : 0);
}
const { parseTimestamp, parseSqliteUtc, formatSqliteUtc, formatLocalDateTime, formatLocalTime } = require('../../public/js/utils/sqlite-time');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`, detail ?? ''); }
}
const zone = process.env.TZ;
console.log(`\nLocal 24-hour time: ${zone}, ${new Intl.DateTimeFormat().resolvedOptions().locale}`);
const iso = '2026-06-15T18:07:09.123Z';
for (const value of ['2026-06-15 18:07:09.123', iso, '2026-06-15T20:07:09.123+02:00',
    '2026-06-15T14:07:09.123-04:00', '2026-06-15T18:07:09.1234567Z', new Date(iso), Date.parse(iso)]) {
    ok('SQL, ISO offsets, Date and epoch identify the same instant', parseTimestamp(value)?.toISOString() === iso, value);
    ok('legacy SQLite entrypoint preserves explicit API offsets', parseSqliteUtc(value)?.toISOString() === iso, value);
}
ok('timezone-less hub ISO is explicitly UTC', parseTimestamp('2026-06-15T18:07:09')?.toISOString() === '2026-06-15T18:07:09.000Z');
ok('epoch zero is a valid instant', parseTimestamp(0)?.getTime() === 0);
for (const invalid of [null, undefined, '', 'N/A', '09/10/2026 7:30 PM', 'in 5 hours', '2026-02-30 12:00:00',
    '2026-04-31T12:00:00Z', '2026-09-01T24:00:00Z', '2026-09-01T12:60:00Z', '2026-09-01T12:00:60Z',
    '2026-09-01T12:00:00+24:00', true, {}, NaN, Infinity, new Date(NaN)]) {
    ok('invalid or ambiguous values are not guessed', parseTimestamp(invalid) === null, invalid);
}
const expected = { UTC: '18:07:09', 'Europe/Warsaw': '20:07:09', 'America/New_York': '14:07:09',
    'Asia/Kolkata': '23:37:09', 'Asia/Kathmandu': '23:52:09', 'Australia/Lord_Howe': '04:37:09' }[zone];
const options = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
ok('viewer timezone and fractional offsets are preserved', formatLocalTime(iso, options) === expected, formatLocalTime(iso, options));
ok('datetime and SQLite displays follow the same time policy', formatLocalDateTime(iso, options) === expected
    && formatSqliteUtc('2026-06-15 18:07:09', options) === expected);
ok('callers cannot accidentally reintroduce AM/PM or a fixed display timezone',
    formatLocalTime(iso, { ...options, hour12: true, hourCycle: 'h12', timeZone: 'UTC' }) === expected);
const midnight = new Date(2026, 5, 15, 0, 0, 0);
const afternoon = new Date(2026, 5, 15, 13, 5, 0);
ok('midnight is 00, never 24 or 12 AM', formatLocalTime(midnight, options) === '00:00:00');
ok('afternoon is 13, never 1 PM', formatLocalTime(afternoon, options) === '13:05:00');
ok('default full datetime contains no AM/PM', !/\b[AP]M\b/i.test(formatLocalDateTime(afternoon)));
ok('date-only options remain date-only', formatLocalDateTime(iso, { year: 'numeric' }) === '2026');
ok('caller fallback is preserved', formatLocalDateTime(null, undefined, 'never') === 'never'
    && formatLocalTime('invalid') === '—');
const justDate = formatLocalDateTime(iso, { day: 'numeric' });
ok('local calendar date follows the instant across midnight', justDate === (zone === 'Australia/Lord_Howe' ? '16' : '15'), justDate);
const dst = {
    'Europe/Warsaw': [['2026-03-29T00:59:00Z', '01:59:00'], ['2026-03-29T01:01:00Z', '03:01:00'],
        ['2026-10-25T00:30:00Z', '02:30:00'], ['2026-10-25T01:30:00Z', '02:30:00']],
    'America/New_York': [['2026-03-08T06:59:00Z', '01:59:00'], ['2026-03-08T07:01:00Z', '03:01:00'],
        ['2026-11-01T05:30:00Z', '01:30:00'], ['2026-11-01T06:30:00Z', '01:30:00']],
    'Australia/Lord_Howe': [['2026-10-03T15:29:00Z', '01:59:00'], ['2026-10-03T15:31:00Z', '02:31:00']],
};
for (const [stamp, time] of dst[zone] || []) {
    ok('DST changes use the offset at the displayed instant', formatLocalTime(stamp, options) === time, { stamp, actual: formatLocalTime(stamp, options) });
}
if (failed) process.exitCode = 1;
