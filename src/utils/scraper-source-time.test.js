// Localization can run before scrapers. Canonical game metadata must survive unchanged,
// even when the visible clock switches date order, locale, or browser timezone.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

if (!process.argv.includes('--child')) {
    let failed = 0;
    for (const zone of ['UTC', 'Europe/Warsaw', 'America/New_York']) {
        console.log(`\nScraper source timestamps in ${zone}`);
        const result = spawnSync(process.execPath, [__filename, '--child'], {
            stdio: 'inherit', env: { ...process.env, TZ: zone },
        });
        if (result.status !== 0) failed++;
    }
    process.exit(failed ? 1 : 0);
}

const AWSqliteTime = require('../../public/js/utils/sqlite-time.js');
const AWScrape = require('../../public/js/utils/scrape-report.js');
const AWNumber = require('../../public/js/utils/parse-number.js');
const root = path.join(__dirname, '../../public/js');
const source = file => fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
function load(file, injected = {}) {
    const context = vm.createContext({ Date, console, AWSqliteTime, AWScrape, AWNumber, AWGameRate: {}, ...injected });
    vm.runInContext(source(file), context, { filename: file });
    return context;
}
const time = load('utils/fleet-time.js');
const siege = load('utils/siege-indicator-parser.js');
const helpers = {
    readUtcTimestamp: time.readUtcTimestamp,
    parseArrivalCellToISO: time.parseArrivalCellToISO,
    parseSiegeIndicator: siege.parseSiegeIndicator,
};
const system = load('scrapers/system-parser.js', helpers);
const alliance = load('scrapers/alliance-parser.js', helpers);
const incoming = load('ui/news-incoming.js', helpers);
const news = load('ui/news-battle-events.js', helpers);
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const canonical = '2026-12-31T23:50:03-05:00';
const expected = '2027-01-01T04:50:03.000Z';
const now = new Date('2027-01-01T05:00:00Z');
function clock(value, { nested = false, timer = false } = {}) {
    return {
        children: nested ? [{}] : [],
        matches: selector => selector === 'span[data-utc]',
        getAttribute: name => name === 'data-utc' ? value : null,
        closest: () => timer ? {} : null,
    };
}
function cell(text = '', value, attrs = {}) {
    const clocks = value === undefined ? [] : [clock(value)];
    return {
        innerText: text, textContent: text, children: clocks, clocks,
        matches: () => false,
        querySelector: () => null,
        querySelectorAll: selector => selector === 'span[data-utc]' ? clocks : [],
        getAttribute: key => attrs[key] ?? null,
        cloneNode() { return cell(this.innerText, value, attrs); },
    };
}
function systemDoc(arrival) {
    const fleetCells = [cell('Synthetic Fleet'), cell('0'), cell('0'), cell('10'), cell('0'), cell('0'), cell('120'), arrival];
    const fleetRow = { querySelectorAll: () => fleetCells, querySelector: () => null };
    const fleetContainer = { classList: { contains: () => true }, querySelector: () => null, querySelectorAll: () => [fleetRow] };
    const planetCells = [cell('1'), cell('20'), cell('0'), cell('Free Planet')];
    const row = { getAttribute: () => '123', querySelectorAll: () => planetCells, querySelector: () => null, nextElementSibling: fleetContainer, classList: { contains: () => false } };
    return { querySelectorAll: () => [row] };
}
function allianceDoc(arrival) {
    const cells = [cell('1'), cell('Synthetic Planet'), cell('20'), arrival, cell('0'), cell('0'), cell('0'), cell('10'), cell('0'), cell('0'), cell('120')];
    const row = {
        className: '', closest: () => null, querySelectorAll: () => cells,
        querySelector: () => ({ getAttribute: () => '/Game/Map/SolarSystem/456/1' }),
    };
    return { querySelectorAll: () => [row] };
}
function newsDoc(timestamp) {
    timestamp.classList = { contains: type => type === 'battle-conquer' };
    const body = { querySelector: selector => ({ getAttribute: () => selector.includes('SolarSystem') ? '/Game/Map/SolarSystem/456' : '/Game/Planets/Planet/123' }) };
    const attrs = {};
    const row = {
        querySelector: selector => selector.startsWith('td.msg.') ? timestamp : body,
        getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; },
    };
    return { querySelectorAll: () => [row] };
}

for (const text of ['23:50:03 - Dec 31', '01.01.2027, 05:50:03', 'Jan 1, 04:50:03']) {
    const arrival = cell(text, canonical, { colspan: '4' });
    ok(`source instant survives visible text ${text}`, time.parseArrivalCellToISO(arrival, now.getTime()) === expected);
    ok('incoming alert identity uses the exact source instant', incoming.readNewsTimeToUnix(arrival) === Date.parse(expected) / 1000);
    const events = news.collectEntriesFromDoc(newsDoc(arrival), now);
    ok('battle/conquest event keeps the source year, day and offset', events.length === 1 && events[0].occurred_at === expected, events);
    const systemRows = system.extractSystemData(systemDoc(arrival));
    ok('system fleets retain canonical arrival and displayed source text', systemRows.fleets.length === 1
        && systemRows.fleets[0].arrival_at === expected && systemRows.fleets[0].arrival_time === text, systemRows.report.problems);
    const report = new AWScrape.ScrapeReport('synthetic alliance');
    const members = alliance.extractMemberFleets(allianceDoc(arrival), 42, report);
    ok('alliance fleets retain canonical arrival despite localized text', members.length === 1 && members[0].arrival_at === expected, report.problems);
}

const fallbackText = '23:50:03 - Dec 31';
const absent = cell(fallbackText);
ok('only missing canonical metadata permits the legacy arrival parser',
    time.readUtcTimestamp(absent) === undefined
    && time.parseArrivalCellToISO(absent, now.getTime()) === time.parseArrivalToISO(fallbackText, now.getTime()));
ok('news fallback remains unchanged when canonical metadata is absent',
    incoming.readNewsTimeToUnix(absent) === incoming.parseNewsTimeToUnix(fallbackText)
    && news.collectEntriesFromDoc(newsDoc(absent), now)[0]?.occurred_at === news.parseNewsTimestamp(fallbackText, now));

for (const invalid of ['', 'invalid', '2026-02-31T17:50:03Z']) {
    const bad = cell(fallbackText, invalid, { colspan: '4' });
    ok('invalid canonical metadata cannot fall back to a plausible displayed clock',
        time.readUtcTimestamp(bad) === null && time.parseArrivalCellToISO(bad, now.getTime()) === null
        && incoming.readNewsTimeToUnix(bad) === 0 && news.collectEntriesFromDoc(newsDoc(bad), now).length === 0, invalid);
    ok('system and alliance parsers fail closed on invalid source dates',
        system.extractSystemData(systemDoc(bad)).fleets[0]?.arrival_at === null
        && alliance.extractMemberFleets(allianceDoc(bad), 42, new AWScrape.ScrapeReport('invalid date'))[0]?.arrival_at === null);
}
const ambiguous = cell(fallbackText, canonical);
ambiguous.clocks.push(clock('2027-01-02T04:50:03Z'));
ok('multiple candidate clocks are ambiguous rather than first-one-wins', time.readUtcTimestamp(ambiguous) === null);
ok('a direct leaf timestamp span can be read', time.readUtcTimestamp(clock(canonical))?.toISOString() === expected);
const unrelated = cell(fallbackText);
unrelated.clocks.push(clock(canonical, { nested: true }), clock(canonical, { timer: true }));
ok('nested markup and duration timer metadata are excluded', time.readUtcTimestamp(unrelated) === undefined);

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
