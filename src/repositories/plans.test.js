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

// caveman is also a tracked alliance member with a next_culture_at on file, so
// getPlansForSystem's name-matching join (app_users.game_name -> players.name ->
// alliance_member_stats.player_id) has something to find.
const playerResult = db.prepare(`INSERT INTO players (name) VALUES ('caveman')`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id, next_culture_at) VALUES (?, '2026-01-01 00:00:00')`).run(playerResult.lastInsertRowid);

ok('planExists is false before creation', plans.planExists(10, 1) === false);

plans.createPlan(10, 1, cavemanId, 'siege this');
ok('planExists is true after creation', plans.planExists(10, 1) === true);

const forSystem = plans.getPlansForSystem(10);
ok('getPlansForSystem returns the plan with author name', forSystem[0].author === 'caveman');
ok('getPlansForSystem includes the author\'s next_culture_at via the players name match', forSystem[0].next_culture_at === '2026-01-01 00:00:00');

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

// ── getLaunchWindowPlans: every plan of the requester's, whatever sits on the target ──
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (20, 'ColSys', 5, 5)`).run();
db.prepare(`INSERT INTO systems (id, name) VALUES (21, 'NoCoords')`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (900, 'SomePlayer')`).run();

// (a) a free planet — included, no owner.
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (20, 1, NULL)`).run();
plans.createPlan(20, 1, cavemanId, 'colonize this one');

// (b) a planet held by another player — included, with the owner named (2026-09-25: this
// was excluded, and a member's real target vanished from the Science page because of it).
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (20, 2, 900)`).run();
plans.createPlan(20, 2, cavemanId, 'someone lives here');

// (c) a planet the hub has never scanned — included: travel only needs the system's x/y.
plans.createPlan(20, 3, cavemanId, 'never scanned');

// (d) a system with no coordinates — excluded, there is no travel time to compute.
plans.createPlan(21, 1, cavemanId, 'unmapped');

// (e) a DIFFERENT author's plan — excluded. Everyone sees only their own launch windows.
const otherUserResult = db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES ('otherplayer', 'x')`).run();
const otherUserId = otherUserResult.lastInsertRowid;
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (20, 4, NULL)`).run();
plans.createPlan(20, 4, otherUserId, 'someone else\'s target');

const mine = plans.getLaunchWindowPlans(cavemanId);
ok('free, occupied and never-scanned plans are all included', mine.map(p => p.planet_index).join(',') === '1,2,3', mine);
ok('an occupied target names its current owner', mine.find(p => p.planet_index === 2).owner_name === 'SomePlayer', mine);
ok('free and never-scanned targets have no owner', mine.find(p => p.planet_index === 1).owner_name === null && mine.find(p => p.planet_index === 3).owner_name === null, mine);
ok('a system without coordinates is left out', !mine.some(p => p.system_id === 21), mine);
ok('it carries the system name and coordinates for a travel-time calc',
    mine[0].system_name === 'ColSys' && mine[0].x === 5 && mine[0].y === 5, mine);
ok('the other author\'s plan does not leak into caveman\'s results', !mine.some(p => p.planet_index === 4), mine);

const otherResults = plans.getLaunchWindowPlans(otherUserId);
ok('the other author sees only their own plan', otherResults.length === 1 && otherResults[0].planet_index === 4, otherResults);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
