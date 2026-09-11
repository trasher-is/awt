// Generic "extra points" engine feeding battlePoints.js's !glory leaderboard — see
// database.js's bonus_goals/bonus_goal_awards/ranking_snapshot_rows comment for the
// secrecy reasoning (generic code + DB-only config, since the repo is public but the
// database is not). One goal `type` is implemented so far: 'ranking_match' (award tiered
// points when a member's battle lands on a planet currently placed in some in-game
// ranking page — e.g. a "top planets by development" list, though which page and which
// tiers is purely config, never named here). Later phases add other types under this same
// table without touching this file's shape.

const crypto = require('crypto');
const db = require('../database');
const settingsRepo = require('./settings');
const systemsRepo = require('./systems');

const ACCESS_TOKEN_SETTING_KEY = 'bonus_goals_access_token';

// Generated once, on first use, and persisted — the URL must stay stable across restarts
// or every admin bookmark breaks. 32 random bytes (64 hex chars) is not something anyone
// stumbles onto by guessing, and it never appears in committed code (see server.js, which
// only knows the SETTING KEY, not the value).
function getOrCreateAccessToken() {
    const existing = settingsRepo.getSetting(ACCESS_TOKEN_SETTING_KEY);
    if (existing && existing.value) return existing.value;
    const token = crypto.randomBytes(32).toString('hex');
    settingsRepo.setSetting(ACCESS_TOKEN_SETTING_KEY, token);
    return token;
}

// --- goal CRUD ---

function parseGoalRow(row) {
    if (!row) return null;
    let config;
    try { config = JSON.parse(row.config); } catch (err) { config = {}; }
    return { ...row, enabled: !!row.enabled, config };
}

const listGoalsStmt = db.prepare(`SELECT * FROM bonus_goals ORDER BY created_at DESC`);
function listGoals() {
    return listGoalsStmt.all().map(parseGoalRow);
}

const getGoalStmt = db.prepare(`SELECT * FROM bonus_goals WHERE id = ?`);
function getGoal(id) {
    return parseGoalRow(getGoalStmt.get(id));
}

const listEnabledGoalsByTypeStmt = db.prepare(`SELECT * FROM bonus_goals WHERE type = ? AND enabled = 1`);
function listEnabledGoalsByType(type) {
    return listEnabledGoalsByTypeStmt.all(type).map(parseGoalRow);
}

const insertGoalStmt = db.prepare(`
    INSERT INTO bonus_goals (type, name, config, enabled) VALUES (@type, @name, @config, @enabled)
`);
function createGoal({ type, name, config = {}, enabled = false }) {
    const info = insertGoalStmt.run({
        type: String(type), name: String(name),
        config: JSON.stringify(config || {}), enabled: enabled ? 1 : 0,
    });
    return getGoal(info.lastInsertRowid);
}

const updateGoalStmt = db.prepare(`
    UPDATE bonus_goals SET name = @name, config = @config, enabled = @enabled, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
`);
function updateGoal(id, { name, config, enabled }) {
    const current = getGoal(id);
    if (!current) return null;
    updateGoalStmt.run({
        id,
        name: name != null ? String(name) : current.name,
        config: JSON.stringify(config != null ? config : current.config),
        enabled: (enabled != null ? enabled : current.enabled) ? 1 : 0,
    });
    return getGoal(id);
}

const deleteGoalStmt = db.prepare(`DELETE FROM bonus_goals WHERE id = ?`);
function deleteGoal(id) {
    return deleteGoalStmt.run(id).changes > 0;
}

// --- ranking_match: snapshot ingestion ---

