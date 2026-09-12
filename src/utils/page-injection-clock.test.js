// Browser page additions must preserve UTC instants and render the viewer's 00–23 clock.
// Synthetic clock/DOM inputs only; no captured game data.
const fs = require('fs');
const path = require('path');
const Time = require('../../public/js/utils/sqlite-time.js');
let pass = 0, fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
};
const source = fs.readFileSync(path.join(__dirname, '../../public/js/core/page-injections.js'), 'utf8');
function lift(name, bindings = {}) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate ${name}`);
    return new Function(...Object.keys(bindings), `${source.slice(start, end + 2)}; return ${name};`)(...Object.values(bindings));
}
const bins = lift('localActivityBins');
const counts = Array.from({ length: 24 }, (_, hour) => hour);
for (const [offset, label, utcHour] of [[120, '02:00', 0], [-420, '17:00', 0], [330, '05:30', 0], [345, '05:45', 0], [-210, '20:30', 0]]) {
    const result = bins(counts, offset);
    ok(`UTC bin ${utcHour} retains its count at ${label} for offset ${offset}`, result.find(x => x.label === label)?.count === utcHour, result);
    ok(`offset ${offset}: local clock order and all counts preserved`, result.every((b, i) => i === 0 || b.minuteOfDay > result[i - 1].minuteOfDay) && result.reduce((n, b) => n + b.count, 0) === 276);
}
const render = lift('buildActivityLogCard', { localActivityBins: c => bins(c, 345), buildQuietWindowsSection: () => '' });
const card = render(counts, []);
ok('profile axes preserve fractional local bin boundaries', card.includes('<span>00:45</span><span>12:45</span><span>23:45</span>'));
ok('profile tooltip attaches original UTC count to its local label', card.includes('title="05:45 — 0 login(s)"'));
ok('all-time aggregate projection explains its historical DST limit', card.includes('past daylight-saving offsets are unavailable'));

const canonicalDate = new Date('2026-10-25T01:30:00Z');
let displayReads = 0;
const readArrival = lift('readFleetArrival', {
    readUtcTimestamp: cell => cell.canonical,
    parseFleetArrival: text => { displayReads++; return `legacy:${text}`; },
});
ok('fleet and launch ETAs keep the exact canonical instant during repeated hours', readArrival({ canonical: canonicalDate, textContent: 'localized display' }) === canonicalDate && displayReads === 0);
ok('invalid canonical ETA fails closed without reinterpreting the display', readArrival({ canonical: null, textContent: '12:00:00 - Sep 12' }) === null && displayReads === 0);
ok('legacy ETA text remains supported when no UTC source exists', readArrival({ textContent: '12:00:00 - Sep 12' }) === 'legacy:12:00:00 - Sep 12' && displayReads === 1);
ok('both fleet countdown surfaces use the canonical-aware reader', (source.match(/const d = readFleetArrival\(td\)/g) || []).length === 2);

function element(raw, text, options = {}) {
    let value = text;
    const el = {
        children: options.children || [], writes: 0,
        getAttribute: key => key === 'data-utc' ? raw : null,
        closest: () => options.timer ? {} : null,
        get textContent() { return value; },
        set textContent(next) { value = next; this.writes++; },
    };
    return el;
}
const nextUpdate = lift('nextPLUpdate');
const scheduleCases = [
    ['before midnight', '2026-03-28T22:59:59.900Z', 1, '2026-03-28T23:00:00.000Z'],
    ['spring midnight to noon is 11 hours', '2026-03-28T23:00:00Z', 1, '2026-03-29T10:00:00.000Z'],
    ['spring next midnight is 23 hours later', '2026-03-28T23:00:00Z', 2, '2026-03-29T22:00:00.000Z'],
    ['multiple updates through spring', '2026-03-28T10:59:00Z', 3, '2026-03-29T10:00:00.000Z'],
    ['autumn midnight to noon is 13 hours', '2026-10-24T22:00:00Z', 1, '2026-10-25T11:00:00.000Z'],
    ['autumn next midnight is 25 hours later', '2026-10-24T22:00:00Z', 2, '2026-10-25T23:00:00.000Z'],
    ['at noon choose the following update', '2026-10-25T11:00:00Z', 1, '2026-10-25T23:00:00.000Z'],
    ['363 updates land on July1 noon', '2026-01-01T00:00:00Z', 363, '2026-07-01T10:00:00.000Z'],
    ['100 updates through autumn', '2026-09-12T12:00:00Z', 100, '2026-11-01T11:00:00.000Z'],
];
for (const [name, now, updates, expected] of scheduleCases) {
    const result = nextUpdate(updates, new Date(now));
    ok(`Berlin PL schedule: ${name}`, result?.toISOString() === expected, result?.toISOString());
}
ok('invalid PL update counts never invent an ETA', [0, -1, 1.5, Infinity, NaN].every(n => nextUpdate(n) === null));
ok('PL growth uses calendar update count without fixed elapsed-day arithmetic', source.includes('const finish = nextPLUpdate(updates)') && !source.includes('(updates - 1) * 43200'));

const originalTZ = process.env.TZ;
try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kathmandu']) {
        process.env.TZ = zone;
        ok(`Berlin PL schedule is independent of browser zone ${zone}`, nextUpdate(1, new Date('2026-03-28T23:00:00Z'))?.toISOString() === '2026-03-29T10:00:00.000Z');
    }
    process.env.TZ = 'America/Los_Angeles';
    const raw = '2026-09-12 07:05:06';
    const native = element(raw, '12:05:06 AM Sep 12');
    const timer = element(raw, '00:12:34', { timer: true });
    const nested = element(raw, '12:05:06', { children: [{}] });
    const dateOnly = element(raw, 'Sep 12');
    const invalid = element('bad input', '12:05:06');
    const nodes = [native, timer, nested, dateOnly, invalid];
    const normalize = lift('initLocalGameTimestamps', {
        document: { querySelectorAll: selector => selector === 'span[data-utc]' ? nodes : [] },
        parseTimestamp: Time.parseTimestamp,
        formatLocalDateTime: Time.formatLocalDateTime,
    });
    normalize();
    ok('native UTC-backed timestamp shows local midnight with a 00–23 clock', native.textContent.includes('00:05:06') && !/AM|PM/.test(native.textContent), native.textContent);
    ok('native source attribute is untouched for the scraper', native.getAttribute('data-utc') === raw);
    ok('countdowns, controls, date-only text, and invalid sources are unchanged', timer.writes === 0 && nested.writes === 0 && dateOnly.writes === 0 && invalid.writes === 0);
    normalize();
    ok('normalization does not cause an endless mutation loop', native.writes === 1);

    process.env.TZ = 'Europe/Warsaw';
    const DateAt = (iso) => class extends Date { constructor(...args) { super(...(args.length ? args : [iso])); } };
    const winter = lift('localActivityBins', { Date: DateAt('2026-01-12T12:00:00Z') })(counts);
    const summer = lift('localActivityBins', { Date: DateAt('2026-07-12T12:00:00Z') })(counts);
    ok('aggregate projection follows the viewer current winter/summer offset', winter.find(x => x.count === 0).label === '01:00' && summer.find(x => x.count === 0).label === '02:00');

    const userscript = fs.readFileSync(path.join(__dirname, '../../public/userscripts/redzone-qol.user.js'), 'utf8');
    const start = userscript.indexOf('    function formatLocalFinishDate(');
    const end = userscript.indexOf('\n    }\n', start);
    if (start < 0 || end < 0) throw new Error('Cannot locate standalone formatter');
    const standalone = new Function(`${userscript.slice(start, end + 6)}; return formatLocalFinishDate;`)();
    for (const [zone, iso, expected] of [
        ['America/Los_Angeles', '2026-09-12T07:00:00Z', '00:00'],
        ['Asia/Kathmandu', '2026-09-12T07:00:00Z', '12:45'],
        ['Europe/Warsaw', '2026-01-12T07:00:00Z', '08:00'],
        ['Europe/Warsaw', '2026-07-12T07:00:00Z', '09:00'],
    ]) {
        process.env.TZ = zone;
        const date = new Date(iso);
        date.toLocaleString = (_, options) => Date.prototype.toLocaleString.call(date, 'en-US', options);
        const label = standalone(date);
        ok(`standalone ETA uses local h23 in ${zone}: ${expected}`, label.includes(expected) && !/AM|PM/.test(label), label);
    }
} finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
