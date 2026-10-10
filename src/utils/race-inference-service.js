const db = require('../database');
const repository = require('../repositories/raceEstimates');
const { readBattleRaceInputs } = require('./battle-race-inputs');
const evidence = require('./race-evidence');
const arithmetic = require('../../public/js/utils/race-inference');
const { hasCurrentIntel } = require('../../public/js/utils/battle-model');

function recompute(playerId) {
    const inputs = readBattleRaceInputs(db, playerId);
    if (!inputs) return { status: 'not_found' };
    if (inputs.player.joined === 'N/A') { repository.clearPlayer(playerId); return { status: 'resigned' }; }
    if (inputs.player.has_intel) { repository.clearPlayer(playerId); return { status: 'bio_locked' }; }
    const target = new URL(process.env.TARGET_URL || 'https://astrowars.games');
    const built = evidence.buildEvidence(playerId, inputs, { universe: target.hostname.startsWith('redzone.') ? 'redzone' : 'standard' });
    const version = evidence.modelVersion();
    const previous = repository.getEstimate(playerId), oldRows = repository.evidenceForPlayer(playerId);
    const knownRows = new Set(oldRows.filter(row => row.model_version === version).map(row => `${row.battle_report_id}:${row.kind}`));
    const statuses = {};
    // An admin's exclusion belongs to the report. Automatic conflicts belong to
    // the model that found them, and must be rebuilt when that model changes.
    const oldStatuses = Object.fromEntries(oldRows.filter(row => row.model_version === version || row.status === 'excluded')
        .map(row => [`${row.battle_report_id}:${row.kind}`, row.status]));
    const matrices = [];
    for (const observation of built.observations) for (const trait of ['attack', 'defence']) {
        const matrix = arithmetic.evidenceMatrix(observation, trait);
        if (!matrix) continue;
        matrices.push(matrix);
        const key = `${matrix.report_id}:${matrix.kind}`;
        statuses[key] = oldStatuses[key] || 'ok';
        const priorEstimate = previous[trait]?.model_version === version ? previous[trait] : null;
        if (statuses[key] !== 'excluded' && !knownRows.has(key)
            && evidence.predictiveCompatibility(priorEstimate, matrix) < 0.01) statuses[key] = 'conflict';
    }
    for (const kind of ['win', 'loss']) for (const window of arithmetic.windows(matrices.filter(row => row.kind === kind), arithmetic.WINDOW_MS)) {
        for (const row of window.rows) row.window_key = String(window.start);
    }
    const accepted = built.observations.map(row => ({ ...row,
        ...(['conflict', 'excluded'].includes(statuses[`${row.report_id}:win`]) ? { observedWin: null, dice: null, attack_candidates: null } : {}),
        ...(['conflict', 'excluded'].includes(statuses[`${row.report_id}:loss`]) ? { defense_candidates: null, survivors: null } : {}) }));
    const hardRanges = evidence.hardRanges(accepted), estimate = arithmetic.estimate(accepted, { hardRanges });
    const hash = evidence.hashEvidence(built.observations, statuses);
    repository.saveEstimate(playerId, estimate, matrices, version, hash, statuses);
    return { status: 'updated', estimate: repository.getEstimate(playerId), skipped: built.skipped };
}
const queued = new Set(); let timer = null;
function enqueue(playerId) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) return;
    queued.add(playerId);
    if (!timer) { timer = setTimeout(flush, 100); timer.unref(); }
}
function flush() {
    timer = null;
    for (const id of queued) {
        queued.delete(id);
        try { recompute(id); } catch (error) { console.error('[RaceInference] recompute failed:', error.message); }
    }
}
function recomputeAll() {
    return db.prepare(`SELECT id,has_intel,intel_updated_at,joined,battle_race_not_before FROM players WHERE id IN
        (SELECT att_player_id FROM battle_reports UNION SELECT def_player_id FROM battle_reports)`).all()
        .filter(row => !hasCurrentIntel(row) && row.joined !== 'N/A')
        .map(row => ({ player_id: row.id, status: recompute(row.id).status }));
}
function recordCalibration(playerId, incomingIntel) { return repository.recordCalibration(playerId, incomingIntel); }
function getCalibrationSummary() {
    const rows = repository.calibrationRows(evidence.modelVersion());
    const players = new Set(rows.map(row => row.player_id));
    const covered = rows.filter(row => Array.isArray(row.raw_credible_values) && row.raw_credible_values.length > 0);
    const credibleCoverage = covered.length ? covered.filter(row => row.raw_credible_values.includes(row.truth)).length / covered.length : null;
    const high = rows.filter(row => row.band === 'high');
    const highAccuracy = high.length ? high.filter(row => arithmetic.PICKS[row.dist.indexOf(Math.max(...row.dist))] === row.truth).length / high.length : null;
    // Expected probability of the most likely value versus observed accuracy, in bins.
    const groups = new Map();
    for (const row of rows) { const p = Math.max(...row.dist), bin = Math.min(9, Math.floor(p * 10)); if (!groups.has(bin)) groups.set(bin, []); groups.get(bin).push(row); }
    let calibrationError = rows.length ? 0 : null;
    for (const group of groups.values()) {
        const expected = group.reduce((sum, row) => sum + Math.max(...row.dist), 0) / group.length;
        const actual = group.filter(row => arithmetic.PICKS[row.dist.indexOf(Math.max(...row.dist))] === row.truth).length / group.length;
        calibrationError += Math.abs(expected - actual) * group.length / rows.length;
    }
    return { players: players.size, pairs: rows.length, high_pairs: high.length, high_accuracy: highAccuracy,
        credible_coverage: credibleCoverage, coverage_pairs: covered.length,
        calibration_error_pp: calibrationError === null ? null : calibrationError * 100,
        passed: players.size >= 30 && calibrationError !== null && calibrationError <= 0.05 && highAccuracy !== null && highAccuracy >= 0.9
            && covered.length === rows.length && credibleCoverage !== null && credibleCoverage >= 0.88 && credibleCoverage <= 0.92,
        model_version: evidence.modelVersion() };
}
module.exports = { recompute, recomputeAll, enqueue, flush, recordCalibration, getCalibrationSummary };