// Wholesale replace: a re-scrape reflects "the ranking as of right now," not a history to
// merge with the last one. Runs in one transaction so a matcher query never sees a
// half-replaced snapshot (all-old or all-new, nothing in between).
const deleteSnapshotStmt = db.prepare(`DELETE FROM ranking_snapshot_rows WHERE goal_id = ?`);
const insertSnapshotRowStmt = db.prepare(`
    INSERT INTO ranking_snapshot_rows (goal_id, rank, game_planet_id, system_id, planet_index, owner_name, owner_alliance_tag)
    VALUES (@goal_id, @rank, @game_planet_id, @system_id, @planet_index, @owner_name, @owner_alliance_tag)
`);
const replaceSnapshotTxn = db.transaction((goalId, rows) => {
    deleteSnapshotStmt.run(goalId);
    for (const row of rows) {
        const loc = Number.isInteger(row.game_planet_id) ? systemsRepo.getPlanetLocationByGameId(row.game_planet_id) : null;
        insertSnapshotRowStmt.run({
            goal_id: goalId,
            rank: row.rank,
            game_planet_id: Number.isInteger(row.game_planet_id) ? row.game_planet_id : null,
            system_id: loc ? loc.system_id : null,
            planet_index: loc ? loc.planet_index : null,
            owner_name: row.owner_name || null,
            owner_alliance_tag: row.owner_alliance_tag || null,
        });
    }
});
function replaceRankingSnapshot(goalId, rows) {
    replaceSnapshotTxn(goalId, Array.isArray(rows) ? rows : []);
}

// Which enabled ranking_match goals need a fresh scrape — no snapshot at all, or the
// newest row is older than maxAgeHours. A member's browser (there is no server-side game
// session — see player-api-sync.js's own header comment for why every scrape in this hub
// runs client-side) polls this to decide whether to pull the configured ranking page.
const staleGoalsStmt = db.prepare(`
    SELECT g.id, g.config FROM bonus_goals g
    WHERE g.type = 'ranking_match' AND g.enabled = 1
      AND NOT EXISTS (
          SELECT 1 FROM ranking_snapshot_rows r
          WHERE r.goal_id = g.id AND r.captured_at >= datetime('now', '-' || @maxAgeHours || ' hours')
      )
`);
function getStaleRankingGoals(maxAgeHours = 20) {
    return staleGoalsStmt.all({ maxAgeHours }).map(row => ({ goal_id: row.id, config: JSON.parse(row.config) }));
}

// --- ranking_match: tier math ---

// Rank R's points: tier_start_points, stepping by tier_step every tier_size ranks — rank 1
// through tier_size at tier_start_points, the next tier_size ranks at
// tier_start_points+tier_step, and so on. Ranks past max_rank score nothing.
function computeRankPoints(config, rank) {
    if (!Number.isInteger(rank) || rank < 1) return 0;
    const tierSize = Math.max(1, Number(config.tier_size) || 5);
    const maxRank = Number(config.max_rank) || Infinity;
    if (rank > maxRank) return 0;
    const startPoints = Number(config.tier_start_points) || 0;
    const step = Number(config.tier_step) || 0;
    const tierIndex = Math.floor((rank - 1) / tierSize);
    return startPoints + step * tierIndex;
}

// --- ranking_match: award on a battle report ---

const battleReportForEvalStmt = db.prepare(`
    SELECT id, system_id, planet_index, att_player_id, att_player_name, def_lost_cv, killed_population
    FROM battle_reports WHERE id = ?
`);
const currentRankStmt = db.prepare(`
    SELECT rank FROM ranking_snapshot_rows
    WHERE goal_id = ? AND system_id = ? AND planet_index = ?
    ORDER BY captured_at DESC LIMIT 1
`);
const insertAwardStmt = db.prepare(`
    INSERT OR IGNORE INTO bonus_goal_awards (goal_id, player_id, player_name, points, source_key, detail)
    VALUES (@goal_id, @player_id, @player_name, @points, @source_key, @detail)
`);

