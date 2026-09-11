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

// Who counts on the leaderboard. Applied on the OUTER query (after the union, against the
// already-unified `player_id` column) rather than duplicated into every UNION branch's own
// WHERE — the three scopes:
//   'members'  (default) — only players linked to a Hub account (app_users.game_name),
//               i.e. actual tool users, not every enemy/ally who ever showed up in a fight.
//   'alliance' — every player in one specific alliance (tool user or not) — allianceId is
//               required for this scope; falls back to 'members' semantics if omitted.
//   'all'      — no filter at all (the original, unrestricted behavior).
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

// Arity/text vary per call (since-window presence, excluded-tag count) — prepared fresh
// each call, same reasoning as battleReports.js's markShipDetailScraped dynamic IN clause.
function getCvLeaderboard(sinceIso, limit, scope = 'members', allianceId = null) {
    const { clause, params } = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', getExcludedAllianceTags());
    const sinceSql = sinceIso ? `AND started_at >= ?` : '';
    const wherePart = `${sinceSql} AND ${clause}`;
    const wherePartParams = sinceIso ? [sinceIso, ...params] : [...params];
    const { clause: scopeSql, params: scopeParams } = scopeClauseFor(scope, allianceId);

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
        WHERE ${scopeSql}
        GROUP BY player_id
        ORDER BY raw_cv DESC
        LIMIT ?
    `;
    const ratio = getCvRatio();
    return db.prepare(sql).all(...wherePartParams, ...wherePartParams, ...scopeParams, limit).map(r => ({
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
function getPopLeaderboard(sinceIso, limit, scope = 'members', allianceId = null) {
    const excludedTags = getExcludedAllianceTags();

    const br = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', excludedTags);
    const brSinceSql = sinceIso ? `AND started_at >= ?` : '';
    const brWherePart = `${brSinceSql} AND ${br.clause}`;
    const brParams = sinceIso ? [sinceIso, ...br.params] : [...br.params];

    const ne = exclusionClauseFor('ca.tag', 'oa.tag', excludedTags);
    const neSinceSql = sinceIso ? `AND ne.occurred_at >= ?` : '';
    const neWherePart = `${neSinceSql} AND ${ne.clause}`;
    const neParams = sinceIso ? [sinceIso, ...ne.params] : [...ne.params];

    const { clause: scopeSql, params: scopeParams } = scopeClauseFor(scope, allianceId);

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
            -- 'battle-conquer' rows (issue: non-battle conquests were invisible here) are
            -- credited by /sync/news from the closest logged POP_DROP, not scraped from
            -- News text — the game's conquest message never states a population number.
            WHERE ne.message_type IN ('battle-bombarded', 'battle-conquer')
              AND ne.matched_battle_report_id IS NULL
              AND ne.credited_player_id IS NOT NULL
              ${neWherePart}
        )
        WHERE ${scopeSql}
        GROUP BY player_id
        ORDER BY raw_pop DESC
        LIMIT ?
    `;
    const ratio = getPopRatio();
    return db.prepare(sql).all(...brParams, ...neParams, ...scopeParams, limit).map(r => ({
        player_id: r.player_id,
        player_name: r.player_name,
        raw: r.raw_pop || 0,
        points: toPoints(r.raw_pop || 0, ratio),
    }));
}

function getLeaderboards(sinceIso, limit = 10, scope = 'members', allianceId = null) {
    return {
        cv: getCvLeaderboard(sinceIso, limit, scope, allianceId),
        pop: getPopLeaderboard(sinceIso, limit, scope, allianceId),
    };
}

