// Synthetic saved estimates. No live game, provider or paid call.
const Display = require('../../public/js/utils/race-estimate-display');
const Model = require('../../public/js/utils/battle-model');
const Inference = require('../../public/js/utils/race-inference');
const { truePower } = require('./true-power');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const version = Inference.modelVersion(), hash = 'a'.repeat(64);
const trait = value => ({ most_likely: value, band: 'high', model_version: version, evidence_hash: hash,
    evidence_count: 4, evidence_report_ids: [101, 202], hard_candidates: [value],
    estimated_at: '2026-10-10T12:00:00Z', prior: { name: 'uniform' }, withheld_reason: null,
    dist: Array.from({ length: 9 }, (_, i) => i === value + 4 ? 1 : 0) });
const envelope = {
    player: { id: 710, has_intel: 0, science_level: 10, level: 5 },
    model_version: version,
    estimate: { player_id: 710, attack: trait(2), defence: trait(-1) },
    gate: { allowed: true, players: 30, pairs: 30, high_pairs: 8, coverage_pairs: 30, credible_coverage: 0.9,
        calibration_error_pp: 1, high_accuracy: 0.95, model_version: version },
    check: { state: 'AI-checked', input_hash: hash, current_input_hash: hash,
        bands: { attack: 'high', defence: 'high' },
        attack: { verdict: 'agrees' }, defence: { verdict: 'agrees' }, model_version: version, current_model_version: version },
};
ok('calibrated race values retain the estimate label without claiming compatible picks have 90% coverage',
    /estimate ~\+2.*high band.*compatible range \+2/.test(Display.traitText(trait(2), { calibrated: true }))
    && !/90%/.test(Display.traitText(trait(2), { calibrated: true })));
ok('uncalibrated ranges state model compatibility without claiming probability coverage',
    /compatible range.*uncalibrated/.test(Display.traitText(trait(2))) && !/90% set/.test(Display.traitText(trait(2))));
ok('a disjoint credible set does not claim impossible intermediate picks', Display.setText([1, 4]) === '+1 or +4');
ok('malformed distributions and held traits fail closed', Display.traitText({ ...trait(2), hard_candidates: [7] }) === 'estimate unavailable'
    && Display.traitText({ ...trait(2), dist: [1] }) === 'estimate unavailable'
    && Display.traitText({ ...trait(2), withheld_reason: 'conflict' }) === 'estimate unavailable');
ok('a stale AI hash is always labelled outdated', Display.checkStatus({ ...envelope.check, current_input_hash: 'b'.repeat(64) }) === 'outdated'
    && /LLM check outdated/.test(Display.checkLabel({ ...envelope.check, current_input_hash: 'b'.repeat(64) })));
ok('an unchecked estimate is explicitly probable without an LLM confirmation', Display.checkStatus(null) === 'not_checked'
    && Display.checkLabel(null) === 'Probable estimate — not checked by LLM');
ok('only a complete agreeing current proof is labelled confirmed by LLM', Display.checkStatus(envelope.check) === 'AI-checked'
    && Display.checkLabel(envelope.check) === 'Estimate confirmed by LLM');
for (const changed of [
    { state: 'not_checked', status: 'current' },
    { state: 'cannot_check', status: 'current' },
    { state: 'held' },
    { outdated: true },
    { status: 'outdated' },
    { current_model_version: 'previous-model' },
    { current_model_version: null },
    { current_input_hash: null },
    { input_hash: ' ', current_input_hash: ' ' },
    { defence: { verdict: 'cannot_check' } },
]) ok('held, stale, inconclusive or incomplete proof cannot claim LLM confirmation',
    Display.checkStatus({ ...envelope.check, ...changed }) !== 'AI-checked'
    && Display.checkLabel({ ...envelope.check, ...changed }) !== 'Estimate confirmed by LLM', changed);
ok('a held review takes precedence even when its evidence is outdated', Display.checkStatus({ ...envelope.check,
    state: 'held', current_input_hash: 'b'.repeat(64) }) === 'held');
