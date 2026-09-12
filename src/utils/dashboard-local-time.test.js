// Exercise real archive/sidebar renderers with synthetic data in a 12-hour locale.
// Different browser zones must change the displayed clock, never the stored instant.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const zones = { UTC: '17:50', 'Europe/Warsaw': '19:50', 'America/New_York': '13:50' };
if (!process.argv.includes('--child')) {
    let failed = 0;
    for (const zone of Object.keys(zones)) {
        console.log(`\nDashboard local time in ${zone} / en-US`);
        const result = spawnSync(process.execPath, [__filename, '--child'], {
            stdio: 'inherit', env: { ...process.env, TZ: zone, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        });
        if (result.status !== 0) failed++;
    }
    process.exit(failed ? 1 : 0);
}

const AWSqliteTime = require('../../public/js/utils/sqlite-time.js');
const AWBattleModel = require('../../public/js/utils/battle-model.js');
const AWNumber = require('../../public/js/utils/parse-number.js');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const expectedClock = zones[process.env.TZ];
const localClock = value => value.includes(expectedClock) && !/\b(?:AM|PM)\b/.test(value);
const raw = '2026-08-30 17:50:03';
const offset = '2026-08-30T19:50:03+02:00';
const fleetRows = [
    { planet_index: 1, arrival_at: offset, arrival_time: '7:50 PM', owner_name: 'Synthetic Fleet' },
    { planet_index: 2, arrival_at: null, arrival_time: '2h 15m', owner_name: 'Synthetic Countdown' },
    { planet_index: 3, arrival_at: null, arrival_time: '-', owner_name: 'Synthetic Stationed' },
    { planet_index: 4, arrival_at: 'invalid', arrival_time: '<legacy countdown>', owner_name: 'Synthetic Legacy' },
];

function load(name, response = {}) {
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', innerText: '', textContent: '', querySelectorAll: () => [] });
        return elements.get(id);
    };
    const context = vm.createContext({
        Date, console, esc, AWSqliteTime, AWBattleModel, AWNumber, AWGameRate: {},
        document: { getElementById: get, querySelectorAll: () => [] },
        window: { addEventListener() {}, location: { origin: 'https://synthetic.invalid' } },
        fetch: async () => ({ json: async () => response }),
    });
    const code = fs.readFileSync(path.join(__dirname, '../../public/js/ui', name), 'utf8')
        .replace(/^import\b[\s\S]*?;[^\n]*(?:\n|$)/gm, '').replace(/^export /gm, '');
    vm.runInContext(code, context, { filename: name });
    return { get, run: code => vm.runInContext(code, context), context };
}

(async () => {
    const archive = load('archives.js');
    archive.context.rows = fleetRows;
    archive.run(`rawDbSystems = [{ id: 1, updated_at: '${raw}' }]; renderSystemTable()`);
    ok('system archive reads SQLite as UTC and shows local 24-hour time', localClock(archive.get('sys-db-table-body').innerHTML));
    archive.run(`rawDbPlanets = [{ system_id: 1, system_name: 'Synthetic System', updated_at: '${offset}' }]; renderPlanetTable()`);
    ok('planet archive preserves an API timestamp offset', localClock(archive.get('pln-db-table-body').innerHTML));
    archive.run('rawDbFleets = rows; renderFleetTable()');
    const fleetHtml = archive.get('flt-db-table-body').innerHTML;
    ok('fleet archive prefers the canonical local arrival over source text', localClock(fleetHtml) && !fleetHtml.includes('7:50 PM'));
    ok('fleet archive retains legacy source evidence and stationed rows', fleetHtml.includes('2h 15m') && fleetHtml.includes('Stationed'));
    ok('unparseable legacy arrival fallback remains escaped', fleetHtml.includes('&lt;legacy countdown>') && !fleetHtml.includes('<legacy countdown>'));
    ok('unconvertible source time is labelled unknown instead of pretending to be local', fleetHtml.includes('Time unknown') && fleetHtml.includes('Recorded source time (timezone unknown):'));
    ok('formatting leaves the supplied arrival instant and source text unchanged', fleetRows[0].arrival_at === offset && fleetRows[0].arrival_time === '7:50 PM');
    archive.run(`renderBattleReportsTable([{ occurred_at: '${raw}' }], 1)`);
    ok('battle list dates also use the local 24-hour clock', localClock(archive.get('battle-reports-table-body').innerHTML));

    const sidebar = load('system-intel.js', { success: true, plans: [], fleets: fleetRows, history: [{ timestamp: raw, event_type_id: 1 }] });
    await sidebar.run('loadPlans(1)');
    const sidebarHtml = sidebar.get('intel-fleets-list').innerHTML;
    ok('system sidebar localizes canonical arrivals and retains source evidence', localClock(sidebarHtml) && sidebarHtml.includes('2h 15m'));
    ok('system history events use the local 24-hour clock', localClock(sidebar.get('intel-history-list').innerHTML));

    const dashboard = load('dashboard.js', { newest_started_at: offset, last_run_at: raw, last_inserted_count: 3 });
    await dashboard.run('refreshBattleReportsWatermark()');
    const watermark = dashboard.get('battle-reports-watermark').textContent;
    ok('sync watermark formats both API and SQLite timestamps consistently',
        localClock(watermark) && watermark.split(expectedClock).length === 3 && watermark.endsWith('(3 new)'), watermark);
    console.log(`${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
