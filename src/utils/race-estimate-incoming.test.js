// Hand-written evidence and calibration, without game or provider traffic.
const Model = require('../../public/js/utils/battle-model');
const Inference = require('../../public/js/utils/race-inference');
const Incoming = require('./incoming-battle');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const version = Inference.modelVersion(), hash = 'b'.repeat(64);
const trait = value => ({ most_likely: value, band: 'high', model_version: version, evidence_hash: hash,
    evidence_count: 4, withheld_reason: null, dist: Array.from({ length: 9 }, (_, i) => i === value + 4 ? 1 : 0) });
const enemyRow = { id: 720, has_intel: 0, science_level: 10, level: 5 };
const enemyEnvelope = {
    estimate: { player_id: 720, attack: { ...trait(1), hard_candidates: [0, 1, 2], set90_values: [0, 1, 2],
        set90_kind: 'conservative_compatibility', dist: [0, 0, 0, 0, 0.2, 0.7, 0.1, 0, 0] }, defence: trait(-1) },
    gate: { allowed: true, players: 30, pairs: 30, high_pairs: 8, coverage_pairs: 30, credible_coverage: 0.9,
        calibration_error_pp: 2, high_accuracy: 0.95, model_version: version },
    check: { state: 'AI-checked', input_hash: hash, current_input_hash: hash, model_version: version,
        attack: { verdict: 'agrees' }, defence: { verdict: 'agrees' }, bands: { attack: 'high', defence: 'high' } },
};
const input = { enemyFleet: [100, 0, 0], enemyRow, enemyEnvelope, sbLevel: 0, garrison: [100, 0, 0],
    owner: { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5 } };
const worst = Incoming.planetFight({ ...input, enemy: Model.resolveStats(enemyRow) });
const result = Incoming.secondaryRaceEstimate(input);
ok('a gated incoming estimate is separate and labels its numeric range', result?.source === 'estimate'
    && result.label === 'Estimated planet defence' && result.holds_low < result.holds_high
    && result.holds >= result.holds_low && result.holds <= result.holds_high, result);
ok('a secondary estimate does not mutate the existing worst-case headline or input row',
    JSON.stringify(worst) === JSON.stringify(Incoming.planetFight({ ...input, enemy: Model.resolveStats(enemyRow) }))
    && enemyRow.has_intel === 0 && enemyRow.race_attack === undefined);
for (const patch of [
    { gate: { ...enemyEnvelope.gate, allowed: false } },
    { check: { ...enemyEnvelope.check, state: 'held' } },
    { check: { ...enemyEnvelope.check, current_input_hash: 'outdated' } },
    { check: { ...enemyEnvelope.check, bands: { attack: 'low', defence: 'high' } } },
]) ok('an uncalibrated, held, stale or lowered estimate produces no incoming numeric result',
    Incoming.secondaryRaceEstimate({ ...input, enemyEnvelope: { ...enemyEnvelope, ...patch } }) === null, patch);
ok('observed enemy intel keeps its existing primary calculation', Incoming.secondaryRaceEstimate({ ...input,
    enemyRow: { ...enemyRow, has_intel: 1, race_attack: -2, race_defense: 1 } }) === null);
console.log(`race-estimate-incoming.test.js: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
