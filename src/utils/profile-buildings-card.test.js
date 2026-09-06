// The Buildings card on a player's profile: total AND average per planet (issue #119).
//
// Run with:  node src/utils/profile-buildings-card.test.js
//
// page-injections.js is browser-only ESM that touches the game page's DOM at call time, so
// the card builder is lifted out of the source text and evaluated here with the two helpers
// it uses stubbed. If the function is renamed or its helpers change, this test fails loudly
// rather than silently testing nothing — that is the point of the extraction checks below.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'core', 'page-injections.js'), 'utf8');

console.log('── Lifting buildBuildingsCard out of page-injections.js ' + '─'.repeat(19));
const rowsStart = src.indexOf('const BUILDING_ROWS = [');
const fnStart = src.indexOf('function buildBuildingsCard(p) {');
const fnEnd = src.indexOf('\n}\n', fnStart);
ok('BUILDING_ROWS and buildBuildingsCard are where the test expects them', rowsStart !== -1 && fnStart !== -1 && fnEnd !== -1 && rowsStart < fnStart, [rowsStart, fnStart, fnEnd]);

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatSqliteUtc = ts => `formatted(${ts})`;
const build = new Function('esc', 'formatSqliteUtc', `${src.slice(rowsStart, fnEnd + 2)}\nreturn buildBuildingsCard;`)(esc, formatSqliteUtc);
ok('the lifted function is callable', typeof build === 'function');

// Strip tags to compare cell text; keep the row structure.
const cellsOf = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1].replace(/<[^>]+>/g, '').trim()));

console.log('\n── Total and average per planet ' + '─'.repeat(43));
const html = build({ total_planets: 6, planet_count: 4, total_farms: 36, total_factories: 45, total_labs: 18, total_cybernetics: 9, stats_scraped_at: '2026-09-05 10:00:00' });
const rows = cellsOf(html);
const byLabel = Object.fromEntries(rows.filter(r => r.length === 3 && r[0] && !/Total|Avg/.test(r[1])).map(r => [r[0], r]));
ok('every building has Total and Avg/planet', ['Farms', 'Factories', 'Labs', 'Cybernetics'].every(k => byLabel[k] && byLabel[k].length === 3), Object.keys(byLabel));
ok('Farms: 36 total, 6.0 per planet over the profile\'s 6 planets — not the 4 the hub scanned', byLabel.Farms[1] === '36' && byLabel.Farms[2] === '6.0', byLabel.Farms);
ok('Factories 45 → 7.5', byLabel.Factories[2] === '7.5', byLabel.Factories);
ok('Labs 18 → 3.0, Cybernetics 9 → 1.5', byLabel.Labs[2] === '3.0' && byLabel.Cybernetics[2] === '1.5');
ok('an "All buildings" row sums the four and averages the sum', byLabel['All buildings'] && byLabel['All buildings'][1] === '108' && byLabel['All buildings'][2] === '18.0', byLabel['All buildings']);
ok('the header names the denominator', /Avg \/ planet[\s\S]*\(6\)/.test(html));
ok('the header keeps the "4 day old data" disclaimer and the scrape-time tooltip', /4 day old data/.test(html) && /Hub last scraped this: formatted\(2026-09-05 10:00:00\)/.test(html));
ok('no per-planet maximum is invented', !/Max/i.test(html.replace(/<[^>]+>/g, '')));

console.log('\n── Degenerate inputs ' + '─'.repeat(54));
const none = cellsOf(build({}));
const noneBy = Object.fromEntries(none.filter(r => r.length === 3).map(r => [r[0], r]));
ok('no planet count on record: totals show 0 and the average is a dash, not NaN or Infinity',
    noneBy.Farms && noneBy.Farms[1] === '0' && noneBy.Farms[2] === '—' && !/NaN|Infinity/.test(build({})), noneBy.Farms);
const fallback = cellsOf(build({ planet_count: 3, total_farms: 9 }));
ok('without a profile planet count the hub\'s scanned planets are the fallback denominator',
    fallback.find(r => r[0] === 'Farms')[2] === '3.0');
ok('string totals from an old scrape are tolerated', cellsOf(build({ total_planets: '2', total_farms: '7' })).find(r => r[0] === 'Farms')[2] === '3.5');
ok('a NaN stamp does not break the card', /Farms/.test(build({ total_planets: 'x', total_farms: null })));

console.log('\n── It is still the card the profile injection renders ' + '─'.repeat(21));
ok('initProfileHubIntel places buildBuildingsCard(p) in the hub block', /buildBuildingsCard\(p\)/.test(src.slice(src.indexOf('export async function initProfileHubIntel'), fnStart)));

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
