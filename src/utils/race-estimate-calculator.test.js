// Synthetic selections and deferred hub responses, not game requests.
const fs = require('fs');
const path = require('path');
const Model = require('../../public/js/utils/battle-model');
const Inference = require('../../public/js/utils/race-inference');
const Display = require('../../public/js/utils/race-estimate-display');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const source = fs.readFileSync(path.join(__dirname, '../../public/js/ui/battle-calc.js'), 'utf8');
const load = new Function('document', 'fetch', 'globalThis', 'esc', `${source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')}
    return { fillPlayerStats, loadRaceEnvelope, initBattleCalc, raceComparisonHtml,
        select(prefix, player) { selectedSides[prefix] = { player }; return ++selectionGeneration[prefix]; },
        selected(prefix) { return selectedSides[prefix]; } };`);
class Input {
    constructor(id) { this.id = id; this.value = 0; this.events = {}; }
    addEventListener(type, callback) { this.events[type] = callback; }
    edit(value) { this.value = value; this.events.input?.(); }
}
const inputs = new Map(['def', 'atk'].flatMap(side => ['phys', 'math', 'ra', 'rd', 'lvl', 'd', 'c', 'b']
    .map(field => [`bc-${side}-${field}`, new Input(`bc-${side}-${field}`)])));
const calls = [], responses = [];
const fetch = (url, init = {}) => new Promise(resolve => { calls.push({ url, ...init }); responses.push(resolve); });
const calc = load({ getElementById: id => inputs.get(id) || null,
    querySelectorAll: selector => selector.includes('.bc-num-input') ? [...inputs.values()] : [] }, fetch,
    { AWBattleModel: Model, AWRaceEstimateDisplay: Display }, value => String(value));
const player = { id: 730, name: 'Synthetic Pilot', has_intel: 0, science_level: 10, level: 5 };
const version = Inference.modelVersion(), hash = 'c'.repeat(64);
const trait = value => ({ most_likely: value, band: 'high', evidence_count: 5, model_version: version,
    evidence_hash: hash, hard_candidates: [value], withheld_reason: null,
    dist: Array.from({ length: 9 }, (_, i) => i === value + 4 ? 1 : 0) });
const envelope = { success: true, player, model_version: version,
    estimate: { player_id: 730, attack: trait(1), defence: trait(-2) },
    gate: { allowed: true, players: 30, pairs: 30, high_pairs: 8, high_accuracy: 0.95,
        coverage_pairs: 30, credible_coverage: 0.9,
        calibration_error_pp: 2, model_version: version },
    check: { state: 'AI-checked', input_hash: hash, current_input_hash: hash, model_version: version,
        attack: { verdict: 'agrees' }, defence: { verdict: 'agrees' }, bands: { attack: 'high', defence: 'high' } } };
const response = data => ({ ok: true, json: async () => data });
(async () => {
    calc.initBattleCalc();
    calc.fillPlayerStats('atk', player);
    ok('selecting an unknown player starts at the agreed worst-case race, not neutral zero',
        inputs.get('bc-atk-ra').value === 4 && inputs.get('bc-atk-rd').value === 4);
    let generation = calc.select('atk', player);
    let pending = calc.loadRaceEnvelope('atk', player, generation);
    inputs.get('bc-atk-ra').edit(-3);
    responses.shift()(response(envelope)); await pending;
    ok('a late saved estimate cannot overwrite manually edited combat inputs',
        inputs.get('bc-atk-ra').value === -3 && calc.selected('atk') === null);
    generation = calc.select('atk', player);
    pending = calc.loadRaceEnvelope('atk', player, generation);
    responses.shift()(response({ ...envelope, gate: { ...envelope.gate, allowed: false } })); await pending;
    ok('a successful response with a closed gate still fills worst-case stats',
        inputs.get('bc-atk-ra').value === 4 && inputs.get('bc-atk-rd').value === 4);
    generation = calc.select('atk', player);
    pending = calc.loadRaceEnvelope('atk', player, generation);
    responses.shift()(response(envelope)); await pending;
    ok('only a current fully gated estimate fills labelled estimated race values',
        inputs.get('bc-atk-ra').value === 1 && inputs.get('bc-atk-rd').value === -2
        && /Attacker: estimate/.test(calc.raceComparisonHtml()));
    generation = calc.select('atk', player);
    pending = calc.loadRaceEnvelope('atk', player, generation);
    const second = { ...player, id: 731 };
    calc.select('atk', second); calc.fillPlayerStats('atk', second);
    responses.shift()(response(envelope)); await pending;
    ok('changing the selected player prevents the previous response from replacing the selection',
        calc.selected('atk').player.id === 731 && inputs.get('bc-atk-ra').value === 4);
    ok('calculator selection reads stored hub data only, without writes or game requests',
        calls.length === 4 && calls.every(call => call.url.startsWith('/hub-api/intel/player/') && !call.method));
    console.log(`race-estimate-calculator.test.js: ${failed} failures`);
    process.exitCode = failed ? 1 : 0;
})();
