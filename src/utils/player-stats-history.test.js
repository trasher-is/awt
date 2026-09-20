// applyStatsHistory (2026-09-20): pulls building totals + per-planet maximums out of the
// `var data = [...]` array embedded in a /Game/Players/Statistic response — the same array
// that page's own BuildingsChart/PlanetsChart render from (imported via
// /js/modules/statistic/planet.js). Feeds player-parser.js's scrapePlayer, which in turn
// feeds the profile Buildings card's Total/Avg/Max columns.
//
// public/js/scrapers/player-parser.js is a real ES module, so — same technique as
// my-planets-parser.test.js — this strips the import/export keywords and runs the source
// in a vm context. applyStatsHistory itself is pure regex/JSON/parseInt (no DOM, no
// globalThis helpers), so no stubs are needed to call it.
//
// The fixture below is trimmed from a real response body (same alliance, 2026-09-16):
// two real records — the earliest and the latest of a much longer history — kept verbatim
// so the regex and JSON.parse run against real game markup, not an idealized shape.
//
// Run with: node src/utils/player-stats-history.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scrapers', 'player-parser.js'), 'utf8');
const fnStart = source.indexOf('export function applyStatsHistory');
const fnEnd = source.indexOf('\n}\n', fnStart);
if (fnStart === -1 || fnEnd === -1) {
    console.error('applyStatsHistory not found where the test expects it — source may have moved.');
    process.exit(1);
}
const context = vm.createContext({ console, JSON });
vm.runInContext(`globalThis.__exports = (function(){ ${source.slice(fnStart, fnEnd + 2).replace(/^export /, '')}\nreturn { applyStatsHistory }; })();`, context);
const { applyStatsHistory } = context.__exports;

console.log('applyStatsHistory');

// Real earliest and latest records from a real /Game/Players/Statistic response body
// (2026-09-06 through 2026-09-16), trimmed from a much longer array.
const REAL_RESPONSE_BODY = `
    <script type="module">
        import {BuildingsChart, PlanetsChart} from "/js/modules/statistic/planet.js?v=tBf1YiTLcIA5eoLo_g_ih5kWAAJoWoGVa8XT8DTGF8g";

        Chart.defaults.backgroundColor = '#231E64';
        Chart.defaults.borderColor = '#444';
        Chart.defaults.color = '#FFF';

        var data = [{"count":2,"cybernets":17,"factories":17,"farms":13,"labs":13,"maxCybernet":10,"maxFactory":10,"maxFarm":8,"maxLab":8,"maxPopulation":6,"maxStarbase":3,"maxSystems":2,"population":10,"starbase":3,"systems":1,"avgCybernets":8.5,"avgFactories":8.5,"avgFarms":6.5,"avgLabs":6.5,"avgPopulation":5,"forDateTime":"2026-09-06T00:00:00+02:00","dateTimeFormatted":"Sept 06 - 01:00","statisticId":876,"createdAt":"2026-09-06T00:00:06.3803773+02:00","deletedAt":null,"id":404955,"isDeleted":false,"lastUpdatedAt":"2026-09-06T00:00:06.3803773+02:00","rowVersion":"AAAAABVOJFc="},{"count":6,"cybernets":61,"factories":61,"farms":51,"labs":49,"maxCybernet":14,"maxFactory":13,"maxFarm":10,"maxLab":10,"maxPopulation":10,"maxStarbase":7,"maxSystems":6,"population":43,"starbase":21,"systems":4,"avgCybernets":10.17,"avgFactories":10.17,"avgFarms":8.5,"avgLabs":8.17,"avgPopulation":7.17,"forDateTime":"2026-09-16T21:00:00+02:00","dateTimeFormatted":"Sept 16 - 22:00","statisticId":876,"createdAt":"2026-09-16T21:00:05.0053784+02:00","deletedAt":null,"id":417563,"isDeleted":false,"lastUpdatedAt":"2026-09-16T21:00:05.0053784+02:00","rowVersion":"AAAAABWXNYw="}];

        new BuildingsChart(data, "buildings");
        new PlanetsChart(data, "planets");
    </script>
`;

console.log('\n── Against a real (trimmed) response body ' + '─'.repeat(34));
{
    const p = { total_planets: 0, total_population: 0 };
    const applied = applyStatsHistory(p, REAL_RESPONSE_BODY);
    ok('reports it applied a record', applied === true);
    ok('totals come from the LAST record, not the first', p.total_farms === 51 && p.total_factories === 61 && p.total_labs === 49 && p.total_cybernetics === 61, p);
    ok('max_* come from the same last record\'s maxFarm/maxFactory/maxLab/maxCybernet',
        p.max_farms === 10 && p.max_factories === 13 && p.max_labs === 10 && p.max_cybernetics === 14, p);
    ok('total_planets/total_population fall back to the record only when the profile scrape had none',
        p.total_planets === 6 && p.total_population === 43, p);
}

console.log('\n── total_planets/total_population from the profile scrape are not overwritten ' + '─'.repeat(2));
{
    const p = { total_planets: 9, total_population: 99 };
    applyStatsHistory(p, REAL_RESPONSE_BODY);
    ok('a non-zero profile-scrape value wins over the history record', p.total_planets === 9 && p.total_population === 99, p);
}

console.log('\n── No "var data" block at all ' + '─'.repeat(45));
{
    const p = { total_farms: 5, max_farms: null };
    const applied = applyStatsHistory(p, '<html>obfuscation wall — no chart here</html>');
    ok('reports it applied nothing', applied === false);
    ok('leaves the existing values untouched rather than zeroing them', p.total_farms === 5 && p.max_farms === null, p);
}

console.log('\n── An empty history array ' + '─'.repeat(49));
{
    const p = { total_farms: 5 };
    const applied = applyStatsHistory(p, 'var data = [];\nnew BuildingsChart(data, "buildings");');
    ok('reports it applied nothing', applied === false);
    ok('leaves the existing values untouched', p.total_farms === 5, p);
}

console.log('\n── A record missing the max* fields (older game version, say) ' + '─'.repeat(11));
{
    const p = {};
    applyStatsHistory(p, 'var data = [{"farms":3,"factories":2,"labs":1,"cybernets":1}];\nnew BuildingsChart(data, "buildings");');
    ok('totals still apply', p.total_farms === 3 && p.total_factories === 2, p);
    ok('max_* come back null, not NaN or 0, when the field is simply absent',
        p.max_farms === null && p.max_factories === null && p.max_labs === null && p.max_cybernetics === null, p);
}

console.log('\n' + '─'.repeat(77));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
