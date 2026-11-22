// SB buster plan: how many ships to send, in a few fleets landing one after another in
// front of the main fleet, to bring a starbase down to a target level.
//
// Since 7.2 a starbase takes double damage and keeps the fraction of a level it did not
// lose, so a few small fleets that each lose their fight still grind it down: 4 × 10 DS take
// an SB 11.99 to 11.69, 11.41, 11.15, 10.86 (game calculator, 2026-11-22). Pages show whole
// levels only, so a visible SB 11 is counted as 11.99, the worst case.
//
// Pure: every number comes from AWBattleModel.simulate(), so the plan uses exactly the
// battle calculator's model. Only the defender's Mathematics, race defence and level move
// the starbase's losses; the attacker's stats only change the busters' own win chance.
//
// LOADING: same dual-runtime pattern as battle-model.js.
//   • Node:    require('../../public/js/utils/sb-buster.js')
//   • Browser: import '../utils/battle-model.js'; import '../utils/sb-buster.js';
//              then read globalThis.AWSbBuster
(function (root, factory) {
    const api = factory(root.AWBattleModel || (typeof require === 'function' ? require('./battle-model.js') : null));
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWSbBuster = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
    'use strict';

    const SHIP_INDEX = { destroyers: 0, cruisers: 1, battleships: 2 };
    const MAX_SHIPS = 1e6;

    // A visible (whole) level could hide up to .99 more; a level typed with decimals is
    // taken as given.
    function worstCase(level, assumeHidden = true) {
        const n = M.clampStarbase(level);
        return assumeHidden && n > 0 && Number.isInteger(n) ? Math.min(50, n + 0.99) : n;
    }

    // The fights, in landing order, for `fleets` fleets of `perFleet` ships each.
    function chainFor({ sbLevel, perFleet, fleets = 4, ship = 'destroyers', def = {}, atk = {}, rules }) {
        const index = SHIP_INDEX[ship] ?? 0;
        const steps = [];
        let level = M.clampStarbase(sbLevel);
        for (let i = 0; i < fleets && level > 0; i++) {
            const atkFleet = [0, 0, 0];
            atkFleet[index] = perFleet;
            const r = M.simulate({ atkFleet, defFleet: [0, 0, 0], sbLevel: level, def, atk, rules });
            if (!r) break;
            steps.push({ fleet: i + 1, ships: perFleet, before: level, after: r.sbLevelLeft, winA: r.winA });
            level = r.sbLevelLeft;
        }
        return { steps, end: level };
    }

    // Fewest ships per fleet (all fleets equal) that leave the starbase at or below `target`
    // after the last buster fleet, assuming each buster fleet loses its fight. A starbase
    // defending alone never ends a fight below level 1, so a target under 1 cannot be
    // reached by busters that lose: the main fleet has to win that fight.
    function plan({ sbLevel, target, fleets = 4, ship = 'destroyers', def = {}, atk = {}, rules }) {
        const start = M.clampStarbase(sbLevel);
        const goal = M.clampStarbase(target);
        const count = Math.max(1, Math.min(12, Math.trunc(Number(fleets)) || 1));
        const base = { start, target: goal, fleets: count, ship };
        if (start <= goal) return { ...base, perFleet: 0, total: 0, steps: [], end: start, reason: 'already_at_target' };
        if (goal < 1) return { ...base, perFleet: null, total: null, steps: [], end: start, reason: 'below_level_1' };
        const run = perFleet => chainFor({ sbLevel: start, perFleet, fleets: count, ship, def, atk, rules });
        const ok = perFleet => run(perFleet).end <= goal + 1e-9;
        let hi = 1;
        while (!ok(hi)) {
            if (hi >= MAX_SHIPS) return { ...base, perFleet: null, total: null, steps: [], end: start, reason: 'too_many' };
            hi = Math.min(MAX_SHIPS, hi * 2);
        }
        let lo = Math.floor(hi / 2);
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (ok(mid)) hi = mid; else lo = mid;
        }
        const chain = run(hi);
        return { ...base, perFleet: hi, total: hi * count, steps: chain.steps, end: chain.end, reason: null };
    }

    return { worstCase, chainFor, plan, SHIP_INDEX };
});
