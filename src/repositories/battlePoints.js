const db = require('../database');
const settingsRepo = require('./settings');

function settingNumber(key, fallback) {
    const row = settingsRepo.getSetting(key);
    const n = row && row.value ? parseFloat(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getCvRatio() {
    return settingNumber('battle_points_cv_ratio', 1000);
}

function getPopRatio() {
    return settingNumber('battle_points_pop_ratio', 100);
}

function getExcludedAllianceTags() {
    const row = settingsRepo.getSetting('battle_points_excluded_alliance_tags');
    if (!row || !row.value) return [];
    return row.value.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
}

// Friendly fire (both sides share an alliance tag) is always excluded. An admin-configured
// excluded-alliance-tag list is layered on top when non-empty. Returns the SQL fragment and
// the positional params it needs, in the exact order its `?` placeholders appear — callers
// must not reorder the params relative to where this clause lands in their WHERE text.
function exclusionClause(excludedTags) {
    let clause = `NOT (att_alliance_tag IS NOT NULL AND def_alliance_tag IS NOT NULL AND UPPER(att_alliance_tag) = UPPER(def_alliance_tag))`;
    const params = [];
    if (excludedTags.length > 0) {
        const attPh = excludedTags.map(() => '?').join(',');
        const defPh = excludedTags.map(() => '?').join(',');
        clause += ` AND (att_alliance_tag IS NULL OR UPPER(att_alliance_tag) NOT IN (${attPh}))`;
        clause += ` AND (def_alliance_tag IS NULL OR UPPER(def_alliance_tag) NOT IN (${defPh}))`;
        params.push(...excludedTags, ...excludedTags);
    }
    return { clause, params };
}

function toPoints(raw, ratio) {
    return Math.round((raw / ratio) * 10) / 10;
}

// Arity/text vary per call (since-window presence, excluded-tag count) — prepared fresh
// each call, same reasoning as battleReports.js's markShipDetailScraped dynamic IN clause.
function getCvLeaderboard(sinceIso, limit) {
    const { clause, params } = exclusionClause(getExcludedAllianceTags());
    const sinceSql = sinceIso ? `AND started_at >= ?` : '';
    const wherePart = `${sinceSql} AND ${clause}`;
    const wherePartParams = sinceIso ? [sinceIso, ...params] : [...params];

    const sql = `
        SELECT player_id, player_name, SUM(cv_credit) AS raw_cv
        FROM (
            SELECT att_player_id AS player_id, att_player_name AS player_name, def_lost_cv AS cv_credit
            FROM battle_reports
            WHERE att_player_id IS NOT NULL ${wherePart}
            UNION ALL
            SELECT def_player_id AS player_id, def_player_name AS player_name, att_lost_cv AS cv_credit
            FROM battle_reports
            WHERE def_player_id IS NOT NULL ${wherePart}
        )
        GROUP BY player_id
        ORDER BY raw_cv DESC
        LIMIT ?
    `;
    const ratio = getCvRatio();
    return db.prepare(sql).all(...wherePartParams, ...wherePartParams, limit).map(r => ({
        player_id: r.player_id,
        player_name: r.player_name,
        raw: r.raw_cv || 0,
        points: toPoints(r.raw_cv || 0, ratio),
    }));
}

// Population is only ever credited to the attacker (the side whose fleet bombed the
// target planet) — see the design spec §1/§3 for why the defender never earns pop points.
function getPopLeaderboard(sinceIso, limit) {
    const { clause, params } = exclusionClause(getExcludedAllianceTags());
    const sinceSql = sinceIso ? `AND started_at >= ?` : '';
    const wherePart = `${sinceSql} AND ${clause}`;
    const wherePartParams = sinceIso ? [sinceIso, ...params] : [...params];

    const sql = `
        SELECT att_player_id AS player_id, att_player_name AS player_name, SUM(killed_population) AS raw_pop
        FROM battle_reports
        WHERE att_player_id IS NOT NULL ${wherePart}
        GROUP BY att_player_id
        ORDER BY raw_pop DESC
        LIMIT ?
    `;
    const ratio = getPopRatio();
    return db.prepare(sql).all(...wherePartParams, limit).map(r => ({
        player_id: r.player_id,
        player_name: r.player_name,
        raw: r.raw_pop || 0,
        points: toPoints(r.raw_pop || 0, ratio),
    }));
}

function getLeaderboards(sinceIso, limit = 10) {
    return { cv: getCvLeaderboard(sinceIso, limit), pop: getPopLeaderboard(sinceIso, limit) };
}

module.exports = {
    getCvRatio, getPopRatio, getExcludedAllianceTags,
    getCvLeaderboard, getPopLeaderboard, getLeaderboards,
};
