// Conservative compatibility bounds, not a race detector or a probability model.
// This module never fills bio/intel fields. A player's current public science level and
// player level are used only as ceilings on their historical values, never as the values.
// The opponent's stats come from intel captured with the report, or the current intel
// for legacy reports only, recorded close to the battle (a known side).
const battleModel = require('../../public/js/utils/battle-model');

// 4: share observations with the shadow estimator and constrain Attack only from the
// separate, real att_win_chance field. Version 3 added captured known-side intel.
const VERSION = 4;
// How far intel on the opponent may be from the battle time and still stand in for
// their stats at the battle. A sync-time snapshot is still an approximate read, not
// a history of exact battle-time science levels (#277).
const KNOWN_SIDE_MAX_AGE_HOURS = 48;
const RACE_PICKS = Object.freeze(Array.from({ length: 9 }, (_, index) => index - 4));
// The patch was published on August 28 without a deployment timestamp. Ignore that
// whole day rather than apply v6's 12% defence multiplier to a pre-patch encounter.
const MODEL_NOT_BEFORE = '2026-08-29T00:00:00.000Z';
// Real combat randomly rounds fractional survivors (docs/game-rules.md). Allow one
// whole ship for that rounding plus the existing calculator survivor fixture's 0.5-unit
// acceptance margin (docs/battle-model.md). The result is deliberately an outer bound.
const LOSS_TOLERANCE_SHIPS = 1.5;
const AUXILIARY_SHIPS = ['transports', 'colony_ships', 'starbases'];
const CIVILIAN_SHIPS = ['transports', 'colony_ships'];
const SIDES = ['att', 'def'];
const EPSILON = 1e-10;
const HOUR_MS = 3600 * 1000;
const BEST_PICK = RACE_PICKS[RACE_PICKS.length - 1];

function timestamp(value) {
    if (typeof value !== 'string') return NaN;
    // Report API timestamps include an offset; SQLite timestamps are explicitly UTC.
    // Reject locale-specific/free-form dates rather than make inference timezone-sensitive.
    const text = value.trim();
    const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!sqlite.test(text) && !iso.test(text)) return NaN;
    const day = new Date(text.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== text.slice(0, 10)
        || Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59
        || Number(text.slice(17, 19)) > 59) return NaN;
    return Date.parse(sqlite.test(text) ? text.replace(' ', 'T') + 'Z' : text);
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const picks = () => [...RACE_PICKS];

function percentRange(candidates, multiplier) {
    if (!candidates.length) return null;
    // Rounding removes binary floating-point noise, not statistical uncertainty.
    const percent = pick => Math.round(pick * multiplier * 10000) / 100;
    return { min: percent(candidates[0]), max: percent(candidates[candidates.length - 1]) };
}

function unknownAttack() {
    return {
        status: 'insufficient',
        candidates: picks(),
        bonus_percent_range: percentRange(RACE_PICKS, battleModel.constants.RACE_ATK_PCT),
        reason: 'ATK is not estimated yet. The stored win_chance column holds the dice roll, not the '
            + 'win chance (docs/battle-model.md), so the reports carry no usable win chance until the '
            + 'report-page capture is fixed (#277). Wins, losses and dice are not used as a substitute.',
    };
}

// The defender's starbase level, from the report itself. The stored combat value either
// covers the fleet only (level unknown) or the fleet plus the starbase, whose CV names
// exactly one level. Anything else means the ship table and the totals disagree.
function starbaseLevel(report, defFleet) {
    const fleetCv = battleModel.cvOf(defFleet);
    const stored = report.def_combat_value;
    if (!count(stored)) return { skip: 'inconsistent_combat_value' };
    if (report.def_starbases === 0) return stored === fleetCv ? { level: 0 } : { skip: 'inconsistent_combat_value' };
    if (stored === fleetCv) return { level: null };
    const starbaseCv = stored - fleetCv;
    for (let level = 1; battleModel.sbCV(level) <= starbaseCv; level++) {
        if (battleModel.sbCV(level) === starbaseCv) return { level };
    }
    return { skip: 'inconsistent_combat_value' };
}

