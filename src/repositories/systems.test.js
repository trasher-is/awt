// Smoke test: does the module load, do its statements compile, do the basic functions
// return the right shape? Not a full behavior suite — see the migration tasks for the
// manual verification that carries the real risk.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const systems = require('./systems');

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

systems.upsertSystemStub(2);
ok('upsertSystemStub creates a bare row', systems.getFullSystem(2).id === 2);
ok('upsertSystemStub row has null name', systems.getFullSystem(2).name === null);

const byIds = systems.getSystemsByIds([1, 2, 999]);
ok('getSystemsByIds returns only existing ids', byIds.length === 2);

systems.upsertPlanet(500, 1, 1, null, 1000, 3, 0);
const planets = systems.getSystemPlanetsWithIntel(1);
ok('getSystemPlanetsWithIntel returns the planet', planets.length === 1 && planets[0].population === 1000);

ok('countPlanets is 1', systems.countPlanets() === 1);

systems.clearMovedPlanet(500, 1, 1);
ok('clearMovedPlanet does not remove a planet at its current location', systems.countPlanets() === 1);

systems.upsertPlanet(600, 2, 1, null, 500, 2, 0);
ok('countPlanets is 2 after second upsert', systems.countPlanets() === 2);
systems.clearMovedPlanet(600, 2, 2); // planet 600 "moved" to system 2/index 2
ok('clearMovedPlanet removes the stale row at the planet\'s old location', systems.countPlanets() === 1);

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
