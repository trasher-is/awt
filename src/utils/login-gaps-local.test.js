// The quiet-window grid follows browser-local calendar hours, including DST and
// fractional offsets. A repeated hour must be covered twice before it proves quiet.
const G = require('../../public/js/utils/login-gaps.js');
let pass = 0, fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
};
const ms = value => new Date(value).getTime();
const quiet = (start, end) => ({ start: ms(start), end: ms(end), kind: 'quiet' });
const active = (start, end) => ({ start: ms(start), end: ms(end), kind: 'active' });
const originalTZ = process.env.TZ;
try {
    process.env.TZ = 'Europe/Warsaw';
    let rows = G.grid([quiet('2026-03-28T23:00:00Z', '2026-03-29T04:00:00Z')], {
        now: ms('2026-03-29T10:00:00Z'), days: 2, localTime: true,
    });
    const spring = rows[1];
    ok('spring day starts at its actual midnight, before the offset changes', spring.dayStartUtc === ms('2026-03-28T23:00:00Z'), spring);
    ok('skipped 02:00 is unknown, while real surrounding hours can be quiet', spring.cells[1] === 'quiet' && spring.cells[2] === 'unknown' && spring.cells[3] === 'quiet', spring.cells);
    ok('spring grid records a zero-length skipped hour', spring.hourDurations[2] === 0 && spring.hourDurations.reduce((n, x) => n + x, 0) === 23 * G.HOUR);
    rows = G.grid([], { now: ms('2026-03-30T10:00:00Z'), days: 3, localTime: true });
    ok('past rows use their own offset instead of the current summer offset', rows[0].dayStartUtc === ms('2026-03-27T23:00:00Z') && rows[2].dayStartUtc === ms('2026-03-29T22:00:00Z'), rows.map(r => r.dayStartUtc));

    const fallbackNow = ms('2026-10-25T11:00:00Z');
    let fall = G.grid([quiet('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z')], { now: fallbackNow, days: 1, localTime: true })[0];
    ok('first occurrence alone never proves a repeated hour quiet', fall.cells[2] === 'unknown' && fall.hourDurations[2] === 2 * G.HOUR, fall.cells);
    fall = G.grid([quiet('2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z')], { now: fallbackNow, days: 1, localTime: true })[0];
    ok('both occurrences covered prove the repeated hour quiet', fall.cells[2] === 'quiet' && fall.hourDurations.reduce((n, x) => n + x, 0) === 25 * G.HOUR);
    fall = G.grid([
        quiet('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'),
        active('2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z'),
    ], { now: fallbackNow, days: 1, localTime: true })[0];
    ok('activity in the second occurrence disqualifies the repeated hour', fall.cells[2] === 'active');
    const full = G.analyze([{ t: '2026-03-28T00:00:00Z', n: 1 }, { t: '2026-03-29T10:00:00Z', n: 1 }], { now: ms('2026-03-29T10:00:00Z'), localTime: true, days: 1 });
    ok('coverage denominator excludes skipped hours that could never be observed', full.coverage === 1, full.coverage);

    process.env.TZ = 'Australia/Lord_Howe';
    const halfSpring = G.grid([quiet('2026-10-03T14:00:00Z', '2026-10-03T17:00:00Z')], { now: ms('2026-10-04T01:00:00Z'), days: 1, localTime: true })[0];
    ok('30-minute spring shift covers the actual 02:30–03:00 interval', halfSpring.hourDurations[2] === G.HOUR / 2 && halfSpring.cells[2] === 'quiet', halfSpring);
    const halfFall = G.grid([quiet('2026-04-04T14:00:00Z', '2026-04-04T15:00:00Z')], { now: ms('2026-04-05T01:00:00Z'), days: 1, localTime: true })[0];
    ok('30-minute autumn repeat needs all 90 minutes to prove quiet', halfFall.hourDurations[1] === 1.5 * G.HOUR && halfFall.cells[1] === 'unknown', halfFall);

    process.env.TZ = 'Antarctica/Troll';
    const trollSpring = G.grid([quiet('2026-03-29T01:00:00Z', '2026-03-29T03:00:00Z')], { now: ms('2026-03-29T10:00:00Z'), days: 1, localTime: true })[0];
    ok('two-hour spring jump never paints either nonexistent hour quiet', trollSpring.cells[1] === 'unknown' && trollSpring.cells[2] === 'unknown' && trollSpring.hourDurations[1] === 0 && trollSpring.hourDurations[2] === 0 && trollSpring.cells[3] === 'quiet', trollSpring);
    const trollFall = G.grid([
        quiet('2026-10-24T23:00:00Z', '2026-10-25T00:00:00Z'),
        quiet('2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z'),
        active('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'),
    ], { now: ms('2026-10-25T10:00:00Z'), days: 1, localTime: true })[0];
    ok('two-hour rollback groups disjoint occurrences of 01:00 without including 02:00 activity', trollFall.cells[1] === 'quiet' && trollFall.cells[2] === 'active' && trollFall.hourDurations[1] === 2 * G.HOUR && trollFall.hourDurations[2] === 2 * G.HOUR, trollFall);
    process.env.TZ = 'Pacific/Chatham';
    const chatham = G.grid([quiet('2026-09-26T14:00:00Z', '2026-09-26T14:15:00Z')], { now: ms('2026-09-27T00:00:00Z'), days: 1, localTime: true })[0];
    ok('a :45 clock jump assigns 03:45–04:00 to hour3, never to the preceding hour', chatham.cells[3] === 'quiet' && chatham.cells[2] === 'unknown' && chatham.hourDurations[3] === G.HOUR / 4 && chatham.hourDurations[2] === 3 * G.HOUR / 4, chatham);

    process.env.TZ = 'Asia/Kathmandu';
    const nepal = G.grid([quiet('2026-09-11T18:15:00Z', '2026-09-11T20:15:00Z')], { now: ms('2026-09-12T06:15:00Z'), days: 1, localTime: true })[0];
    ok('45-minute local timezone preserves exact midnight and hour boundaries', nepal.dayStartUtc === ms('2026-09-11T18:15:00Z') && nepal.cells[0] === 'quiet' && nepal.cells[1] === 'quiet' && nepal.cells[2] === 'unknown', nepal);
    const fixed = G.grid([], { now: ms('2026-09-12T12:00:00Z'), tzOffsetMin: -420, days: 1 })[0];
    ok('explicit fixed-offset API remains independent of process/browser timezone', fixed.dayStartUtc === ms('2026-09-12T07:00:00Z') && !('hourDurations' in fixed), fixed);
} finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