// The opponent's stats at the battle, from bio intel recorded near it: our own member
// (same alliance means full intel) or a scouted player outside the alliance.
function knownSide(stats, when) {
    if (!stats || stats.has_intel !== 1) return { skip: 'no_known_side' };
    const recorded = timestamp(stats.intel_updated_at);
    if (!Number.isFinite(recorded) || Math.abs(recorded - when) > KNOWN_SIDE_MAX_AGE_HOURS * HOUR_MS) {
        return { skip: 'ally_stats_unknown' };
    }
    const values = { ra: stats.race_attack, rd: stats.race_defense, phys: stats.physics,
        math: stats.mathematics, lvl: stats.level };
    if (Object.values(values).some(value => !Number.isSafeInteger(value))
        || !RACE_PICKS.includes(values.ra) || !RACE_PICKS.includes(values.rd)
        || values.phys < 0 || values.math < 0 || values.lvl < 0) {
        return { skip: 'ally_stats_unknown' };
    }
    return { stats: values, ageHours: Math.abs(recorded - when) / HOUR_MS };
}

function reportKnownSide(report, side, when, opponents) {
    // NULL means this report predates snapshots. Once a capture exists, its missing or
    // invalid intel must stay unknown; borrowing a later scan would rewrite the past.
    if (report.stats_snapshot_at == null) {
        return knownSide(opponents ? opponents[report[`${side}_player_id`]] : null, when);
    }
    const capturedAt = timestamp(report.stats_snapshot_at);
    const stats = {
        has_intel: 1,
        race_attack: report[`${side}_race_attack`], race_defense: report[`${side}_race_defense`],
        physics: report[`${side}_physics`], mathematics: report[`${side}_mathematics`],
        level: report[`${side}_player_level`], intel_updated_at: report[`${side}_intel_at`],
    };
    if (!Number.isFinite(capturedAt)) return { skip: 'ally_stats_unknown' };
    if (Object.entries(stats).every(([key, value]) => key === 'has_intel' || value == null)) {
        return { skip: 'no_known_side' };
    }
    if (timestamp(stats.intel_updated_at) > capturedAt) return { skip: 'ally_stats_unknown' };
    return knownSide(stats, when);
}

