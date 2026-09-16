const db = require('../database');
const settingsRepo = require('./settings');
const bonusGoalsRepo = require('./bonusGoals');

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
// disproportionately more PER UNIT than a small one. Deliberately evaluated PER BATTLE
// REPORT / PER BOMBARDMENT EVENT, never on a player's running total — applying either
// curve to a cumulative total would make a player's score for past fights keep shifting as
// new ones are added, and would reward someone who's already scored a lot with a better
// rate on their next small kill too; neither is the intent. Sum the per-event points
// instead.
//
// ─── HISTORY (2026-09-16d): this was originally a smooth curve, not a tiered one ─────────
// popDynamicPoints was a marginal/progressive staircase (1 pt/pop for the first band width,
// 2 for the next, etc. — like an income tax bracket, only the portion IN each band taxed at
// that band's rate) and cvDynamicPoints was k*cv^exponent, a smooth power curve, with k
// derived from one calibration anchor so the two curves crossed at a chosen point (20 pop
// == 5000 CV). It went through a display-scale-only fix first (60 pop points for a 3-pop
// kill, spotted live against Moardin's own 3.3 CV points the same day — see the prior
// version of this file for that incident), and THAT fix then made the CV curve's smallest
// kills round to near-zero (a 300 CV skirmish at ~0.05 points), which is what prompted this
// rewrite rather than another scale tweak.
//
// Both curves are now FLAT RATE PER TIER: the tier the total falls into decides ONE rate,
// and the WHOLE amount is charged at that rate — not a marginal accumulation. Verified
// against the user's own worked examples rather than guessed, exactly:
//   pop:  4 -> 4pts, 8 -> 10pts, 13 -> 19.5pts, 19 -> 33.25pts
//   cv: 100 -> 1pt, 1000 -> 15pts, 5000 -> 100pts, 10000 -> 300pts, 50000 -> 2000pts,
//       100000 -> ~5556pts, 150000 -> ~13333pts, 200000 -> 30000pts
// A single power curve could not fit the CV examples (log-log regression against them came
// out ~40% short at the 200,000 CV end), which is why CV is tiered too now instead of
// staying a smooth formula — the two curves are deliberately the same SHAPE of idea
// (bigger tiers cost more per unit) even though their tier tables look different, because
// population realistically tops out in the tens/low hundreds per hit while CV realistically
// spans into the hundreds of thousands.

// --- population: flat rate per tier ---
// tier 0 is [1, tier0Width] at rate 1.0; every tier after that is tierWidth wide and costs
// tierStep more per point than the one before it. Defaults (4, 5, 0.25) reproduce the
// user's exact worked examples above.
function getPopTier0Width() {
    return Math.max(1, Math.round(settingNumber('battle_points_pop_tier0_width', 4)));
}
function getPopTierWidth() {
    return Math.max(1, Math.round(settingNumber('battle_points_pop_tier_width', 5)));
}
function getPopTierStep() {
    return settingNumber('battle_points_pop_tier_step', 0.25);
}
function popTierRate(pop) {
    const w0 = getPopTier0Width();
    if (pop <= w0) return 1.0;
    const w = getPopTierWidth();
    const tier = 1 + Math.floor((pop - w0 - 1) / w);
    return 1.0 + getPopTierStep() * tier;
}
function popDynamicPoints(pop) {
    if (!Number.isFinite(pop) || pop <= 0) return 0;
    const p = Math.floor(pop);
    return round2(p * popTierRate(p));
}

