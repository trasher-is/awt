// Quiet-window analysis (issue #137): what a set of scan observations does and does not prove.
//
// Run with:  node src/utils/login-gaps.test.js
//
// Fixed clock throughout: Sunday 2026-09-06 12:00 UTC. Everything is asserted at UTC
// offset 0 first (so a cell index IS the hour), then the local-time rotation once.

const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'login-gaps.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const { HOUR, DAY } = G;
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);           // Sun 12:00Z
const TODAY = Date.UTC(2026, 8, 6, 0, 0, 0);
const at = (dayOffset, hour, minute = 0) => TODAY + dayOffset * DAY + hour * HOUR + minute * 60 * 1000;
const sqlite = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

console.log('── Timestamps ' + '─'.repeat(61));
ok('a SQLite "YYYY-MM-DD HH:MM:SS" string is read as UTC', G.toMs('2026-09-06 12:00:00') === NOW);
ok('an ISO string and a Date are accepted too', G.toMs('2026-09-06T12:00:00Z') === NOW && G.toMs(new Date(NOW)) === NOW);
ok('garbage is dropped by normalise, not thrown', G.normalise([{ t: 'never', n: 1 }, { t: sqlite(NOW), n: 'x' }, null, { t: sqlite(NOW), n: 3 }]).length === 1);
ok('normalise sorts by time', G.normalise([{ t: at(0, 5), n: 2 }, { t: at(0, 1), n: 1 }]).map(s => s.n).join(',') === '1,2');

console.log('\n── Bands: what one interval between two scans proves ' + '─'.repeat(22));
let b = G.bands([{ t: at(0, 2), n: 5 }, { t: at(0, 8), n: 5 }], at(-7, 0), NOW);
ok('unchanged counter → one quiet band over the whole interval', b.length === 1 && b[0].kind === 'quiet' && b[0].start === at(0, 2) && b[0].end === at(0, 8), b);
b = G.bands([{ t: at(0, 2), n: 5 }, { t: at(0, 8), n: 7 }], at(-7, 0), NOW);
ok('a higher counter → active, with the delta', b[0].kind === 'active' && b[0].delta === 2, b);
b = G.bands([{ t: at(0, 2), n: 40 }, { t: at(0, 8), n: 3 }], at(-7, 0), NOW);
ok('a LOWER counter (restart) is active, never quiet', b[0].kind === 'active' && b[0].delta === -37, b);
b = G.bands([{ t: at(-9, 0), n: 5 }, { t: at(-6, 12), n: 5 }], at(-7, 0), NOW);
ok('a band is clipped to the window, so the anchor sample before it still counts', b.length === 1 && b[0].start === at(-7, 0) && b[0].end === at(-6, 12), b);
b = G.bands([{ t: at(0, 2), n: 5 }, { t: at(0, 14), n: 5 }], at(-7, 0), NOW);
ok('and clipped to now at the other end', b[0].end === NOW, b);
ok('one sample proves nothing', G.bands([{ t: at(0, 2), n: 5 }], at(-7, 0), NOW).length === 0);

console.log('\n── Grid: quiet only when the whole hour is covered ' + '─'.repeat(24));
let rows = G.grid(G.bands([{ t: at(0, 2), n: 5 }, { t: at(0, 8), n: 5 }], at(-7, 0), NOW), { now: NOW, tzOffsetMin: 0, days: 7 });
ok('seven rows, today last', rows.length === 7 && rows[6].dayStartUtc === TODAY && rows[0].dayStartUtc === TODAY - 6 * DAY);
let today = rows[6].cells;
ok('02:00–08:00 quiet → cells 2..7 quiet', [2, 3, 4, 5, 6, 7].every(h => today[h] === 'quiet'), today);
ok('cell 8 is untouched → unknown; cell 1 too', today[8] === 'unknown' && today[1] === 'unknown', today);
ok('hours after now are future', today[12] === 'future' && today[23] === 'future', today);
ok('the day before has no scans → all unknown', rows[5].cells.every(c => c === 'unknown'));

rows = G.grid(G.bands([{ t: at(0, 2, 30), n: 5 }, { t: at(0, 8), n: 5 }], at(-7, 0), NOW), { now: NOW, tzOffsetMin: 0 });
ok('a band starting at 02:30 leaves cell 2 unknown (half an hour proves nothing about the other half)', rows[6].cells[2] === 'unknown' && rows[6].cells[3] === 'quiet', rows[6].cells);