function battleObservation(report, playerId, notBefore, { subject, opponents, contextCeilingsByReport }) {
    const own = report.att_player_id === playerId ? 'att' : 'def';
    const enemy = own === 'att' ? 'def' : 'att';
    const when = timestamp(report.started_at);
    if (!Number.isFinite(when)) return { skip: 'invalid_battle_date' };
    if (when < Date.parse(MODEL_NOT_BEFORE)) return { skip: 'unsupported_rules_date' };
    if (when < notBefore) return { skip: 'before_current_player' };
    if (report.is_public !== 1) return { skip: 'unpublished_report' };

    if (![0, 1].includes(report[`${own}_has_won`]) || report[`${enemy}_has_won`] !== 1 - report[`${own}_has_won`]) {
        return { skip: 'not_confirmed_winner' };
    }
    if (report.dice_consistent === 0) return { skip: 'dice_inconsistent' };

    // An attacker cannot bring a starbase, so the API sends `starbaseStats: null` for it and
    // the report page leaves the cell blank: the hub stores att_starbases as NULL, never 0
    // (every stored row). Read that as the zero it means. A non-zero value is still
    // rejected below as an impossible composition.
    const shipCount = (side, ship) => (side === 'att' && ship === 'starbases' && report.att_starbases == null
        ? 0 : report[`${side}_${ship}`]);

    const fleets = {};
    for (const side of SIDES) {
        fleets[side] = battleModel.SHIPS.map(ship => report[`${side}_${ship.key}`]);
        if (fleets[side].some(value => !count(value))
            || AUXILIARY_SHIPS.some(ship => !count(shipCount(side, ship)))) {
            return { skip: 'missing_ship_counts' };
        }
        // Civilian ships have separate post-battle rules, and an attacker cannot bring a
        // starbase. Either one keeps the report out of this fleet inference.
        if (CIVILIAN_SHIPS.some(ship => report[`${side}_${ship}`] !== 0)
            || (side === 'att' && shipCount('att', 'starbases') !== 0)) {
            return { skip: 'unsupported_ship_composition' };
        }
    }
    const attCv = battleModel.cvOf(fleets.att);
    if (!Number.isSafeInteger(attCv) || !count(report.att_combat_value) || report.att_combat_value !== attCv) {
        return { skip: 'inconsistent_combat_value' };
    }
    const starbase = starbaseLevel(report, fleets.def);
    if (starbase.skip) return starbase;

    const ownFleet = fleets[own];
    const fleetSize = ownFleet.reduce((total, number) => total + number, 0);
    const opposed = battleModel.cvOf(fleets[enemy]) > 0 || (enemy === 'def' && report.def_starbases > 0);
    if (fleetSize < 4 || !opposed) {
        return { skip: 'too_small_or_unopposed' };
    }
    // Both sides' losses depend on the starbase: the attacker's on what it fought, the
    // defender's fleet on the starbase's toughness, which shares its loss fraction
    // (battle-model.js, confirmed against the calculator 2026-10-04). Without the level
    // neither side can be replayed.
    if (starbase.level === null) return { skip: 'starbase_level_unknown' };

    const known = reportKnownSide(report, enemy, when, opponents);
    if (known.skip) return known;
    const historical = contextCeilingsByReport && contextCeilingsByReport[report.id];
    const ceiling = historical || subject;
    const scienceCeiling = ceiling ? ceiling.science_level : undefined;
    if (!Number.isSafeInteger(scienceCeiling) || scienceCeiling <= 0) return { skip: 'science_level_unknown' };
    const fieldsAllTypes = ownFleet.every(number => number > 0);
    // Even a single-type subject's level sets the opponent's PL gap when that opponent
    // fields all three types. Win odds therefore need the level on either composition.
    const levelRelevant = fieldsAllTypes || fleets[enemy].every(number => number > 0);
    const levelCeiling = ceiling ? ceiling.level : undefined;
    if (levelRelevant && (!Number.isSafeInteger(levelCeiling) || levelCeiling < 0)) {
        return { skip: 'player_level_unknown' };
    }
    return { own, enemy, when, fleets, starbase, ownFleet, known, scienceCeiling,
        levelCeiling: levelRelevant ? levelCeiling : 0, levels: fieldsAllTypes ? [0, levelCeiling] : [0] };
}

