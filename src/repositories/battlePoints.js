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
// excluded-alliance-tag list is layered on top when non-empty. `attTagExpr`/`defTagExpr`
// are raw SQL column/expression text (never user input) so this same logic works whether
// the caller is querying battle_reports directly or a news_events join. Returns the SQL
// fragment and the positional params it needs, in the exact order its `?` placeholders
// appear — callers must not reorder params relative to where this clause lands.
function exclusionClauseFor(attTagExpr, defTagExpr, excludedTags) {
    let clause = `NOT (${attTagExpr} IS NOT NULL AND ${defTagExpr} IS NOT NULL AND UPPER(${attTagExpr}) = UPPER(${defTagExpr}))`;
    const params = [];
    if (excludedTags.length > 0) {
        const attPh = excludedTags.map(() => '?').join(',');
        const defPh = excludedTags.map(() => '?').join(',');
        clause += ` AND (${attTagExpr} IS NULL OR UPPER(${attTagExpr}) NOT IN (${attPh}))`;
        clause += ` AND (${defTagExpr} IS NULL OR UPPER(${defTagExpr}) NOT IN (${defPh}))`;
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
    const { clause, params } = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', getExcludedAllianceTags());
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
// Two sources are unioned: real battle_reports rows, and News-page bombardments that have
// NO matching battle_reports row (a matched one is already covered by the battle report
// itself, so it is excluded here to avoid double-counting). News-page rows carry no
// alliance-tag columns of their own, so exclusions are applied via a join to players'
// CURRENT alliance — a known simplification (not the alliance at the time of the event).
function getPopLeaderboard(sinceIso, limit) {
    const excludedTags = getExcludedAllianceTags();

    const br = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', excludedTags);
    const brSinceSql = sinceIso ? `AND started_at >= ?` : '';
    const brWherePart = `${brSinceSql} AND ${br.clause}`;
    const brParams = sinceIso ? [sinceIso, ...br.params] : [...br.params];

    const ne = exclusionClauseFor('ca.tag', 'oa.tag', excludedTags);
    const neSinceSql = sinceIso ? `AND ne.occurred_at >= ?` : '';
    const neWherePart = `${neSinceSql} AND ${ne.clause}`;
    const neParams = sinceIso ? [sinceIso, ...ne.params] : [...ne.params];

    const sql = `
        SELECT player_id, player_name, SUM(pop_credit) AS raw_pop
        FROM (
            SELECT att_player_id AS player_id, att_player_name AS player_name, killed_population AS pop_credit
            FROM battle_reports
            WHERE att_player_id IS NOT NULL ${brWherePart}

            UNION ALL

            SELECT ne.credited_player_id AS player_id, cp.name AS player_name, ne.population_delta AS pop_credit
            FROM news_events ne
            JOIN players cp ON cp.id = ne.credited_player_id
            -- op must resolve to the VICTIM of the bombardment, not other_player_id
            -- verbatim. other_player_id is stored as "the counterpart named in the News
            -- row" regardless of direction: when the scraping member was bombarded
            -- (direction: 'lost'), credited_player_id is set TO other_player_id (the
            -- attacker gets the credit) — so credited_player_id and other_player_id are
            -- the SAME player on those rows, and joining op via other_player_id would make
            -- ca.tag = oa.tag trivially true, wrongly firing the friendly-fire exclusion
            -- for every tagged attacker. The victim is whoever is NOT credited_player_id:
            -- other_player_id when the scraper was the attacker (credited_player_id =
            -- player_id), or player_id when the scraper was the victim (credited_player_id
            -- = other_player_id).
            LEFT JOIN players op ON op.id = (CASE
                WHEN ne.credited_player_id = ne.player_id THEN ne.other_player_id
                ELSE ne.player_id
            END)
            LEFT JOIN alliances ca ON ca.id = cp.alliance_id
            LEFT JOIN alliances oa ON oa.id = op.alliance_id
            WHERE ne.message_type = 'battle-bombarded'
              AND ne.matched_battle_report_id IS NULL
              AND ne.credited_player_id IS NOT NULL
              ${neWherePart}
        )
        GROUP BY player_id
        ORDER BY raw_pop DESC
        LIMIT ?
    `;
    const ratio = getPopRatio();
    return db.prepare(sql).all(...brParams, ...neParams, limit).map(r => ({
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
