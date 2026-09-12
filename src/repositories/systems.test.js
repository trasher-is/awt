// Smoke test: does the module load, do its statements compile, do the basic functions
// return the right shape? Not a full behavior suite — see the migration tasks for the
// manual verification that carries the real risk.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const systems = require('./systems');
const db = require('../database');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('systems.test.js');

ok('countSystems starts at 0', systems.countSystems() === 0);

systems.upsertSystemFull(1, 'Rana', 10, 20);
const coords = systems.getSystemCoords(1);
ok('getSystemCoords name matches', coords.name === 'Rana');
ok('getSystemCoords x matches', coords.x === 10);
ok('countSystems is 1 after upsert', systems.countSystems() === 1);

systems.upsertSystemFull(3, 'Ceginus', 5, -5, 'Ceginus Prime', 'A quiet frontier system', 42);
const detailed = systems.getFullSystem(3);
ok('upsertSystemFull stores full_name', detailed.full_name === 'Ceginus Prime');
ok('upsertSystemFull stores info', detailed.info === 'A quiet frontier system');
ok('upsertSystemFull stores population_level', detailed.population_level === 42);

// A DOM scraper only ever sends (id, name, x, y) — no fullName/info/populationLevel — so a
// scrape running after an API seed must not null out the metadata the API seed captured.
systems.upsertSystemFull(3, 'Ceginus', 5, -5);
const afterScrape = systems.getFullSystem(3);
ok('a later upsertSystemFull call without fullName/info/populationLevel preserves full_name', afterScrape.full_name === 'Ceginus Prime');
ok('a later upsertSystemFull call without fullName/info/populationLevel preserves info', afterScrape.info === 'A quiet frontier system');
ok('a later upsertSystemFull call without fullName/info/populationLevel preserves population_level', afterScrape.population_level === 42);

ok('setSystemInVision defaults to null (unknown) before any call', systems.getFullSystem(3).is_in_vision == null);
ok('setSystemInVision(true) returns changes=1 for an existing row', systems.setSystemInVision(3, true) === 1);
ok('setSystemInVision(true) stores 1', systems.getFullSystem(3).is_in_vision === 1);
systems.setSystemInVision(3, false);
ok('setSystemInVision(false) stores 0', systems.getFullSystem(3).is_in_vision === 0);
ok('setSystemInVision on an unknown id returns changes=0', systems.setSystemInVision(999999, true) === 0);

systems.upsertSystemStub(2);
ok('upsertSystemStub creates a bare row', systems.getFullSystem(2).id === 2);
ok('upsertSystemStub row has null name', systems.getFullSystem(2).name === null);

const byIds = systems.getSystemsByIds([1, 2, 999]);
ok('getSystemsByIds returns only existing ids', byIds.length === 2);

systems.upsertPlanet(500, 1, 1, null, 1000, 3, 0, 0);
const planets = systems.getSystemPlanetsWithIntel(1);
ok('getSystemPlanetsWithIntel returns the planet', planets.length === 1 && planets[0].population === 1000);

ok('countPlanets is 1', systems.countPlanets() === 1);

const oldPlanet = systems.getOldPlanet(1, 1);
ok('getOldPlanet includes starbase/has_fleet/is_sieged for the fog-of-war guard', oldPlanet.starbase === 3 && oldPlanet.has_fleet === 0 && oldPlanet.is_sieged === 0);

systems.upsertPlanet(500, 1, 1, null, 1000, 3, 0, 1);
ok('upsertPlanet writes is_sieged', systems.getOldPlanet(1, 1).is_sieged === 1);

systems.clearMovedPlanet(500, 1, 1);
ok('clearMovedPlanet does not remove a planet at its current location', systems.countPlanets() === 1);

systems.upsertPlanet(600, 2, 1, null, 500, 2, 0, 0);
ok('countPlanets is 2 after second upsert', systems.countPlanets() === 2);
systems.clearMovedPlanet(600, 2, 2); // planet 600 "moved" to system 2/index 2
ok('clearMovedPlanet removes the stale row at the planet\'s old location', systems.countPlanets() === 1);