function defenseObservation(report, playerId, notBefore, options, context = null) {
    const base = context || battleObservation(report, playerId, notBefore, options);
    if (base.skip) return base;
    const { own, fleets, starbase, ownFleet, known, scienceCeiling, levels } = base;
    // The loser's losses stay out until a stored-corpus comparison verifies their model.
    if (report[`${own}_has_won`] !== 1) return { skip: 'not_confirmed_winner' };

    const losses = battleModel.SHIPS.map(ship => report[`${own}_${ship.key}_lost`]);
    if (losses.some((value, index) => !count(value) || value > ownFleet[index])) {
        return { skip: 'invalid_ship_losses' };
    }
    const lostCv = battleModel.cvOf(losses);
    const survivedCv = battleModel.cvOf(ownFleet) - lostCv;
    // A defender's stored totals may include its starbase. Then they only have to add
    // up and cover the fleet's own losses.
    const withStarbase = own === 'def' && report[`${own}_combat_value`] !== battleModel.cvOf(ownFleet);
    const storedLost = report[`${own}_lost_cv`];
    const storedSurvived = report[`${own}_survived_cv`];
    if (!count(storedLost) || !count(storedSurvived)
        || (withStarbase
            ? storedLost < lostCv || storedLost + storedSurvived !== report[`${own}_combat_value`]
            : storedLost !== lostCv || storedSurvived !== survivedCv)) {
        return { skip: 'inconsistent_loss_totals' };
    }
    if (survivedCv === 0) return { skip: 'annihilated_fleet' };

    // Every fighting type experiences the same underlying loss fraction. Intersect
    // their rounding intervals to detect shifted/malformed report rows. Near the
    // one-survivor floor the upper end is unbounded, because raw losses may exceed 1.
    let lossLow = 0;
    let lossHigh = Infinity;
    ownFleet.forEach((number, index) => {
        if (number === 0) return;
        lossLow = Math.max(lossLow, (losses[index] - LOSS_TOLERANCE_SHIPS) / number);
        if (number - losses[index] > 1 + LOSS_TOLERANCE_SHIPS) {
            lossHigh = Math.min(lossHigh, (losses[index] + LOSS_TOLERANCE_SHIPS) / number);
        }
    });
    if (lossLow > lossHigh + EPSILON) return { skip: 'inconsistent_loss_fractions' };
    if (lossLow <= 0) return { skip: 'losses_below_rounding_resolution' };

    // Assumed: sciences and player level do not go down within one incarnation of an
    // account (the resign cutoff ends an incarnation), so today's public values bound the
    // battle-time ones from above. An unfilled or zero science level is "unknown", not a
    // ceiling of zero.
    // Player level only moves an all-three-types fleet's toughness, and only upwards,
    // so its two ends bracket every level in between.

    // The subject's own survivors do not depend on its Attack or Physics. Those only
    // decide whether the model calls it the certain loser, whose survivors it wipes.
    // The subject won, so give it the best win terms; a combination that still reads as
    // a certain loss cannot be checked and is kept rather than used to exclude a pick.
    const observed = ownFleet.map((number, index) => number - losses[index]);
    function fits(race, math) {
        const bounds = [];
        for (const lvl of levels) {
            const self = { ra: BEST_PICK, rd: race, phys: scienceCeiling, math, lvl };
            const result = battleModel.simulate({
                atkFleet: fleets.att, defFleet: fleets.def, sbLevel: starbase.level || 0,
                atk: own === 'att' ? self : known.stats,
                def: own === 'att' ? known.stats : self,
            });
            if ((own === 'att' ? result.winA : result.winD) <= 0) return true;
            bounds.push(own === 'att' ? result.survAtk : result.survDef);
        }
        return ownFleet.every((number, index) => {
            if (number === 0) return true;
            const values = bounds.map(survivors => survivors[index]);
            return observed[index] >= Math.min(...values) - LOSS_TOLERANCE_SHIPS - EPSILON
                && observed[index] <= Math.max(...values) + LOSS_TOLERANCE_SHIPS + EPSILON;
        });
    }
    const candidates = RACE_PICKS.filter(race => {
        for (let math = 0; math <= scienceCeiling; math++) {
            if (fits(race, math)) return true;
        }
        return false;
    });
    return { candidates, intelAgeHours: known.ageHours, survivors: observed, losses };
}

function attackCandidates(report, base) {
    const observed = report.att_win_chance;
    if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0 || observed > 100) return null;
    const { own, fleets, starbase, known, scienceCeiling, levelCeiling } = base;
    const mixed = fleets.att.filter(n => n > 0).length > 1 || fleets.def.filter(n => n > 0).length > 1;
    const tolerance = battleModel.uncertainty.BASE_ERROR_PP + (mixed ? battleModel.uncertainty.MIXED_FLEET_EXTRA_PP : 0);
    return RACE_PICKS.filter(ra => {
        for (let phys = 0; phys <= scienceCeiling; phys++) {
            for (let lvl = 0; lvl <= levelCeiling; lvl++) {
                const self = { ra, rd: BEST_PICK, phys, math: scienceCeiling, lvl };
                const result = battleModel.simulate({ atkFleet: fleets.att, defFleet: fleets.def, sbLevel: starbase.level,
                    atk: own === 'att' ? self : known.stats, def: own === 'att' ? known.stats : self });
                const value = result.winA * 100;
                if (observed === 0 ? value <= tolerance : observed === 100 ? value >= 100 - tolerance : Math.abs(value - observed) <= tolerance) return true;
            }
        }
        return false;
    });
}