ok('a current AI lower is displayed without ever raising the stored band',
    /medium band/.test(Display.traitText(trait(2), { calibrated: true, kind: 'attack',
        check: { ...envelope.check, bands: { attack: 'medium', defence: 'high' } } }))
    && Display.effectiveBand({ ...trait(2), band: 'low' }, envelope.check, 'attack') === 'low');
ok('an outdated AI lower cannot change the displayed evidence band',
    Display.effectiveBand(trait(2), { ...envelope.check, state: 'outdated', bands: { attack: 'low' } }, 'attack') === 'high');
ok('a current validated cannot-check verdict still lowers its display band without permitting calculation',
    Display.effectiveBand(trait(2), { ...envelope.check, state: 'cannot_check', status: 'current',
        attack: { verdict: 'cannot_check' }, bands: { attack: 'medium' } }, 'attack') === 'medium');
const inputs = { defFleet: [100, 0, 0], atkFleet: [100, 0, 0], sbLevel: 0,
    def: { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5 }, atk: { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5 } };
let rows = Display.comparisonRows(inputs, { atk: { ...envelope, gate: { ...envelope.gate, allowed: false } } });
ok('before calibration comparisons contain no estimated numeric win chance', rows.find(row => row.source === 'estimate').values === null
    && !!rows.find(row => row.source === 'worst').values);
rows = Display.comparisonRows(inputs, { atk: envelope });
ok('a fully gated estimate produces a separately labelled range alongside worst case',
    !!rows.find(row => row.source === 'estimate').values && rows.find(row => row.source === 'estimate').label === 'Estimate'
    && rows.find(row => row.source === 'worst').label.includes('Worst case'));
rows = Display.comparisonRows(inputs, { atk: { ...envelope, check: { ...envelope.check, state: 'held' } } });
ok('a held estimate cannot produce comparison numbers', rows.find(row => row.source === 'estimate').values === null);
const historicalBio = { ...envelope.player, has_intel: 1, race_attack: -3, race_defense: -2,
    joined: '2026-10-01', intel_updated_at: '2026-09-02 12:00:00', battle_race_not_before: '2026-10-01 00:00:00' };
rows = Display.comparisonRows(inputs, { atk: { ...envelope, player: historicalBio } });
ok('a preserved bio flag before the current incarnation cannot produce an Intel comparison',
    rows.find(row => row.source === 'intel').values === null);
rows = Display.comparisonRows(inputs, { atk: { ...envelope, player: { ...historicalBio, intel_updated_at: '2026-10-02 12:00:00' } } });
ok('fresh bio after the current incarnation supplies the separately labelled Intel comparison',
    !!rows.find(row => row.source === 'intel').values);
const broad = { ...envelope, estimate: { ...envelope.estimate,
    attack: { ...trait(2), hard_candidates: [-4, 2, 4], set90_values: [-4, 2, 4], set90_kind: 'conservative_compatibility' } } };
rows = Display.comparisonRows(inputs, { atk: broad });
ok('comparison ranges keep all compatible picks even when the posterior mass set is a singleton',
    Display.credibleSet(broad.estimate.attack).length === 1 && Display.compatibleSet(broad.estimate.attack).length === 3
    && rows.find(row => row.source === 'estimate').values.attacker.low < rows.find(row => row.source === 'estimate').values.attacker.high
    && !/90%/.test(rows.find(row => row.source === 'estimate').reason));
const sheetPlayer = { ...envelope.player, sheet_physics: 8, sheet_mathematics: 6, sheet_sciences_updated_at: '2026-10-10T12:00:00Z' };
let rating = truePower(sheetPlayer, {}, envelope);
ok('gated True Power estimates require observed sciences and retain source', typeof rating.tp === 'number' && rating.source === 'estimate', rating);
rating = truePower(envelope.player, {}, envelope);
ok('even a gated race estimate cannot manufacture physics for a numeric rating', rating.tp === null && rating.tpx === null, rating);
rating = truePower(sheetPlayer, {}, { ...envelope, check: { ...envelope.check, state: 'outdated' } });
ok('outdated checks preserve the unknown True Power rating', rating.tp === null && rating.tpx === null, rating);

console.log(`race-display-ui.test.js: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