rows = G.grid(G.bands([{ t: at(0, 2), n: 5 }, { t: at(0, 5), n: 5 }, { t: at(0, 8), n: 6 }], at(-7, 0), NOW), { now: NOW, tzOffsetMin: 0 });
ok('two adjacent quiet bands cover an hour together; the active band paints its hours red', rows[6].cells[4] === 'quiet' && rows[6].cells[5] === 'active' && rows[6].cells[7] === 'active', rows[6].cells);

rows = G.grid(G.bands([{ t: at(0, 2), n: 5 }, { t: at(0, 5), n: 5 }, { t: at(0, 5), n: 6 }], at(-7, 0), NOW), { now: NOW, tzOffsetMin: 0 });
ok('a zero-length interval between two scans at the same second is ignored', rows[6].cells[4] === 'quiet', rows[6].cells);

rows = G.grid(G.bands([{ t: at(0, 10), n: 5 }, { t: at(0, 11, 30), n: 5 }], at(-7, 0), NOW), { now: NOW, tzOffsetMin: 0 });
ok('the current hour only has to be covered up to now', rows[6].cells[10] === 'quiet' && rows[6].cells[11] === 'unknown', rows[6].cells);

// Local time: UTC+2. Local midnight is 22:00Z the day before; a quiet band 00:00Z–04:00Z
// is local 02:00–06:00.
rows = G.grid(G.bands([{ t: at(0, 0), n: 5 }, { t: at(0, 4), n: 5 }], at(-7, 0), NOW), { now: NOW, tzOffsetMin: 120 });
ok('UTC+2 viewer: 00:00Z–04:00Z lands in local cells 2..5', [2, 3, 4, 5].every(h => rows[6].cells[h] === 'quiet') && rows[6].cells[1] === 'unknown' && rows[6].cells[6] === 'unknown', rows[6].cells);
ok('and today\'s row starts at local midnight (22:00Z yesterday)', rows[6].dayStartUtc === TODAY - 2 * HOUR);
ok('local 13:00 (11:00Z) is the last past hour; local 14:00 starts exactly now, so it is future', rows[6].cells[13] !== 'future' && rows[6].cells[14] === 'future', rows[6].cells);

console.log('\n── Windows: quiet on every observed day, observed at least twice ' + '─'.repeat(10));
const paint = (spec) => Array.from({ length: 7 }, (_, d) => ({
    dayStartUtc: TODAY - (6 - d) * DAY,
    cells: Array.from({ length: 24 }, (_, h) => (spec[d] && spec[d][h]) || 'unknown'),
}));
const spec = Array.from({ length: 7 }, () => ({}));
for (let d = 0; d < 7; d++) for (let h = 2; h < 8; h++) spec[d][h] = 'quiet';        // 02–08 quiet all 7 days
spec[3][10] = 'quiet';                                                               // 10:00 quiet once only
for (const d of [0, 2, 4]) for (const h of [21, 22, 23, 0]) spec[d][h] = 'quiet';    // 21–01 quiet on 3 days (hour 1 unobserved keeps it apart from 02–08)
for (let d = 0; d < 7; d++) spec[d][12] = 'quiet';
spec[1][12] = 'active';                                                              // 12:00 quiet 6 days, active once
spec[0][15] = 'quiet'; spec[1][15] = 'quiet';                                        // 15:00 alone: too short
let w = G.windows(paint(spec));
ok('the longest window comes first: 02:00–08:00, seen on 7 days', w[0] && w[0].startHour === 2 && w[0].endHour === 8 && w[0].hours === 6 && w[0].minObserved === 7, w[0]);
ok('a window across midnight is one window: 21:00–01:00 on 3 days', w[1] && w[1].startHour === 21 && w[1].endHour === 1 && w[1].hours === 4 && w[1].minObserved === 3, w[1]);
// Adjacent safe hours are one window even when they were observed on different days.
const touching = Array.from({ length: 7 }, () => ({}));
for (let d = 0; d < 7; d++) for (let h = 2; h < 8; h++) touching[d][h] = 'quiet';
for (const d of [0, 2, 4]) for (const h of [22, 23, 0, 1]) touching[d][h] = 'quiet';
const tw = G.windows(paint(touching));
ok('22–02 touching 02–08 merges into one 22:00–08:00 window whose minObserved is the weaker part\'s', tw.length === 1 && tw[0].startHour === 22 && tw[0].endHour === 8 && tw[0].hours === 10 && tw[0].minObserved === 3, tw);
ok('an hour quiet on ONE day is not a window', !w.some(x => x.startHour <= 10 && x.startHour + x.hours > 10));
ok('one active day disqualifies an hour, however many quiet days it has', !w.some(x => x.startHour <= 12 && x.startHour + x.hours > 12));
ok('a single quiet hour is below the minimum length', !w.some(x => x.startHour === 15) && w.length === 2, w);
ok('with minHours 1 the single hour appears', G.windows(paint(spec), { minHours: 1 }).some(x => x.startHour === 15 && x.hours === 1));

