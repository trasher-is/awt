// The shadow estimator's arithmetic is shared by Node and the browser. Observations
// are built once by the server's hard-range card; this module never reads game pages.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./battle-model'));
    else root.AWRaceInference = factory(root.AWBattleModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
    'use strict';
    const PICKS = Object.freeze(Array.from({ length: 9 }, (_, i) => i - 4));
    const WINDOW_MS = 48 * 3600000;
    // Versioning is deterministic in both runtimes; this hash identifies constants,
    // while the server's separate SHA-256 evidence hash binds a check to its inputs.
    function modelVersion() {
        let hash = 2166136261;
        for (const character of JSON.stringify(model.constants)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
        return (hash >>> 0).toString(16).padStart(8, '0');
    }
    const log = value => value > 0 ? Math.log(value) : -Infinity;
    function logsum(values) {
        const top = Math.max(...values);
        return Number.isFinite(top) ? top + Math.log(values.reduce((sum, value) => sum + Math.exp(value - top), 0)) : -Infinity;
    }
    function cdf(x) {
        const sign = x < 0 ? -1 : 1, z = Math.abs(x) / Math.sqrt(2), t = 1 / (1 + 0.3275911 * z);
        const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
        return (1 + sign * erf) / 2;
    }
    function replay(observation, trait, race, science, level) {
        const self = { ra: trait === 'attack' ? race : PICKS.at(-1), rd: trait === 'defence' ? race : PICKS.at(-1),
            phys: trait === 'attack' ? science : observation.scienceCeiling,
            math: trait === 'defence' ? science : observation.scienceCeiling, lvl: level };
        return model.simulate({ atkFleet: observation.atkFleet, defFleet: observation.defFleet, sbLevel: observation.sbLevel,
            atk: observation.side === 'att' ? self : observation.known,
            def: observation.side === 'att' ? observation.known : self });
    }
    function winSigma(observation) {
        const mixed = observation.atkFleet.filter(n => n > 0).length > 1 || observation.defFleet.filter(n => n > 0).length > 1;
        return model.uncertainty.BASE_ERROR_PP + (mixed ? model.uncertainty.MIXED_FLEET_EXTRA_PP : 0);
    }
    function probability(observation, trait, result) {
        if (!result) return 0;
        if (trait === 'attack') {
            const prediction = result.winA * 100, sigma = winSigma(observation);
            if (observation.observedWin === 0) return prediction <= sigma ? 1 : 0;
            if (observation.observedWin === 100) return prediction >= 100 - sigma ? 1 : 0;
            if (observation.observedWin !== null) return Math.exp(-0.5 * ((prediction - observation.observedWin) / sigma) ** 2);
            // Dice and a recorded outcome give a weak bound. Outcome alone never enters.
            if (observation.dice !== null) return ((prediction >= observation.dice) === observation.attackerWon) ? 0.75 : 0.25;
            return 1;
        }
        const win = observation.side === 'att' ? result.winA : result.winD;
        if (win <= 0) return 1; // censored by the certainty cap: it supplies no point loss
        const survivors = observation.side === 'att' ? result.survAtk : result.survDef;
        const fleet = observation.side === 'att' ? observation.atkFleet : observation.defFleet;
        let value = 1;
        for (let i = 0; i < fleet.length; i++) {
            if (!fleet[i]) continue;
            // Whole survivors can round either way. Integrate, rather than assert a
            // fractional ship count. 0.5 is the shared model's fixture survivor margin.
            const observed = observation.survivors[i];
            value *= Math.max(1e-300, cdf((observed + 1 - survivors[i]) / 0.5) - cdf((observed - 1 - survivors[i]) / 0.5));
        }
        return value;
    }
    function usable(observation, trait) {
        if (trait === 'attack') return observation.observedWin !== null || observation.dice !== null;
        if (!observation.defense_candidates || !observation.survivors) return false;
        const fleet = observation.side === 'att' ? observation.atkFleet : observation.defFleet;
        // A survivor at the game's floor does not reveal an exact loss multiplier.
        return fleet.every((n, i) => !n || observation.survivors[i] > 2.5);
    }
    function evidenceMatrix(observation, trait) {
        if (!usable(observation, trait)) return null;
        const matrix = PICKS.map(race => Array.from({ length: observation.scienceCeiling + 1 }, (_, science) => {
            const levels = [];
            for (let level = 0; level <= observation.levelCeiling; level++) levels.push(log(probability(observation, trait, replay(observation, trait, race, science, level))));
            return logsum(levels) - Math.log(levels.length);
        }));
        return { report_id: observation.report_id, side: observation.side, kind: trait === 'attack' ? 'win' : 'loss',
            when: observation.when, matrix, scienceCeiling: observation.scienceCeiling,
            observed: trait === 'attack' ? observation.observedWin : observation.losses.reduce((sum, n) => sum + n, 0),
            sigma: trait === 'attack' ? winSigma(observation) : 0.5,
            flags: [observation.observedWin === null && trait === 'attack' ? 'dice_fallback' : null,
                [0, 100].includes(observation.observedWin) && trait === 'attack' ? 'capped' : null].filter(Boolean) };
    }
    function windows(evidence, windowMs) {
        const groups = [];
        for (const row of [...evidence].sort((a, b) => a.when - b.when || a.report_id - b.report_id)) {
            let group = groups.at(-1);
            if (!group || row.when - group.start >= windowMs) { group = { start: row.when, rows: [] }; groups.push(group); }
            group.rows.push(row);
        }
        return groups;
    }
    function summarize(dist, evidenceCount) {
        const highest = Math.max(...dist), index = dist.indexOf(highest);
        const ranked = dist.map((probability, i) => ({ probability, value: PICKS[i] })).sort((a, b) => b.probability - a.probability || a.value - b.value);
        const credibleValues = []; let credibleMass = 0;
        for (const row of ranked) {
            if (!row.probability) continue;
            credibleValues.push(row.value); credibleMass += row.probability;
            if (credibleMass >= 0.9 - 1e-12) break;
        }
        let best = null;
        for (let low = 0; low < dist.length; low++) {
            let mass = 0;
            for (let high = low; high < dist.length; high++) {
                mass += dist[high];
                if (mass >= 0.9 - 1e-12) {
                    if (!best || high - low < best.high - best.low || (high - low === best.high - best.low && mass > best.mass)) best = { low, high, mass };
                    break;
                }
            }
        }
        return { dist, most_likely: evidenceCount ? PICKS[index] : null,
            set90_low: best ? PICKS[best.low] : null, set90_high: best ? PICKS[best.high] : null,
            credible_low: best ? PICKS[best.low] : null, credible_high: best ? PICKS[best.high] : null,
            band: !evidenceCount ? 'none' : highest >= 0.8 && best && best.high - best.low <= 1 ? 'high' : highest >= 0.55 ? 'medium' : 'low',
            credible_values: credibleValues.sort((a, b) => a - b), evidence_count: evidenceCount };
    }
    function estimateTrait(observations, trait, hardCandidates, prior, windowMs, calibrated) {
        const evidence = observations.map(row => evidenceMatrix(row, trait)).filter(Boolean);
        const scores = PICKS.map((pick, i) => hardCandidates.includes(pick) ? log(prior[i]) : -Infinity);
        for (const group of windows(evidence, windowMs)) {
            // Same science within a window: multiply report likelihoods FIRST, then
            // marginalize once. Independent windows may have different science values.
            const ceiling = Math.min(...group.rows.map(row => row.scienceCeiling));
            for (let race = 0; race < PICKS.length; race++) {
                scores[race] += logsum(Array.from({ length: ceiling + 1 }, (_, science) =>
                    group.rows.reduce((sum, row) => sum + row.matrix[race][science], 0))) - Math.log(ceiling + 1);
            }
        }
        const norm = logsum(scores), conflict = !Number.isFinite(norm);
        const dist = conflict ? PICKS.map(() => 0) : scores.map(score => Math.exp(score - norm));
        const summary = summarize(dist, evidence.length);
        if (!calibrated && !conflict) {
            // A uniform science prior can prefer one pick solely because more nuisance
            // states explain it. Until measured calibration supports that prior, the
            // reported set retains EVERY hard-compatible value, including sparse ones.
            summary.set90_low = Math.min(...hardCandidates); summary.set90_high = Math.max(...hardCandidates);
            if (summary.band === 'high' && hardCandidates.length > 2) summary.band = 'medium';
        }
        return { ...summary, ...(conflict ? { most_likely: null, band: 'none', set90_low: null, set90_high: null } : {}),
            set90_values: conflict ? [] : calibrated ? summary.credible_values : [...hardCandidates],
            set90_kind: calibrated ? 'posterior' : 'conservative_compatibility',
            conflict, hard_candidates: [...hardCandidates],
            evidence_report_ids: evidence.map(row => row.report_id), evidence };
    }
    function estimate(observations, { hardRanges = {}, prior = null, windowMs = WINDOW_MS, calibrated = false } = {}) {
        const weights = prior || PICKS.map(() => 1 / PICKS.length);
        if (!Array.isArray(weights) || weights.length !== 9 || weights.some(p => !Number.isFinite(p) || p <= 0)) throw new TypeError('Race prior must have nine positive weights.');
        return { attack: estimateTrait(observations, 'attack', hardRanges.attack || PICKS, weights, windowMs, calibrated),
            defence: estimateTrait(observations, 'defence', hardRanges.defence || PICKS, weights, windowMs, calibrated),
            prior: prior ? { name: 'supplied', weights } : { name: 'uniform', weights }, window_hours: windowMs / 3600000 };
    }
    return { PICKS, WINDOW_MS, estimate, evidenceMatrix, summarize, logsum, replay, modelVersion, windows, winSigma };
});
