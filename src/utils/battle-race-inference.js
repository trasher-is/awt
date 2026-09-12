// Conservative compatibility bounds, not a race detector or a probability model.
// This module reads historical report rows only. It must never fill bio/intel fields or
// substitute a player's current sciences, level or artefact for their historical stats.
const battleModel = require('../../public/js/utils/battle-model');

const VERSION = 1;
const RACE_PICKS = Object.freeze(Array.from({ length: 9 }, (_, index) => index - 4));
// The patch was published on August 28 without a deployment timestamp. Ignore that
// whole day rather than apply v6's 12% defence multiplier to a pre-patch encounter.
const MODEL_NOT_BEFORE = '2026-08-29T00:00:00.000Z';
// Real combat randomly rounds fractional survivors (docs/game-rules.md). Allow one
// whole ship for that rounding plus the existing calculator survivor fixture's 0.5-unit
// acceptance margin (docs/battle-model.md). The result is deliberately an outer bound.
const LOSS_TOLERANCE_SHIPS = 1.5;
const AUXILIARY_SHIPS = ['transports', 'colony_ships', 'starbases'];
const SIDES = ['att', 'def'];
const EPSILON = 1e-10;

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
        reason: 'ATK cannot be isolated: reports lack historical physics and player levels, '
            + 'the opponent\'s historical ATK, and a verified side for the stored win-chance value. '
            + 'Wins and combat variance are not substitute probabilities.',
    };
}

function defenseObservation(report, playerId, notBefore) {
    const own = report.att_player_id === playerId ? 'att' : 'def';
    const enemy = own === 'att' ? 'def' : 'att';
    const when = timestamp(report.started_at);
    if (!Number.isFinite(when)) return { skip: 'invalid_battle_date' };
    if (when < Date.parse(MODEL_NOT_BEFORE)) return { skip: 'unsupported_rules_date' };
    if (when < notBefore) return { skip: 'before_current_player' };
    if (report.is_public !== 1) return { skip: 'unpublished_report' };

    // Losing-side damage can be censored or overwritten by annihilation. Only a
    // consistently identified winner's own losses constrain its defence multiplier.
    // `winner` itself is free text (and can name the player); the API's per-side
    // hasWon flags are the identity-safe source, not a guessed text label.
    if (report[`${own}_has_won`] !== 1 || report[`${enemy}_has_won`] !== 0) {
        return { skip: 'not_confirmed_winner' };
    }

    const fleets = {};
    for (const side of SIDES) {
        fleets[side] = battleModel.SHIPS.map(ship => report[`${side}_${ship.key}`]);
        if (fleets[side].some(value => !count(value))
            || AUXILIARY_SHIPS.some(ship => !count(report[`${side}_${ship}`]))) {
            return { skip: 'missing_ship_counts' };
        }
        // A report's Starbase count is not a verified starbase level. Civilian ships
        // have separate post-battle rules; both are outside this fleet-only inference.
        if (AUXILIARY_SHIPS.some(ship => report[`${side}_${ship}`] !== 0)) {
            return { skip: 'unsupported_ship_composition' };
        }
        const cv = battleModel.cvOf(fleets[side]);
        if (!Number.isSafeInteger(cv) || !count(report[`${side}_combat_value`])
            || report[`${side}_combat_value`] !== cv) {
            return { skip: 'inconsistent_combat_value' };
        }
    }

    const ownFleet = fleets[own];
    const fleetSize = ownFleet.reduce((total, number) => total + number, 0);
    if (fleetSize < 4 || battleModel.cvOf(fleets[enemy]) === 0) {
        return { skip: 'too_small_or_unopposed' };
    }

    const losses = battleModel.SHIPS.map(ship => report[`${own}_${ship.key}_lost`]);
    if (losses.some((value, index) => !count(value) || value > ownFleet[index])) {
        return { skip: 'invalid_ship_losses' };
    }
    const lostCv = battleModel.cvOf(losses);
    const survivedCv = battleModel.cvOf(ownFleet) - lostCv;
    if (!count(report[`${own}_lost_cv`]) || !count(report[`${own}_survived_cv`])
        || report[`${own}_lost_cv`] !== lostCv
        || report[`${own}_survived_cv`] !== survivedCv) {
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

    const baseLoss = Math.min(1, battleModel.cvOf(fleets[enemy]) / battleModel.toughOf(ownFleet));
    const multiplierUpper = baseLoss / lossLow;

    // The historical Mathematics level is unknown and has NO assumed upper bound.
    // Its absolute-level factor is >=1; the worst gap bracket is 1-MATH_BRACKET.
    // Player level, including an all-three-types fleet, can only increase toughness.
    // Thus M >= (1-MATH_BRACKET)*(1+RACE_DEF_PCT*RD). A high loss fraction can rule
    // out high RD, but good survival alone can never prove a positive race pick.
    const minimumMath = 1 - battleModel.constants.MATH_BRACKET;
    const candidates = RACE_PICKS.filter(race => minimumMath
        * (1 + battleModel.constants.RACE_DEF_PCT * race) <= multiplierUpper + EPSILON);
    return { candidates };
}

/**
 * @param {number} playerId Exact game player ID; names are deliberately not matched.
 * @param {object[]} reports Raw battle_reports rows; callers should pass this player's rows.
 * @param {{notBefore?: string|null, universe?: string}} options Current identity cutoff and ruleset.
 * @returns {object} JSON-safe assessment, kept separately from verified bio/intel.
 */
function inferBattleRace(playerId, reports, { notBefore = null, universe = 'standard' } = {}) {
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
            'Historical Mathematics is nonnegative with no assumed ceiling; current player stats are never used.',
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

    const seen = new Set();
    let candidates = picks();
    for (const report of relevant) {
        let skip;
        if (!Number.isSafeInteger(report.id) || report.id <= 0) skip = 'invalid_report_id';
        else if (seen.has(report.id)) skip = 'duplicate_report';
        else if (report.att_player_id === report.def_player_id) skip = 'ambiguous_player_side';
        if (skip) {
            result.skipped[skip] = (result.skipped[skip] || 0) + 1;
            continue;
        }
        seen.add(report.id);
        const observation = defenseObservation(report, playerId, cutoff);
        if (observation.skip) {
            result.skipped[observation.skip] = (result.skipped[observation.skip] || 0) + 1;
            continue;
        }
        result.eligible_report_count++;
        result.used_report_ids.push(report.id);
        candidates = candidates.filter(candidate => observation.candidates.includes(candidate));
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
        result.defense.reason = 'Winning losses bound DEF from above after allowing unknown Mathematics and player level. '
            + 'Remaining picks are compatible possibilities, not ranked probabilities.';
    } else if (result.eligible_report_count) {
        result.defense.reason = 'All supported DEF picks remain compatible. Good survival may come from Mathematics '
            + 'or player level, so it cannot establish a positive race bonus.';
    }
    return result;
}

module.exports = { inferBattleRace, VERSION, MODEL_NOT_BEFORE };
