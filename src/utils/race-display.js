// Reads only. The member card, calculators and Discord consume the same labels and
// gates; none of these surfaces can enqueue a computation or initiate an AI call.
const db = require('../database');
const estimates = require('../repositories/raceEstimates');
const inference = require('./race-inference-service');
const checks = require('./race-llm-service');
const { resolveRaceStats } = require('./race-resolve');

function raceDisplay(playerId, { role = 'user' } = {}) {
    const player = db.prepare(`SELECT id,name,has_intel,race_attack,race_defense,physics,mathematics,
        science_level,level,intel_updated_at,joined,battle_race_not_before FROM players WHERE id=?`).get(playerId);
    if (!player) return null;
    const calibration = inference.getCalibrationSummary();
    const reasons = [];
    if (calibration.players < 30) reasons.push('At least 30 players with calibration pairs are required.');
    if (calibration.calibration_error_pp == null || calibration.calibration_error_pp > 5) reasons.push('Calibration error must be at most 5 percentage points.');
    if (!calibration.high_pairs || calibration.high_accuracy == null || calibration.high_accuracy < 0.9) reasons.push('High confidence must be verified at 90% accuracy or better.');
    if (calibration.coverage_pairs !== calibration.pairs || calibration.credible_coverage == null
        || calibration.credible_coverage < 0.88 || calibration.credible_coverage > 0.92) {
        reasons.push('The prior-based 90% sets need measured coverage between 88% and 92%.');
    }
    const gate = { ...calibration, allowed: calibration.passed === true && reasons.length === 0, reasons };
    const raw = estimates.getEstimate(playerId);
    const stored = raw?.attack || raw?.defence ? raw : null;
    const check = stored && !player.has_intel ? checks.checkState(playerId, stored) : { state: 'not_checked', input_hash: null, current_input_hash: null };
    const admin = role === 'admin';
    const held = check.state === 'held';
    const shadow = !gate.allowed;
    const estimate = !player.has_intel && stored && (admin || (!shadow && !held)) ? stored : null;
    // A held/shadow estimate is admin-only, including its free-text AI explanation.
    const visibleCheck = !admin && !estimate
        ? { state: 'not_checked', input_hash: null, current_input_hash: null } : check;
    const envelope = { estimate, gate, check: visibleCheck, model_version: calibration.model_version };
    return {
        player, ...envelope, has_bio: !!player.has_intel, shadow,
        viewer_role: role,
        llm_enabled: require('./llm-client').configuration().enabled,
        check_request_allowed: !!estimate && ['user', 'admin'].includes(role) && !held,
        resolution: resolveRaceStats(player, envelope),
    };
}

function raceSummary(display) {
    if (!display) return 'Player not found.';
    if (display.has_bio) {
        const signed = n => `${n >= 0 ? '+' : ''}${n}`;
        return `Attack ${signed(display.player.race_attack)}; Defence ${signed(display.player.race_defense)} — intel.`;
    }
    if (!display.estimate) return `Worst case: Attack +4; Defence +4. ${display.shadow ? 'Estimates are in shadow calibration.' : 'No member-visible estimate.'}`;
    const text = (name, trait) => {
        if (!trait || trait.band === 'none' || !Array.isArray(trait.dist)) return `${name}: estimate unavailable`;
        const Display = require('../../public/js/utils/race-estimate-display');
        const set = Display.compatibleSet(trait);
        const band = Display.effectiveBand(trait, display.check, name === 'Attack' ? 'attack' : 'defence');
        return `${name}: estimate ${Display.setText(set)} (${band}; compatible range)`;
    };
    return `${text('Attack', display.estimate.attack)}; ${text('Defence', display.estimate.defence)}. ${display.check.state}.`;
}

module.exports = { raceDisplay, raceSummary };
