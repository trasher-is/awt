const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const fleets = require('./fleets');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('fleets.test.js');

db.prepare(`INSERT INTO players (id, name) VALUES (1, 'caveman')`).run();

ok('countFleets starts at 0', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
ok('countFleets is 1 after insert', fleets.countFleets() === 1);

const forSystem = fleets.getFleetsForSystem(10);
ok('getFleetsForSystem returns the fleet', forSystem.length === 1 && forSystem[0].owner_name === 'caveman');

const upd = fleets.updateFleetGameId(999, 1, 10, 1);
ok('updateFleetGameId updates one row', upd.changes === 1);

fleets.deleteFleetsByOwner(1);
ok('deleteFleetsByOwner removes the fleet', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
fleets.deleteAllFleets();
ok('deleteAllFleets empties the table', fleets.countFleets() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
