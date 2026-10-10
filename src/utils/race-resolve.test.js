// Fully synthetic gates and evidence hashes. A check state alone must never switch
// the application's unchanged worst-case calculation to an estimate.
const Model = require('../../public/js/utils/battle-model');
const Inference = require('../../public/js/utils/race-inference');
const { resolveRaceStats } = require('./race-resolve');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const version = Inference.modelVersion();
const hash = 'a'.repeat(64);
const trait = value => ({ most_likely: value, band: 'high', model_version: version,
    evidence_hash: hash, evidence_count: 5, withheld_reason: null,
    dist: Array.from({ length: 9 }, (_, i) => i === value + 4 ? 1 : 0) });
const envelope = {
    model_version: version, min_band: 'medium',
    estimate: { player_id: 710, attack: trait(2), defence: trait(-1) },
    gate: { allowed: true, players: 30, pairs: 30, high_pairs: 10,
        coverage_pairs: 30, credible_coverage: 0.9,
        calibration_error_pp: 5, high_accuracy: 0.9, model_version: version },
    check: { state: 'AI-checked', input_hash: hash, current_input_hash: hash,
        bands: { attack: 'high', defence: 'high' },
        attack: { verdict: 'agrees' }, defence: { verdict: 'agrees' }, model_version: version },
};
const player = { id: 710, has_intel: 0, science_level: 12, level: 10 };
let result = Model.resolveStats(player);
ok('no estimate retains the agreed +4/+4 worst-case numbers and labels its source',
    result.ra === 4 && result.rd === 4 && result.phys === 12 && result.math === 12
    && result.unknown && result.source === 'worst', result);
result = Model.resolveStats(player, envelope);
ok('a matching calibrated and AI-checked estimate resolves the estimate tier',
    result.ra === 2 && result.rd === -1 && result.source === 'estimate' && result.unknown === false, result);
result = Model.resolveStats({ ...player, has_intel: 1, race_attack: -3, race_defense: 3,
    physics: 6, mathematics: 5, intel_updated_at: new Date().toISOString() }, envelope);
ok('observed intel wins even over an eligible estimate',
    result.ra === -3 && result.rd === 3 && result.phys === 6 && result.source === 'intel', result);
const rejected = [
    { gate: { ...envelope.gate, allowed: false } },
    { gate: { ...envelope.gate, players: 29 } },
    { gate: { ...envelope.gate, pairs: 29 } },
    { gate: { ...envelope.gate, coverage_pairs: 29 } },
    { gate: { ...envelope.gate, coverage_pairs: null } },
    { gate: { ...envelope.gate, credible_coverage: 0.879 } },
    { gate: { ...envelope.gate, credible_coverage: 0.921 } },
    { gate: { ...envelope.gate, credible_coverage: null } },
    { gate: { ...envelope.gate, high_pairs: 0 } },
    { gate: { ...envelope.gate, calibration_error_pp: 5.01 } },
    { gate: { ...envelope.gate, calibration_error_pp: null } },
    { gate: { ...envelope.gate, high_accuracy: 0.899 } },
    { gate: { ...envelope.gate, model_version: 'old' } },
    { check: { ...envelope.check, state: 'not checked' } },
    { check: { ...envelope.check, state: 'held' } },
    { check: { ...envelope.check, state: 'outdated' } },
    { check: { ...envelope.check, current_input_hash: 'b'.repeat(64) } },
    { check: { ...envelope.check, defence: { verdict: 'disagrees' } } },
    { check: { ...envelope.check, attack: { verdict: 'cannot_check' } } },
    { check: { ...envelope.check, bands: { attack: 'low', defence: 'high' } } },
    { check: { ...envelope.check, bands: { attack: 'medium', defence: 'invalid' } } },
    { check: { ...envelope.check, bands: null } },
    { estimate: { ...envelope.estimate, player_id: 999 } },
    { estimate: { ...envelope.estimate, attack: { ...trait(2), model_version: 'old' } } },
    { estimate: { ...envelope.estimate, defence: { ...trait(-1), band: 'low' } } },
    { estimate: { ...envelope.estimate, defence: { ...trait(-1), withheld_reason: 'unresolved_conflict' } } },
    { estimate: { ...envelope.estimate, attack: { ...trait(2), most_likely: 5 } } },
];
for (const change of rejected) {
    result = Model.resolveStats(player, { ...envelope, ...change });
    ok('an incomplete, held, outdated or uncalibrated estimate keeps worst case',
        result.ra === 4 && result.rd === 4 && result.source === 'worst', change);
}
result = Model.resolveStats(player, { ...envelope, check: { ...envelope.check,
    bands: { attack: 'medium', defence: 'high' } } });
ok('AI lowering high to medium remains above the configured threshold', result.source === 'estimate', result);
result = Model.resolveStats(player, { ...envelope,
    estimate: { ...envelope.estimate, attack: { ...trait(2), band: 'medium' } },
    check: { ...envelope.check, bands: { attack: 'low', defence: 'high' } } });
ok('AI lowering medium to low keeps the unchanged worst-case calculation', result.source === 'worst', result);
result = Model.resolveStats(null, envelope);
ok('an unknown player cannot inherit an estimate', result.source === 'worst' && result.ra === 4 && result.phys === 0, result);
ok('the server policy derives its model version from current code', resolveRaceStats(player, envelope).source === 'estimate');
const oldVersion = 'outdated-model';
result = resolveRaceStats(player, { ...envelope, model_version: oldVersion,
    estimate: { ...envelope.estimate, attack: { ...trait(2), model_version: oldVersion }, defence: { ...trait(-1), model_version: oldVersion } },
    gate: { ...envelope.gate, model_version: oldVersion }, check: { ...envelope.check, model_version: oldVersion } });
ok('a caller cannot promote an outdated model by claiming its version is current', result.source === 'worst', result);
console.log(`race-resolve.test.js: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
