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

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
