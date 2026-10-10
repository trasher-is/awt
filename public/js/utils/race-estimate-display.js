// Labels and comparisons for stored race estimates. No requests, writes or AI calls.
(function (root, factory) {
    const model = typeof module === 'object' && module.exports ? require('./battle-model') : root.AWBattleModel;
    const api = factory(model);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AWRaceEstimateDisplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
    'use strict';
    const pick = value => Number.isInteger(value) && value >= -4 && value <= 4;
    const signed = value => value >= 0 ? `+${value}` : String(value);
    function credibleSet(trait) {
        if (!trait || !Array.isArray(trait.dist) || trait.dist.length !== 9
            || trait.dist.some(value => !Number.isFinite(value) || value < 0 || value > 1)
            || Math.abs(trait.dist.reduce((sum, value) => sum + value, 0) - 1) > 1e-6) return [];
        const sorted = trait.dist.map((mass, i) => ({ mass, value: i - 4 })).sort((a, b) => b.mass - a.mass || a.value - b.value);
        let mass = 0;
        const values = [];
        for (const row of sorted) {
            if (row.mass <= 0) continue;
            values.push(row.value); mass += row.mass;
            if (mass >= 0.9 - 1e-10) break;
        }
        return values.sort((a, b) => a - b);
    }
    function setText(values) {
        const set = [...new Set((Array.isArray(values) ? values : []).filter(pick))].sort((a, b) => a - b);
        if (!set.length) return 'unavailable';
        if (set.length === 1) return signed(set[0]);
        if (set.every((value, i) => i === 0 || value === set[i - 1] + 1)) return `${signed(set[0])}…${signed(set[set.length - 1])}`;
        return set.map(signed).join(' or ');
    }
    function compatibleSet(trait) {
        const values = trait?.set90_values || trait?.hard_candidates;
        if (!Array.isArray(values) || !values.length || values.some(value => !pick(value))) return [];
        return [...new Set(values)].sort((a, b) => a - b);
    }
    function effectiveBand(trait, check, kind) {
        const bands = ['none', 'low', 'medium', 'high'];
        const original = bands.indexOf(trait?.band);
        if (original < 0) return 'none';
        const current = check?.input_hash && check.input_hash === check.current_input_hash
            && (check.status === 'current' || checkLabel(check) === 'AI-checked');
        if (!current || check.state === 'outdated') return trait.band;
        const checked = bands.indexOf(check.bands?.[kind]);
        return checked < 0 ? 'none' : bands[Math.min(original, checked)];
    }
    function traitText(trait, { calibrated = false, check, kind } = {}) {
        if (check) trait = trait && { ...trait, band: effectiveBand(trait, check, kind) };
        if (!trait || trait.withheld_reason || !pick(trait.most_likely) || !['high', 'medium', 'low'].includes(trait.band)) return 'estimate unavailable';
        const values = compatibleSet(trait);
        if (!values.length || !credibleSet(trait).length) return 'estimate unavailable';
        return calibrated
            ? `estimate ~${signed(trait.most_likely)} · ${trait.band} band · compatible range ${setText(values)}`
            : `estimate ~${signed(trait.most_likely)} · compatible range ${setText(values)} · ${trait.band} evidence band (uncalibrated)`;
    }
    function checkLabel(check) {
        if (!check) return 'not checked';
        if (check.state === 'held') return 'held';
        if (check.state === 'outdated' || (check.input_hash && check.current_input_hash && check.input_hash !== check.current_input_hash)) return 'outdated';
        return check.state === 'AI-checked' && check.input_hash && check.input_hash === check.current_input_hash
            && check.attack?.verdict === 'agrees' && check.defence?.verdict === 'agrees' ? 'AI-checked' : 'not checked';
    }
    function comparisonRows(inputs, sides) {
        const selected = ['def', 'atk'].filter(side => sides[side]?.player);
        if (!selected.length) return [];
        const normal = side => sides[side]?.player ? model.resolveStats(sides[side].player) : inputs[side];
        const effective = side => sides[side]?.player ? model.resolveStats(sides[side].player, sides[side]) : inputs[side];
        const run = (def, atk) => model.simulate({ ...inputs, def, atk });
        const summarize = (result, def, atk) => result ? {
            defender: model.winBand(result.winD, { ...inputs, def, atk }),
            attacker: model.winBand(result.winA, { ...inputs, def, atk }),
        } : null;
        const worstDef = normal('def'), worstAtk = normal('atk');
        const rows = [{ source: 'intel', label: 'Intel', values: null, reason: 'Selected players do not both have observed intel.' }];
        if (selected.every(side => model.hasCurrentIntel(sides[side].player))) {
            rows[0].values = summarize(run(worstDef, worstAtk), worstDef, worstAtk);
            rows[0].reason = null;
        }
        const def = effective('def'), atk = effective('atk');
        const estimateRow = { source: 'estimate', label: 'Estimate', values: null,
            reason: 'Unavailable until calibration and a current agreeing AI check pass.' };
        if (selected.some(side => effective(side).source === 'estimate')) {
            const possibilities = side => {
                const resolved = side === 'def' ? def : atk;
                if (resolved.source !== 'estimate') return [resolved];
                return compatibleSet(sides[side].estimate.attack).map(ra => ({ ...resolved, ra }));
            };
            const results = [];
            for (const defender of possibilities('def')) for (const attacker of possibilities('atk')) {
                const result = run(defender, attacker);
                if (result) results.push(summarize(result, defender, attacker));
            }
            if (results.length) {
                const band = key => ({ low: Math.min(...results.map(row => row[key].low)),
                    high: Math.max(...results.map(row => row[key].high)) });
                estimateRow.values = { defender: band('defender'), attacker: band('attacker') };
                estimateRow.reason = 'Range over compatible race picks; other unknown races use worst case.';
            }
        }
        rows.push(estimateRow, { source: 'worst', label: 'Worst case for unknown races',
            values: summarize(run(worstDef, worstAtk), worstDef, worstAtk), reason: null });
        return rows;
    }
    return { signed, credibleSet, compatibleSet, setText, effectiveBand, traitText, checkLabel, comparisonRows };
});
