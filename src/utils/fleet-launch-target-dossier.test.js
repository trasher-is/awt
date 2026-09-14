// Regression coverage for the fleet-launch target dossier's pure render logic
// (public/js/utils/fleet-launch-target-dossier.js). Dual-mode module (same pattern as
// idle-parse.js/sqlite-time.js), so this just require()s it directly — no DOM, no
// temp-file dynamic-import dance needed.
//
// Run with: node src/utils/fleet-launch-target-dossier.test.js

const { buildTargetDossierHtml, relativeAge, fleetCv, esc } = require('../../public/js/utils/fleet-launch-target-dossier.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('fleet-launch-target-dossier.js');

console.log('\n── relativeAge ' + '─'.repeat(60));
ok('well under a minute reads "just now"', relativeAge(10 * 1000) === 'just now', relativeAge(10 * 1000));
ok('minutes', relativeAge(5 * 60 * 1000) === '5m ago', relativeAge(5 * 60 * 1000));
ok('hours', relativeAge(3 * 3600 * 1000) === '3h ago', relativeAge(3 * 3600 * 1000));
ok('days', relativeAge(50 * 3600 * 1000) === '2d ago', relativeAge(50 * 3600 * 1000));
ok('negative/NaN is null, not a garbage string', relativeAge(-5) === null && relativeAge(NaN) === null);

console.log('\n── fleetCv ' + '─'.repeat(64));
ok('destroyers/cruisers/battleships weighted, transports/colony ships free',
    fleetCv({ transports: 99, colony_ships: 99, destroyers: 10, cruisers: 2, battleships: 1 }) === 10 * 3 + 2 * 24 + 1 * 60,
    fleetCv({ destroyers: 10, cruisers: 2, battleships: 1 }));
ok('missing/null fields default to 0, not NaN', fleetCv({}) === 0 && Number.isFinite(fleetCv({ destroyers: null })));
ok('a null fleet is 0 CV, not a throw', fleetCv(null) === 0);

console.log('\n── esc ' + '─'.repeat(68));
ok('escapes markup-breaking characters', esc(`<script>"'&`) === '&lt;script&gt;&quot;&#39;&amp;');
ok('null/undefined become empty string, not the word "null"', esc(null) === '' && esc(undefined) === '');

console.log('\n── buildTargetDossierHtml: no data on file at all ' + '─'.repeat(24));
ok('never-observed system', /never been observed/.test(buildTargetDossierHtml({ system: null, planet: null, fleets: [], recentBattles: [] })));
ok('observed system, but this specific planet unknown',
    /no intel on file/.test(buildTargetDossierHtml({ system: { id: 1 }, planet: null, fleets: [], recentBattles: [] })));
ok('null data entirely does not throw', buildTargetDossierHtml(null) === '');

console.log('\n── buildTargetDossierHtml: a real target ' + '─'.repeat(33));
const now = Date.parse('2026-09-14T22:00:00Z');
const data = {
    system: { id: 41, name: 'Phact', observed_at: '2026-09-14 21:00:00' }, // 1h before `now`
    planet: {
        planet_index: 7, population: 8, starbase: 3, is_sieged: 1, siege_is_friendly: 0,
        owner_name: 'EnemyGuy', alliance_tag: 'ENEMY', guard_cv: '5000',
    },
    fleets: [
        { owner_name: 'Moardin25', alliance_tag: 'RAID', is_own_alliance: true, destroyers: 60, arrival_time: '2h 00m', arrival_at: '2026-09-15T00:00:00Z' },
        { owner_name: 'SomeEnemy', alliance_tag: 'ENEMY', is_own_alliance: false, cruisers: 5 },
    ],
    recentBattles: [
        { started_at: '2026-09-14 21:30:00', winner: 'Attacker', conquered_planet: 0, att_player_name: 'Moardin25', att_alliance_tag: 'RAID', def_player_name: 'EnemyGuy', def_alliance_tag: 'ENEMY' },
    ],
};
const html = buildTargetDossierHtml(data, { now });
ok('owner + alliance tag shown', html.includes('[ENEMY]') && html.includes('EnemyGuy'));
ok('freshness derived from system.observed_at', html.includes('(last observed 1h ago)'), html);
ok('population and starbase shown', html.includes('Pop 8') && html.includes('SB 3'), html);
ok('best-guarded flag shown', html.includes('Best Guarded'), html);
ok('hostile siege called out in red, not friendly-colored', html.includes('Under siege (hostile)') && html.includes('#f87171'), html);
ok('the RAID fleet is marked as ally', /Moardin25.*\(ally\)/.test(html.replace(/\n/g, ' ')), html);
ok('the RAID fleet\'s CV is computed correctly (60 destroyers × 3)', html.includes('180 CV'), html);
ok('the enemy fleet is present but NOT marked ally', html.includes('SomeEnemy') && !/SomeEnemy.*\(ally\)/.test(html), html);
ok('the recent battle line is included with its outcome', html.includes('attacker won') && html.includes('30m ago'), html);

console.log('\n── buildTargetDossierHtml: a friendly, unsieged, empty planet ' + '─'.repeat(11));
const quiet = buildTargetDossierHtml({
    system: { id: 1, observed_at: null },
    planet: { planet_index: 1, population: 5, starbase: 0, is_sieged: 0, siege_is_friendly: null, owner_name: 'caveman', alliance_tag: 'RAID', guard_cv: null },
    fleets: [],
    recentBattles: [],
}, { now });
ok('no siege line at all when not sieged', !/Under siege/.test(quiet), quiet);
ok('no best-guarded line when guard_cv is falsy', !/Best Guarded/.test(quiet), quiet);
ok('"no fleets detected" shown when the list is empty', /No fleets detected/.test(quiet), quiet);
ok('no freshness note when observed_at is null', !/last observed/.test(quiet), quiet);

console.log('\n── an opponent-controlled name cannot inject markup ' + '─'.repeat(21));
const hostile = buildTargetDossierHtml({
    system: { id: 1, observed_at: null },
    planet: { planet_index: 1, population: 1, starbase: 0, is_sieged: 0, owner_name: '<img src=x onerror=alert(1)>', alliance_tag: '"><script>', guard_cv: null },
    fleets: [], recentBattles: [],
}, { now });
ok('the owner name is escaped, not raw markup', !hostile.includes('<img'), hostile);
ok('the alliance tag is escaped too', !hostile.includes('<script>'), hostile);

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