// One observation builder for the hard-range card and the shadow probability model.
// It never fetches data and never treats a winner alone as evidence of Attack.
function buildRaceObservations(playerId, reports, options = {}) {
    const observations = [], skipped = {}, seen = new Set();
    const addSkip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    const cutoff = options.notBefore == null ? -Infinity : timestamp(options.notBefore);
    for (const report of reports) {
        if (!report || (report.att_player_id !== playerId && report.def_player_id !== playerId)) continue;
        let skip;
        if (options.universe && options.universe !== 'standard') skip = 'unsupported_ruleset';
        else if (!Number.isFinite(cutoff) && cutoff !== -Infinity) skip = 'invalid_player_cutoff';
        else if (!Number.isSafeInteger(report.id) || report.id <= 0) skip = 'invalid_report_id';
        else if (seen.has(report.id)) skip = 'duplicate_report';
        else if (report.att_player_id === report.def_player_id) skip = 'ambiguous_player_side';
        if (skip) { addSkip(skip); continue; }
        seen.add(report.id);
        const base = battleObservation(report, playerId, cutoff, options);
        if (base.skip) { addSkip(base.skip); continue; }
        const defense = defenseObservation(report, playerId, cutoff, options, base);
        const attack = attackCandidates(report, base);
        const dice = report.dice_roll;
        const hasDice = typeof dice === 'number' && Number.isFinite(dice) && dice >= 0 && dice <= 100;
        if (defense.skip && attack === null && !hasDice) { addSkip(defense.skip); continue; }
        observations.push({ report_id: report.id, side: base.own, when: base.when,
            atkFleet: base.fleets.att, defFleet: base.fleets.def, sbLevel: base.starbase.level,
            known: base.known.stats, intelAgeHours: base.known.ageHours,
            scienceCeiling: base.scienceCeiling, levelCeiling: base.levelCeiling,
            survivors: defense.survivors || null, losses: defense.losses || null,
            defense_candidates: defense.candidates || null, defense_skip: defense.skip || null,
            attack_candidates: attack, observedWin: attack === null ? null : report.att_win_chance,
            dice: hasDice ? dice : null, subjectWon: report[`${base.own}_has_won`] === 1,
            attackerWon: report.att_has_won === 1,
            dice_reason: report.dice_reason || null,
        });
    }
    return { observations, skipped };
}

/**
 * @param {number} playerId Exact game player ID; names are deliberately not matched.
 * @param {object[]} reports Raw battle_reports rows; callers should pass this player's rows.
 * @param {{notBefore?: string|null, universe?: string, subject?: {science_level?: number, level?: number},
 *   opponents?: Object<number, object>}} options Current identity cutoff and ruleset, the
 *   player's current public science level and player level (ceilings only), and the
 *   players table rows of their opponents, keyed by player ID.
 * @returns {object} JSON-safe assessment, kept separately from verified bio/intel.
 */