// Placed here (rather than immediately after the earlier countPlanets===1 check per the
// brief) because inserting it there permanently adds a second planet row, which breaks the
// count-based assertions in the clearMovedPlanet block above. This spot is after all
// count-sensitive assertions and before the final deleteAllPlanets() cleanup, so it's safe.
systems.upsertPlanet(501, 1, 2, null, 500, 1, 0, 0, 'Named Planet');
const namedPlanet = db.prepare('SELECT name FROM planets WHERE system_id = 1 AND planet_index = 2').get();
ok('upsertPlanet with a name stores it', namedPlanet.name === 'Named Planet');

systems.upsertPlanet(501, 1, 2, null, 500, 1, 0, 0); // no name arg this time
const afterNoNameCall = db.prepare('SELECT name FROM planets WHERE system_id = 1 AND planet_index = 2').get();
ok('a later call with no name preserves the previously-stored name', afterNoNameCall.name === 'Named Planet');

systems.logPlanetEvent(1, 1, 1, null, 42);
const history = systems.getPlanetHistory(1);
ok('getPlanetHistory returns the logged event', history.length === 1 && history[0].new_value === 42);

// getRecentPopDrop: used by /sync/news to credit a non-battle conquest's population.
db.prepare(`
    INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp)
    VALUES (1, 5, 2, 20, 10, '2026-09-05 19:00:00'), (1, 5, 2, 10, 0, '2026-09-05 19:10:00')
`).run();
const noneYet = systems.getRecentPopDrop(1, 5, '2026-09-05T18:59:59.000Z');
ok('getRecentPopDrop finds nothing before either drop was logged', noneYet === null, noneYet);
const firstDrop = systems.getRecentPopDrop(1, 5, '2026-09-05T19:05:00.000Z');
ok('getRecentPopDrop returns the closest drop AT-OR-BEFORE an ISO timestamp (compared via SQLite datetime(), not raw string equality)',
    firstDrop && firstDrop.old_value === 20 && firstDrop.new_value === 10, firstDrop);
const latestDrop = systems.getRecentPopDrop(1, 5, '2026-09-05T19:10:00.000Z');
ok('getRecentPopDrop picks the LATEST matching drop when several qualify (inclusive at-or-before)',
    latestDrop && latestDrop.old_value === 10 && latestDrop.new_value === 0, latestDrop);

systems.upsertTakeover(1, 1, 'caveman', 2, null);
const board = systems.getTakeoverBoard(1);
ok('getTakeoverBoard shows the assigned runner', board[0].assigned_name === 'caveman');

systems.insertBestGuarded(500, '10.5K', '2026-08-27');
ok('countBestGuardedAt finds the inserted row', systems.countBestGuardedAt('2026-08-27') === 1);
systems.clearBestGuarded();
ok('clearBestGuarded empties the table', systems.countBestGuardedAt('2026-08-27') === 0);

// checkAndUpdateSystemSecured (2026-09-12): fires the "system closed" Discord milestone
// only on the 0->1 transition. own alliance [RAID] and ally [NAP1] both count as friendly.
db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders'), (2, 'NAP1', 'Allies'), (3, 'FOE', 'Enemies')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (901, 'Raider1', 1), (902, 'Ally1', 2), (903, 'Enemy1', 3)`).run();
systems.upsertSystemFull(900, 'Secured Test System', 1, 1);
const friendly = new Set(['RAID', 'NAP1']);

systems.upsertPlanet(90001, 900, 1, 901, 5, 0, 0, 0); // RAID-owned
systems.upsertPlanet(90002, 900, 2, null, 0, 0, 0, 0); // Free — must not block "secured"
ok('an untouched-by-enemies system with only friendly/free planets is secured',
    systems.checkAndUpdateSystemSecured(900, friendly) === 'secured');
ok('re-checking an already-secured system with no change returns null (no re-announce)',
    systems.checkAndUpdateSystemSecured(900, friendly) === null);

systems.upsertPlanet(90003, 900, 3, 903, 4, 0, 0, 0); // FOE takes a planet
ok('an enemy taking a planet loses the secured status, silently ("lost", not "secured")',
    systems.checkAndUpdateSystemSecured(900, friendly) === 'lost');
ok('re-checking the now-lost system with no further change returns null',
    systems.checkAndUpdateSystemSecured(900, friendly) === null);

systems.upsertPlanet(90003, 900, 3, 902, 4, 0, 0, 0); // NAP1 retakes it — re-secured
ok('re-securing after a loss announces again (a fresh 0->1 transition)',
    systems.checkAndUpdateSystemSecured(900, friendly) === 'secured');

