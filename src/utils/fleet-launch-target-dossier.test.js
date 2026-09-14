// Regression coverage for the fleet-launch target dossier's pure render logic
// (public/js/utils/fleet-launch-target-dossier.js). Dual-mode module (same pattern as
// idle-parse.js/sqlite-time.js), so this just require()s it directly — no DOM, no
// temp-file dynamic-import dance needed.
//
// Run with: node src/utils/fleet-launch-target-dossier.test.js

const { buildTargetDossierHtml, relativeAge, relativeCountdown, fleetCv, esc } = require('../../public/js/utils/fleet-launch-target-dossier.js');

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

console.log('\n── relativeCountdown ' + '─'.repeat(54));
ok('under a minute reads "under 1m", not "0m"', relativeCountdown(10 * 1000) === 'under 1m', relativeCountdown(10 * 1000));
ok('minutes', relativeCountdown(5 * 60 * 1000) === '5m', relativeCountdown(5 * 60 * 1000));
ok('hours and minutes together', relativeCountdown(2 * 3600 * 1000) === '2h 0m', relativeCountdown(2 * 3600 * 1000));
ok('hours and minutes, non-zero remainder', relativeCountdown(2 * 3600 * 1000 + 15 * 60 * 1000) === '2h 15m', relativeCountdown(2 * 3600 * 1000 + 15 * 60 * 1000));
ok('days and hours', relativeCountdown(50 * 3600 * 1000) === '2d 2h', relativeCountdown(50 * 3600 * 1000));
ok('already past due reads "landing now", not a negative duration', relativeCountdown(-5000) === 'landing now', relativeCountdown(-5000));
ok('exactly zero also reads "landing now"', relativeCountdown(0) === 'landing now');
ok('NaN is null, not a garbage string', relativeCountdown(NaN) === null);

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
        // Has a real parsed arrival timestamp 2h15m after `now` — should show a live
        // countdown, not the frozen scraped string.
        { owner_name: 'Moardin25', alliance_tag: 'RAID', is_own_alliance: true, destroyers: 60, arrival_time: 'stale scraped text', arrival_at: '2026-09-15T00:15:00Z' },
        // Only the raw scraped ETA text, no parsed timestamp — falls back to showing it as-is.
        { owner_name: 'SomeEnemy', alliance_tag: 'ENEMY', is_own_alliance: false, cruisers: 5, arrival_time: '45m' },
        // No arrival data at all — already sitting in orbit.
        { owner_name: 'AnotherEnemy', alliance_tag: 'ENEMY', is_own_alliance: false, battleships: 1 },
    ],
    recentBattles: [
        // At the exact target planet (#7) — should read "here".
        { started_at: '2026-09-14 21:30:00', winner: 'Attacker', conquered_planet: 0, planet_index: 7, att_player_name: 'Moardin25', att_alliance_tag: 'RAID', def_player_name: 'EnemyGuy', def_alliance_tag: 'ENEMY' },
        // Elsewhere in the same system — should read "#3", not "here".
        { started_at: '2026-09-14 20:00:00', winner: 'Defender', conquered_planet: 0, planet_index: 3, att_player_name: 'SomeoneElse', def_player_name: 'EnemyGuy' },
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
ok('a fleet WITH a parsed arrival shows a live countdown, not the stale scraped string',
    html.includes('lands in 2h 15m') && !html.includes('stale scraped text'), html);
ok('a fleet with ONLY the raw scraped text falls back to showing it',
    html.includes('ETA 45m'), html);
ok('a fleet with no arrival data at all is shown as already in orbit',
    /AnotherEnemy.*in orbit/.test(html.replace(/\n/g, ' ')), html);
ok('the enemy fleet is present but NOT marked ally', html.includes('SomeEnemy') && !/SomeEnemy.*\(ally\)/.test(html), html);
ok('a battle at the exact target planet is labelled "here"',
    /here.*attacker won/.test(html.replace(/\n/g, ' ')) && html.includes('30m ago'), html);
ok('a battle elsewhere in the same system is labelled by its own planet number, not "here"',
    /#3.*defender won/.test(html.replace(/\n/g, ' ')), html);

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