// --- CV: flat rate per tier ---
// Unlike population's evenly-spaced bands, these boundaries and rates were reverse-
// engineered directly from the user's eight worked examples (six land exactly, two are off
// by under a point — see the module header above) — there is no clean arithmetic formula
// connecting them the way there is for population's +0.25-per-tier pattern, so the table is
// explicit rather than generated. Admin-tunable as a whole via one JSON setting (same
// pattern as rz_ta's JSON blob elsewhere in this app) rather than five separate scalar
// settings, since the tiers only make sense adjusted together — moving one boundary without
// its neighbors would reintroduce the exact "points go down as CV goes up" inversion this
// design has to avoid (see below).
const DEFAULT_CV_TIERS = [
    { max: 999, rate: 0.01 },
    { max: 4999, rate: 0.015 },
    { max: 9999, rate: 0.02 },
    { max: 49999, rate: 0.03 },
    { max: 99999, rate: 0.04 },
    { max: 149999, rate: 0.05556 },
    { max: 199999, rate: 0.08889 },
    { max: null, rate: 0.15 }, // null = no upper bound (the top/final tier)
];
function isValidCvTiers(tiers) {
    if (!Array.isArray(tiers) || tiers.length === 0) return false;
    return tiers.every((t, i) => t && typeof t.rate === 'number' && t.rate > 0
        && (t.max === null ? i === tiers.length - 1 : (typeof t.max === 'number' && t.max > 0)));
}
function getCvTiers() {
    const row = settingsRepo.getSetting('battle_points_cv_tiers');
    if (row && row.value) {
        try {
            const parsed = JSON.parse(row.value);
            if (isValidCvTiers(parsed)) return parsed;
        } catch (err) { /* malformed setting — fall through to the built-in table */ }
    }
    return DEFAULT_CV_TIERS;
}
function cvTierRate(cv) {
    const tiers = getCvTiers();
    for (const tier of tiers) {
        if (tier.max === null || cv <= tier.max) return tier.rate;
    }
    return tiers[tiers.length - 1].rate;
}
function cvDynamicPoints(cv) {
    if (!Number.isFinite(cv) || cv <= 0) return 0;
    return round2(cv * cvTierRate(cv));
}

// Two decimals, not one: the population tier step defaults to a quarter-point (0.25), so
// e.g. 19 pop at rate 1.75 is exactly 33.25 — a value round-to-1-decimal would misreport as
// 33.3. Caught by the module's own regression test before shipping, against the exact
// numbers the user worked out by hand.
function round2(n) {
    return Math.round(n * 100) / 100;
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
    // Already-final points from bonusGoals.js (e.g. a tiered bonus for hitting a
    // currently-ranked planet) — added straight into the total below, not run through
    // either tier table above.
    const bonusByPlayer = bonusGoalsRepo.getAwardedPointsByPlayer(sinceIso, scope, allianceId);

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
    // A player who only has bonus-goal points needs an entry too, or they'd never appear
    // on the leaderboard at all despite genuinely scoring — bonusByPlayer has no CV/pop
    // rows to have created one via entryFor above.
    for (const [playerId, bonus] of bonusByPlayer) {
        if (!totals.has(playerId)) entryFor(playerId, bonus.player_name);
    }

    const rows = [...totals.values()]
        .map(e => {
            const bonus = bonusByPlayer.get(e.player_id);
            const bonusPoints = bonus ? round2(bonus.bonus_points) : 0;
            const cvPoints = round2(e.cv_points);
            const popPoints = round2(e.pop_points);
            return {
                player_id: e.player_id,
                player_name: e.player_name,
                cv_points: cvPoints,
                pop_points: popPoints,
                bonus_points: bonusPoints,
                points: round2(cvPoints + popPoints + bonusPoints),
            };
        })
        .filter(r => r.points > 0)
        .sort((a, b) => b.points - a.points);
    return rows.slice(0, limit);
}

module.exports = {
    getCvRatio, getPopRatio, getExcludedAllianceTags,
    getCvLeaderboard, getPopLeaderboard, getLeaderboards,
    getPopTier0Width, getPopTierWidth, getPopTierStep, popTierRate,
    getCvTiers, cvTierRate, DEFAULT_CV_TIERS,
    popDynamicPoints, cvDynamicPoints, getDynamicLeaderboard,
};