const allQuiet = paint(Array.from({ length: 7 }, () => Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, 'quiet']))));
w = G.windows(allQuiet);
ok('a player never seen active in a fully covered week is one 24-hour window', w.length === 1 && w[0].hours === 24 && w[0].minObserved === 7, w);
ok('no observations → no windows', G.windows(paint(Array.from({ length: 7 }, () => ({})))).length === 0);

const hs = G.hourStats(paint(spec));
ok('hourStats counts quiet/active/observed per hour', hs[12].quiet === 6 && hs[12].active === 1 && hs[12].observed === 7 && hs[10].observed === 1, hs[12]);

console.log('\n── quietSince: the last scan that saw the counter move ' + '─'.repeat(20));
let q = G.quietSince([{ t: at(-2, 0), n: 5 }, { t: at(-1, 6), n: 5 }, { t: at(-1, 12), n: 6 }, { t: at(-1, 18), n: 6 }, { t: at(0, 6), n: 6 }]);
ok('reports the scan where the counter last changed and the scans since', q && q.at === at(-1, 12) && q.unchangedScans === 2 && q.lastScanAt === at(0, 6), q);
ok('confirmedQuietMs runs from that scan to the last scan, not to now', q.confirmedQuietMs === 18 * HOUR, q);
ok('a counter never seen moving → null', G.quietSince([{ t: at(-2, 0), n: 5 }, { t: at(-1, 0), n: 5 }]) === null);
ok('a single sample → null', G.quietSince([{ t: at(-2, 0), n: 5 }]) === null);
q = G.quietSince([{ t: at(-2, 0), n: 5 }, { t: at(-1, 0), n: 6 }]);
ok('a change on the very last scan → zero unchanged scans, zero confirmed quiet', q.unchangedScans === 0 && q.confirmedQuietMs === 0, q);

console.log('\n── analyze: end to end ' + '─'.repeat(52));
// Eight days of scans every 6 hours (00, 06, 12, 18 UTC). The counter rises only on the
// 18:00 scan, i.e. the player logs in somewhere between 12:00 and 18:00 every day.
const samples = [];
let n = 100;
for (let d = -8; d <= 0; d++) {
    for (const h of [0, 6, 12, 18]) {
        const t = at(d, h);
        if (t > NOW) continue;
        if (h === 18) n++;
        samples.push({ t: sqlite(t), n });
    }
}
const a = G.analyze(samples, { now: NOW, tzOffsetMin: 0, days: 7 });
// Inside [Sun-7 12:00Z, now]: 12:00 and 18:00 seven days ago, 4 × 6 full days, 00/06/12 today.
ok('sampleCount counts only the samples inside the 7-day window', a.sampleCount === 2 + 24 + 3, a.sampleCount);
ok('one window: 18:00–12:00 (18 hours), seen on 6 or 7 days', a.windows.length === 1 && a.windows[0].startHour === 18 && a.windows[0].endHour === 12 && a.windows[0].hours === 18 && a.windows[0].minObserved >= 6, a.windows);
ok('12:00–18:00 is red on every full day', a.rows.slice(0, 6).every(r => [12, 13, 14, 15, 16, 17].every(h => r.cells[h] === 'active')));
ok('quietSince points at yesterday 18:00 with three unchanged scans since', a.quietSince.at === at(-1, 18) && a.quietSince.unchangedScans === 3, a.quietSince);
ok('coverage is complete: every past hour is observed', a.coverage === 1, a.coverage);
ok('the first band inside the window is anchored by the sample from before it', a.bands[0].start === a.from, a.bands[0]);

const sparse = G.analyze([{ t: sqlite(at(-3, 4)), n: 9 }, { t: sqlite(at(-3, 10)), n: 9 }], { now: NOW, tzOffsetMin: 0 });
ok('two scans → one quiet band, no window yet (observed once), partial coverage', sparse.windows.length === 0 && sparse.bands.length === 1 && sparse.coverage > 0 && sparse.coverage < 0.1, [sparse.windows, sparse.coverage]);
ok('analyze with nothing at all does not throw', G.analyze([], { now: NOW }).rows.length === 7 && G.analyze(undefined, { now: NOW }).sampleCount === 0);

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
