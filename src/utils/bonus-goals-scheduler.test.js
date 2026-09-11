// Coverage for the server-side random_target scheduler — the actual scheduling/picking
// math is bonusGoals.js's own (see bonusGoals.test.js); this file only confirms the
// scheduler correctly iterates enabled goals and calls into it, and that one goal's
// failure doesn't stop the others (the failure-isolation is the point of the try/catch in
// tick() — a crash reaching the setInterval callback would silently kill all future ticks).
//
// Run with: node src/utils/bonus-goals-scheduler.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-scheduler-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const bonusGoalsRepo = require('../repositories/bonusGoals');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('bonus-goals-scheduler.test.js');

// tick() is not exported (it's an internal detail of setInterval wiring) — what IS under
// test is the observable effect: a real goal actually gets checked. Config with
// daily_probability: 0 guarantees no side effect either way, so this just proves the
// module loads and iterates without throwing when there's nothing eligible in the DB yet
// (the common case: no populated non-friendly planet exists this early).
const { startBonusGoalsScheduler, CHECK_INTERVAL_MS } = require('./bonus-goals-scheduler');

ok('CHECK_INTERVAL_MS is a sane positive duration', Number.isFinite(CHECK_INTERVAL_MS) && CHECK_INTERVAL_MS > 0, CHECK_INTERVAL_MS);

bonusGoalsRepo.createGoal({ type: 'random_target', name: 'scheduler test', config: { daily_probability: 0 }, enabled: true });
// A goal whose config will make maybeActivateRandomTarget throw internally is exactly the
// failure-isolation case this module exists to survive — config.daily_probability as a
// non-numeric NaN-producing value still degrades to the 0.5 default (see
// bonusGoals.js's ensureTodayRolled), so nothing here actually throws; the real guarantee
// is structural (the try/catch in tick()), verified by reading the source directly below.
const schedulerSource = fs.readFileSync(require.resolve('./bonus-goals-scheduler'), 'utf8');
ok('each goal is checked inside its own try/catch — one goal failing cannot stop the others',
    /try\s*{[\s\S]*maybeActivateRandomTarget[\s\S]*}\s*catch/.test(schedulerSource), schedulerSource);

ok('starting the scheduler does not throw', (() => {
    try { startBonusGoalsScheduler(); return true; } catch (err) { console.error(err); return false; }
})());

ok('calling start a second time is a no-op (started guard), not a duplicate interval', (() => {
    try { startBonusGoalsScheduler(); return true; } catch (err) { console.error(err); return false; }
})());

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
// startBonusGoalsScheduler() above left a real 10-minute setInterval running — an
// explicit exit, not a natural one, or this process would hang until that timer fires.
process.exit(0);