db.prepare(`UPDATE planets SET owner_id = NULL WHERE game_planet_id IN (90001, 90002, 90003)`).run();
ok('a system with zero real owners is never "secured" (nothing has actually been claimed)',
    systems.checkAndUpdateSystemSecured(900, friendly) === 'lost');

// getBestGuardedInArea / diffAndReplaceBestGuardedAreaWatch (2026-09-12): "all top50 in
// the area", not just #1/top10 — filters the FULL Best Guarded snapshot down to planets
// owned by a friendly tag, or within a flat radius (systemDistance <= radiusSystems) of
// one. Friendly ownership restored on system 900 (RAID) as the one reference point.
db.prepare(`UPDATE planets SET owner_id = 901 WHERE game_planet_id = 90001`).run();
systems.upsertSystemFull(910, 'Nearby System', 7, 1); // distance from (1,1) = 6 — exactly at the radius
systems.upsertSystemFull(920, 'Far System', 100, 100); // way outside any reasonable radius
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (904, 'Neighbor1', 3), (905, 'Stranger1', 3)`).run();
systems.upsertPlanet(91001, 910, 1, 904, 6, 3, 0, 0);
systems.upsertPlanet(92001, 920, 1, 905, 8, 2, 0, 0);
systems.insertBestGuarded(90001, '5K', '2026-09-12'); // in-area: our own system
systems.insertBestGuarded(91001, '12K', '2026-09-12'); // in-area: exactly at radius 6
systems.insertBestGuarded(92001, '30K', '2026-09-12'); // out of area

const inArea = systems.getBestGuardedInArea(friendly, 6);
const inAreaIds = inArea.map(r => r.game_planet_id).sort();
ok('in-area includes our own system\'s guarded planet', inAreaIds.includes(90001), inAreaIds);
ok('in-area includes a planet exactly at the radius boundary (inclusive)', inAreaIds.includes(91001), inAreaIds);
ok('the far planet is excluded', !inAreaIds.includes(92001), inAreaIds);
ok('exactly two planets are in area', inAreaIds.length === 2, inAreaIds);

const firstDiff = systems.diffAndReplaceBestGuardedAreaWatch(inAreaIds);
ok('a fresh watch (nothing stored before) reports everything as newly entered', firstDiff.entered.sort().join(',') === inAreaIds.join(','), firstDiff);
ok('nothing has left on the very first diff', firstDiff.left.length === 0, firstDiff);

const secondDiff = systems.diffAndReplaceBestGuardedAreaWatch(inAreaIds);
ok('re-checking the same set entered/left nothing (no repeat announcements)',
    secondDiff.entered.length === 0 && secondDiff.left.length === 0, secondDiff);

const thirdDiff = systems.diffAndReplaceBestGuardedAreaWatch([90001]); // 91001 dropped, nothing new
ok('a planet dropping off the guarded list in the area is reported as "left"', thirdDiff.left.join(',') === '91001', thirdDiff);
ok('nothing new entered on that same check', thirdDiff.entered.length === 0, thirdDiff);

// getBestPlanetsFriendlyCoverage (2026-09-12): resolves ownership from the planets/players/
// alliances tables (our own synced truth), never from the ranking page's own owner text.
systems.insertBestPlanetsSnapshot(90001, 1, '2026-09-12'); // owned by RAID (player 901)
systems.insertBestPlanetsSnapshot(91001, 2, '2026-09-12'); // owned by FOE (player 904)
systems.insertBestPlanetsSnapshot(92001, 3, '2026-09-12'); // owned by FOE (player 905)

const coverage = systems.getBestPlanetsFriendlyCoverage(friendly);
ok('friendly coverage counts only the RAID/NAP1-owned planet', coverage.friendly === 1, coverage);
ok('total reflects the whole snapshot regardless of ownership', coverage.total === 3, coverage);

const noFriendly = systems.getBestPlanetsFriendlyCoverage(new Set());
ok('an empty friendly-tags set counts zero friendly, but still reports the real total', noFriendly.friendly === 0 && noFriendly.total === 3, noFriendly);

systems.clearBestPlanetsSnapshot();
ok('clearBestPlanetsSnapshot empties it', systems.getBestPlanetsFriendlyCoverage(friendly).total === 0);

systems.deleteAllPlanets();
ok('deleteAllPlanets empties planets', systems.countPlanets() === 0);
systems.deleteAllSystems();
ok('deleteAllSystems empties systems', systems.countSystems() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
