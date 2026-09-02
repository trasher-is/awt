const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const plans = require('./plans');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('plans.test.js');

// Insert without specifying id to avoid conflict with the admin account created during initialization
const userResult = db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES ('caveman', 'x')`).run();
const cavemanId = userResult.lastInsertRowid;

// Insert a system for the foreign key constraint
db.prepare(`INSERT INTO systems (id, name) VALUES (10, 'TestSys')`).run();

ok('planExists is false before creation', plans.planExists(10, 1) === false);

plans.createPlan(10, 1, cavemanId, 'siege this');
ok('planExists is true after creation', plans.planExists(10, 1) === true);

const forSystem = plans.getPlansForSystem(10);
ok('getPlansForSystem returns the plan with author name', forSystem[0].author === 'caveman');

const detailed = plans.getPlansForSystemDetailed(10);
ok('getPlansForSystemDetailed includes updated_at', 'updated_at' in detailed[0]);

const index = plans.getAllPlanIndex();
ok('getAllPlanIndex lists the pair', index.length === 1 && index[0].system_id === 10);

const asAuthor = plans.deletePlanAsAuthor(10, 1, 999);
ok('deletePlanAsAuthor does not delete for a different author', asAuthor.changes === 0);

const asAdmin = plans.deletePlanAsAdmin(10, 1);
ok('deletePlanAsAdmin deletes regardless of author', asAdmin.changes === 1);
ok('planExists is false after admin delete', plans.planExists(10, 1) === false);

// Insert system 11 for the next plan
db.prepare(`INSERT INTO systems (id, name) VALUES (11, 'TestSys2')`).run();

plans.createPlan(11, 2, cavemanId, 'note');
plans.deleteAllPlans();
ok('deleteAllPlans empties the table', plans.getAllPlanIndex().length === 0);

// ── getColonizablePlans: plans worth a launch-window calc ──
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (20, 'ColSys', 5, 5)`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (900, 'SomePlayer')`).run();

// (a) a plan on a confirmed-empty planet (owner_id NULL, real planets row exists) — included.
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (20, 1, NULL)`).run();
plans.createPlan(20, 1, cavemanId, 'colonize this one');

// (b) a plan on a planet that IS owned — excluded, it's not actually colonizable.
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (20, 2, 900)`).run();
plans.createPlan(20, 2, cavemanId, 'someone lives here');

// (c) a plan on a planet the hub has never scanned (no planets row at all) — excluded,
// "confirmed empty" only, not "presumed empty".
plans.createPlan(20, 3, cavemanId, 'never scanned');

const colonizable = plans.getColonizablePlans();
ok('exactly one plan qualifies (confirmed-empty planet)', colonizable.length === 1, colonizable);
ok('the qualifying plan is the one on the confirmed-empty planet',
    colonizable[0].system_id === 20 && colonizable[0].planet_index === 1, colonizable);
ok('it carries the system name and coordinates for a travel-time calc',
    colonizable[0].system_name === 'ColSys' && colonizable[0].x === 5 && colonizable[0].y === 5, colonizable);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
