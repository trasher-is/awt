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

ok('setSystemInVision defaults to null (unknown) before any call', systems.getFullSystem(3).is_in_vision == null);
systems.setSystemInVision(3, true);
ok('setSystemInVision(true) stores 1', systems.getFullSystem(3).is_in_vision === 1);
systems.setSystemInVision(3, false);
ok('setSystemInVision(false) stores 0', systems.getFullSystem(3).is_in_vision === 0);

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

systems.upsertTakeover(1, 1, 'caveman', 2, null);
const board = systems.getTakeoverBoard(1);
ok('getTakeoverBoard shows the assigned runner', board[0].assigned_name === 'caveman');

systems.insertBestGuarded(500, '10.5K', '2026-08-27');
ok('countBestGuardedAt finds the inserted row', systems.countBestGuardedAt('2026-08-27') === 1);
systems.clearBestGuarded();
ok('clearBestGuarded empties the table', systems.countBestGuardedAt('2026-08-27') === 0);

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
