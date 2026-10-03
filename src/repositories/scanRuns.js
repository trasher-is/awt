const db = require('../database');

// Long enough to line a stale read up with the scan that sent it days later, short enough that
// one row per member per five minutes cannot grow without bound.
const SCAN_KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

const COLUMNS = ['run_id', 'started_by', 'result', 'error', 'browser', 'mobile', 'tab_age_s', 'run_index',
    'hidden_at_start', 'went_hidden', 'systems_total', 'systems_posted', 'planets_posted', 'in_vision',
    'duration_ms', 'fetch_ms', 'post_ms_avg', 'post_ms_max', 'response_status', 'cache_state',
    'transfer_size', 'encoded_body_size', 'delivery_type', 'date_lag_s', 'headers_json'];

const insertStmt = db.prepare(`
    INSERT INTO galaxy_scan_runs (actor_user_id, actor_game_name, ${COLUMNS.join(', ')})
    VALUES (@actor_user_id, @actor_game_name, ${COLUMNS.map(c => '@' + c).join(', ')})
`);
const pruneStmt = db.prepare(`DELETE FROM galaxy_scan_runs WHERE received_at < datetime('now', ?)`);
const recentStmt = db.prepare(`SELECT * FROM galaxy_scan_runs ORDER BY id DESC LIMIT ?`);
const byRunStmt = db.prepare(`SELECT * FROM galaxy_scan_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1`);

// row: the output of sanitizeScanRun. actor: { userId, gameName } from the session. A scan run is a
// diagnostic, so the caller treats a failure here as "not recorded", never as a failed sync.
function recordScanRun(row, actor) {
    insertStmt.run({
        ...row,
        actor_user_id: actor && Number.isInteger(actor.userId) ? actor.userId : null,
        actor_game_name: actor && actor.gameName ? String(actor.gameName).slice(0, 64) : null,
    });
    const now = Date.now();
    if (now - lastPruneAt > PRUNE_EVERY_MS) {
        lastPruneAt = now;
        pruneStmt.run(`-${SCAN_KEEP_DAYS} days`);
    }
}

// Newest first.
function getRecentScanRuns(limit = 20) {
    return recentStmt.all(Math.max(1, Math.min(500, Math.floor(limit) || 20)));
}

function getScanRun(runId) {
    return byRunStmt.get(runId) || null;
}

module.exports = { recordScanRun, getRecentScanRuns, getScanRun, SCAN_KEEP_DAYS };
