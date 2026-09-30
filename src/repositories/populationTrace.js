const db = require('../database');

// Long enough to cover a wrong figure that sits unnoticed for days before something corrects
// it — the case this table exists for — and short enough that the daily-reset burst of
// ordinary growth (every planet's rise at once) cannot make it grow without bound.
const TRACE_KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

const insertStmt = db.prepare(`
    INSERT INTO population_trace
        (system_id, planet_index, owner_id, outcome, old_pop, claimed_pop, stored_pop,
         hours_since_change, source, observation, captured_at, actor_user_id, actor_game_name)
    VALUES
        (@system_id, @planet_index, @owner_id, @outcome, @old_pop, @claimed_pop, @stored_pop,
         @hours_since_change, @source, @observation, @captured_at, @actor_user_id, @actor_game_name)
`);
const lastForPlanetStmt = db.prepare(`
    SELECT outcome, old_pop, claimed_pop, source, actor_user_id
    FROM population_trace WHERE system_id = ? AND planet_index = ? ORDER BY id DESC LIMIT 1
`);
const pruneStmt = db.prepare(`DELETE FROM population_trace WHERE created_at < datetime('now', ?)`);
const forPlanetStmt = db.prepare(`
    SELECT * FROM population_trace WHERE system_id = ? AND planet_index = ? ORDER BY id DESC LIMIT ?
`);

// A refused rise repeats on every scan until the regrowth window passes (a stale source
// re-sends the same number every few minutes), so an identical refusal from the same
// source and member as the row before it adds nothing. Accepted rises and drops change the
// stored value, so they can never repeat and are always written.
function isRepeatOfLast(row) {
    if (row.outcome !== 'rise_rejected') return false;
    const last = lastForPlanetStmt.get(row.system_id, row.planet_index);
    return !!last && last.outcome === row.outcome && last.old_pop === row.old_pop
        && last.claimed_pop === row.claimed_pop && last.source === row.source
        && last.actor_user_id === row.actor_user_id;
}

// Runs inside /sync/system's transaction, so it must never throw: a failed diagnostic write
// may not cost a member's whole system sync. Errors are logged and swallowed.
function recordPopulationChange(row) {
    try {
        if (isRepeatOfLast(row)) return;
        insertStmt.run(row);
        const now = Date.now();
        if (now - lastPruneAt > PRUNE_EVERY_MS) {
            lastPruneAt = now;
            pruneStmt.run(`-${TRACE_KEEP_DAYS} days`);
        }
    } catch (err) {
        console.error('[PopulationTrace] write failed:', err.message);
    }
}

// Newest first.
function getTraceForPlanet(systemId, planetIndex, limit = 50) {
    return forPlanetStmt.all(systemId, planetIndex, Math.max(1, Math.min(500, Math.floor(limit) || 50)));
}

module.exports = { recordPopulationChange, getTraceForPlanet, TRACE_KEEP_DAYS };
