// Server-side scheduler for 'random_target' bonus goals — no client involvement needed
// (see bonusGoals.js's own header comment): the target is picked from data the hub
// already has, so the "is it time yet" decision and the actual pick both happen here,
// independent of any member's browser being open.
const bonusGoalsRepo = require('../repositories/bonusGoals');

// 10 minutes is fine granularity for "somewhere in a multi-hour window" without spending
// a full setInterval tick on every request — each check is a cheap, idempotent no-op
// unless a goal's scheduled roll time has actually arrived (see maybeActivateRandomTarget).
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

function tick() {
    for (const goal of bonusGoalsRepo.listEnabledGoalsByType('random_target')) {
        try {
            bonusGoalsRepo.maybeActivateRandomTarget(goal.id, goal.config);
        } catch (err) {
            console.error(`[BonusGoals] random_target scheduler failed for goal ${goal.id}:`, err.message);
        }
    }
}

let started = false;
function startBonusGoalsScheduler() {
    if (started) return;
    started = true;
    tick();
    setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { startBonusGoalsScheduler, CHECK_INTERVAL_MS };