// --- Dynamic (non-linear) points system ---
// The flat getCvRatio()/getPopRatio() system above credits every CV/pop unit equally
// regardless of kill size. This section is the opposite: a single bigger kill is worth
// disproportionately more PER UNIT than a small one (design discussion, 2026-09-11 —
// killing a 50k CV fleet late-round should not earn the same per-CV rate as a 300 CV
// early skirmish). Deliberately evaluated PER BATTLE REPORT / PER BOMBARDMENT EVENT, never
// on a player's running total — applying either curve to a cumulative total would make a
// player's score for past fights keep shifting as new ones are added, and would reward
// someone who's already scored a lot with a better rate on their next small kill too;
// neither is the intent. Sum the per-event points instead.
function getPopBandWidth() {
    return Math.max(1, Math.round(settingNumber('battle_points_pop_band_width', 9)));
}
function getCvExponent() {
    return settingNumber('battle_points_cv_exponent', 1.5);
}
function getCvAnchorCv() {
    return settingNumber('battle_points_cv_anchor_cv', 5000);
}
function getCvAnchorPop() {
    return settingNumber('battle_points_cv_anchor_pop', 20);
}
// Pure display multiplier applied at the very end, after the curves and the CV/pop anchor
// calibration below — it exists only so early-round kills don't all round to fractions of
// a point on the leaderboard. It changes nothing about the relative fairness between CV
// and pop, or between a small and a huge kill, since both get multiplied identically.
function getDisplayScale() {
    return settingNumber('battle_points_display_scale', 20);
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

// Population killed in ONE event: a fixed band width W, marginal rate = the band number —
// 1 point/pop for the first W population, 2 points/pop for the next W, 3 for the next W,
// and so on indefinitely. Killing further into a planet's population costs
// disproportionately more per pop than the first few, matching how much longer the planet
// takes to regrow. A single tunable width extends forever, unlike a hand-picked bracket
// table (which couldn't be made to extend past its last manually-chosen boundary).
function popDynamicPoints(pop) {
    if (!Number.isFinite(pop) || pop <= 0) return 0;
    const w = getPopBandWidth();
    let total = 0;
    let remaining = Math.floor(pop);
    let band = 1;
    while (remaining > 0) {
        const unitsInBand = Math.min(remaining, w);
        total += unitsInBand * band;
        remaining -= unitsInBand;
        band++;
    }
    return total;
}

// CV killed in ONE event: points = k * cv^exponent, a smooth superlinear curve — CV spans
// ~30 early-round to 100k+ late-round (3+ orders of magnitude), which a bracket table
// would need constant retuning to cover. k is not a free constant: it is derived from ONE
// calibration anchor ("cvAnchorPop population killed feels roughly equal to cvAnchorCv CV
// killed"), expressed via popDynamicPoints itself so the two curves stay in sync if the
// pop band width is ever retuned independently.
function cvDynamicPoints(cv) {
    if (!Number.isFinite(cv) || cv <= 0) return 0;
    const exponent = getCvExponent();
    const anchorCv = getCvAnchorCv();
    const anchorPoints = popDynamicPoints(getCvAnchorPop());
    if (anchorCv <= 0 || anchorPoints <= 0) return 0;
    const k = anchorPoints / Math.pow(anchorCv, exponent);
    return k * Math.pow(cv, exponent);
}

// Unaggregated per-event CV/pop credit rows — deliberately parallel to getCvLeaderboard's/
// getPopLeaderboard's own queries above (identical exclusion/scope/since logic) but
// WITHOUT the SUM/GROUP BY: the non-linear formulas above must be applied to each
// individual event's raw value before summing, not to a player's already-summed total.
function getCvCreditRows(sinceIso, scope, allianceId) {
    const { clause, params } = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', getExcludedAllianceTags());
    const sinceSql = sinceIso ? `AND started_at >= ?` : '';
    const wherePart = `${sinceSql} AND ${clause}`;
    const wherePartParams = sinceIso ? [sinceIso, ...params] : [...params];
    const { clause: scopeSql, params: scopeParams } = scopeClauseFor(scope, allianceId);

    const sql = `
        SELECT player_id, player_name, cv_credit FROM (
            SELECT att_player_id AS player_id, att_player_name AS player_name, def_lost_cv AS cv_credit
            FROM battle_reports
            WHERE att_player_id IS NOT NULL ${wherePart}
            UNION ALL
            SELECT def_player_id AS player_id, def_player_name AS player_name, att_lost_cv AS cv_credit
            FROM battle_reports
            WHERE def_player_id IS NOT NULL ${wherePart}
        )
        WHERE ${scopeSql}
    `;
    return db.prepare(sql).all(...wherePartParams, ...wherePartParams, ...scopeParams);
}

function getPopCreditRows(sinceIso, scope, allianceId) {
    const excludedTags = getExcludedAllianceTags();

    const br = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', excludedTags);
    const brSinceSql = sinceIso ? `AND started_at >= ?` : '';
    const brWherePart = `${brSinceSql} AND ${br.clause}`;
    const brParams = sinceIso ? [sinceIso, ...br.params] : [...br.params];

    const ne = exclusionClauseFor('ca.tag', 'oa.tag', excludedTags);
    const neSinceSql = sinceIso ? `AND ne.occurred_at >= ?` : '';
    const neWherePart = `${neSinceSql} AND ${ne.clause}`;
    const neParams = sinceIso ? [sinceIso, ...ne.params] : [...ne.params];

    const { clause: scopeSql, params: scopeParams } = scopeClauseFor(scope, allianceId);

    // See getPopLeaderboard above for why `op` is joined the way it is (direction:'lost'
    // rows) and why a NULL other_player_id must be tolerated (self-bombing with no known
    // opponent) — identical logic, just without the outer SUM/GROUP BY.
    const sql = `
        SELECT player_id, player_name, pop_credit FROM (
            SELECT att_player_id AS player_id, att_player_name AS player_name, killed_population AS pop_credit
            FROM battle_reports
            WHERE att_player_id IS NOT NULL ${brWherePart}

            UNION ALL

            SELECT ne.credited_player_id AS player_id, cp.name AS player_name, ne.population_delta AS pop_credit
            FROM news_events ne
            JOIN players cp ON cp.id = ne.credited_player_id
            LEFT JOIN players op ON op.id = (CASE
                WHEN ne.credited_player_id = ne.player_id THEN ne.other_player_id
                ELSE ne.player_id
            END)
            LEFT JOIN alliances ca ON ca.id = cp.alliance_id
            LEFT JOIN alliances oa ON oa.id = op.alliance_id
            WHERE ne.message_type IN ('battle-bombarded', 'battle-conquer')
              AND ne.matched_battle_report_id IS NULL
              AND ne.credited_player_id IS NOT NULL
              ${neWherePart}
        )
        WHERE ${scopeSql}
    `;
    return db.prepare(sql).all(...brParams, ...neParams, ...scopeParams);
}

// The combined leaderboard: CV + population, each transformed through its own non-linear
// curve above THEN summed per player (never the other way — see this section's header
// comment for why per-event order matters).
function getDynamicLeaderboard(sinceIso, limit = 10, scope = 'members', allianceId = null) {
    const cvRows = getCvCreditRows(sinceIso, scope, allianceId);
    const popRows = getPopCreditRows(sinceIso, scope, allianceId);

    const totals = new Map();
    const entryFor = (id, name) => {
        let e = totals.get(id);
        if (!e) { e = { player_id: id, player_name: name || null, cv_points: 0, pop_points: 0 }; totals.set(id, e); }
        else if (!e.player_name && name) e.player_name = name;
        return e;
    };
    for (const r of cvRows) {
        if (r.cv_credit == null || r.cv_credit <= 0) continue;
        entryFor(r.player_id, r.player_name).cv_points += cvDynamicPoints(r.cv_credit);
    }
    for (const r of popRows) {
        if (r.pop_credit == null || r.pop_credit <= 0) continue;
        entryFor(r.player_id, r.player_name).pop_points += popDynamicPoints(r.pop_credit);
    }

    const scale = getDisplayScale();
    const rows = [...totals.values()]
        .map(e => ({
            player_id: e.player_id,
            player_name: e.player_name,
            cv_points: round1(e.cv_points * scale),
            pop_points: round1(e.pop_points * scale),
            points: round1((e.cv_points + e.pop_points) * scale),
        }))
        .filter(r => r.points > 0)
        .sort((a, b) => b.points - a.points);
    return rows.slice(0, limit);
}

module.exports = {
    getCvRatio, getPopRatio, getExcludedAllianceTags,
    getCvLeaderboard, getPopLeaderboard, getLeaderboards,
    getPopBandWidth, getCvExponent, getCvAnchorCv, getCvAnchorPop, getDisplayScale,
    popDynamicPoints, cvDynamicPoints, getDynamicLeaderboard,
};