function inferBattleRace(playerId, reports, {
    notBefore = null, universe = 'standard', subject = null, opponents = null, contextCeilingsByReport = null,
} = {}) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0 || !Array.isArray(reports)) {
        throw new TypeError('Battle race inference requires a positive player ID and report array.');
    }
    const relevant = reports.filter(report => report && typeof report === 'object'
        && (report.att_player_id === playerId || report.def_player_id === playerId));
    const result = {
        version: VERSION,
        status: 'insufficient',
        report_count: relevant.length,
        eligible_report_count: 0,
        used_report_ids: [],
        // Largest gap between a used report and the captured (or legacy current) intel
        // it relied on; capture time itself is not the intel observation time.
        known_side_intel_max_age_hours: null,
        attack: unknownAttack(),
        defense: {
            status: 'insufficient', candidates: picks(),
            bonus_percent_range: percentRange(RACE_PICKS, battleModel.constants.RACE_DEF_PCT),
            reason: 'No eligible winning reports constrain DEF yet.',
        },
        skipped: {},
        assumptions: [
            'Conditional compatibility under the standard-server v6 battle model, not a probability or verified bio.',
            'Race candidates use the battle model\'s supported -4 to +4 pick range.',
            'The player\'s Mathematics at the battle is anywhere from 0 to their current public science level, '
                + 'and their player level anywhere from 0 to their current level; neither is used as a point value.',
            `The opponent's race, sciences and player level come from bio intel recorded within ${KNOWN_SIDE_MAX_AGE_HOURS} h of the battle.`,
            'Reports with a stats capture use that immutable known-side intel; only legacy reports use the current player row. '
                + 'The capture happens at sync time, not at the battle, and does not prove exact historical science levels.',
            'Standard-server artefacts have the documented economy effects; RedZone combat artefacts are unsupported.',
            'Only published, consistent winning fleet reports are used; fractional survivors allow random rounding.',
            'Reports before 2026-08-29 UTC and any supplied current-player cutoff are excluded.',
        ],
    };
    if (universe !== 'standard') {
        result.defense.reason = 'This ruleset is unsupported; combat artefacts and other server-specific modifiers are not recorded.';
        result.skipped.unsupported_ruleset = relevant.length;
        return result;
    }
    const cutoff = notBefore === null ? -Infinity : timestamp(notBefore);
    if (notBefore !== null && !Number.isFinite(cutoff)) {
        result.defense.reason = 'The current-player date is invalid; previous races cannot be safely excluded.';
        result.skipped.invalid_player_cutoff = relevant.length;
        return result;
    }

    const built = buildRaceObservations(playerId, relevant, { notBefore, universe, subject, opponents, contextCeilingsByReport });
    result.skipped = built.skipped;
    let candidates = picks(), atkCandidates = picks(), attackCount = 0;
    for (const observation of built.observations) {
        result.eligible_report_count++;
        result.used_report_ids.push(observation.report_id);
        result.known_side_intel_max_age_hours = Math.max(result.known_side_intel_max_age_hours ?? 0,
            Math.round(observation.intelAgeHours * 10) / 10);
        if (observation.defense_candidates) candidates = candidates.filter(candidate => observation.defense_candidates.includes(candidate));
        if (observation.attack_candidates) {
            attackCount++;
            atkCandidates = atkCandidates.filter(candidate => observation.attack_candidates.includes(candidate));
        }
    }

    if (attackCount) {
        result.attack = { status: atkCandidates.length === 0 ? 'conflicting' : atkCandidates.length < RACE_PICKS.length ? 'compatible' : 'insufficient',
            candidates: atkCandidates, bonus_percent_range: percentRange(atkCandidates, battleModel.constants.RACE_ATK_PCT),
            reason: 'Only the separately captured attacker win chance constrains ATK, across every permitted historical Physics and player level. '
                + 'The legacy win_chance dice column is never used as a probability.' };
    }

    result.used_report_ids.sort((a, b) => a - b);
    result.defense.candidates = candidates;
    result.defense.bonus_percent_range = percentRange(candidates, battleModel.constants.RACE_DEF_PCT);
    if (!candidates.length) {
        result.status = result.defense.status = 'conflicting';
        result.defense.reason = 'The recorded losses are incompatible with every supported DEF pick under this model. '
            + 'Check report data, race restarts and rules before drawing a conclusion.';
    } else if (candidates.length < RACE_PICKS.length) {
        result.status = result.defense.status = 'compatible';
        result.defense.reason = 'Winning losses bound DEF from both sides, given the opponent\'s recorded intel and '
            + 'every Mathematics and player level up to the player\'s current ones. '
            + 'Remaining picks are compatible possibilities, not ranked probabilities.';
    } else if (result.eligible_report_count) {
        result.defense.reason = 'All supported DEF picks remain compatible with the eligible reports. '
            + 'Their losses fit every pick within the Mathematics and player-level ceilings.';
    }
    if (result.attack.status === 'conflicting') result.status = 'conflicting';
    else if (result.attack.status === 'compatible' && result.status !== 'conflicting') result.status = 'compatible';
    return result;
}

module.exports = { inferBattleRace, buildRaceObservations, VERSION, MODEL_NOT_BEFORE, KNOWN_SIDE_MAX_AGE_HOURS, LOSS_TOLERANCE_SHIPS };