// Called once a battle report's system_id/planet_index become known (the ship-detail
// scrape — see sync.js's /sync/battle-report-ship-detail route, which is what actually
// resolves a report's coordinates; a fresh report has neither until then). Credits the
// ATTACKER only (matches battlePoints.js's own convention: population/initiative credit
// goes to whoever brought the fight), and only for a report that did real damage — a
// report with neither a population kill nor any CV lost by the defender is a probe/no-op,
// not a genuine hit on the planet.
function evaluateBattleReportForGoals(reportId) {
    const report = battleReportForEvalStmt.get(reportId);
    if (!report || report.system_id == null || report.planet_index == null) return [];
    if (!Number.isInteger(report.att_player_id)) return [];
    const didDamage = (report.killed_population > 0) || (report.def_lost_cv > 0);
    if (!didDamage) return [];

    const awarded = [];
    for (const goal of listEnabledGoalsByType('ranking_match')) {
        const current = currentRankStmt.get(goal.id, report.system_id, report.planet_index);
        if (!current) continue;
        const points = computeRankPoints(goal.config, current.rank);
        if (points <= 0) continue;
        const result = insertAwardStmt.run({
            goal_id: goal.id,
            player_id: report.att_player_id,
            player_name: report.att_player_name,
            points,
            source_key: `br:${reportId}`,
            detail: JSON.stringify({ battle_report_id: reportId, rank: current.rank }),
        });
        if (result.changes > 0) awarded.push({ goal_id: goal.id, points });
    }
    return awarded;
}

// --- reading awards back ---

const recentAwardsStmt = db.prepare(`
    SELECT a.*, g.name AS goal_name FROM bonus_goal_awards a
    JOIN bonus_goals g ON g.id = a.goal_id
    ORDER BY a.awarded_at DESC LIMIT ?
`);
function listRecentAwards(limit = 50) {
    return recentAwardsStmt.all(limit);
}

// Same three scopes battlePoints.js's own scopeClauseFor implements ('members'/'alliance'/
// 'all') — duplicated rather than imported to avoid a require cycle (battlePoints.js
// already requires this module for the leaderboard integration below).
function scopeClauseFor(scope, allianceId) {
    if (scope === 'alliance' && allianceId != null) {
        return { clause: 'player_id IN (SELECT id FROM players WHERE alliance_id = ?)', params: [allianceId] };
    }
    if (scope === 'all') {
        return { clause: '1=1', params: [] };
    }
    return {
        clause: "player_id IN (SELECT p.id FROM players p JOIN app_users au ON au.game_name = p.name COLLATE NOCASE)",
        params: [],
    };
}

// Summed per player for the !glory leaderboard — battlePoints.js adds this straight into
// its final `points` alongside cv_points/pop_points, since these are already meant as
// final, already-scaled point values (not raw units run through a curve). Scoped the same
// way as everything else on that leaderboard: an award credited to a player outside the
// requested scope (e.g. an enemy who happened to attack a ranked planet of ours) must not
// leak onto our own members' leaderboard.
function getAwardedPointsByPlayer(sinceIso = null, scope = 'members', allianceId = null) {
    const { clause: scopeSql, params: scopeParams } = scopeClauseFor(scope, allianceId);
    const sql = `
        SELECT player_id, player_name, SUM(points) AS bonus_points
        FROM bonus_goal_awards
        WHERE player_id IS NOT NULL
          AND (@sinceIso IS NULL OR awarded_at >= @sinceIso)
          AND ${scopeSql.replace(/\?/g, '@allianceId')}
        GROUP BY player_id
    `;
    const rows = db.prepare(sql).all({ sinceIso, allianceId: scopeParams[0] ?? null });
    const map = new Map();
    for (const r of rows) map.set(r.player_id, { player_name: r.player_name, bonus_points: r.bonus_points || 0 });
    return map;
}

module.exports = {
    getOrCreateAccessToken,
    listGoals, getGoal, createGoal, updateGoal, deleteGoal,
    replaceRankingSnapshot, getStaleRankingGoals,
    computeRankPoints, evaluateBattleReportForGoals,
    listRecentAwards, getAwardedPointsByPlayer,
};
