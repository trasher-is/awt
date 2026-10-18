// Fight simulation plan — the numbers behind the battle calculator's "Fight" animation.
//
// The animation does NOT run a combat simulation of its own. It takes the result of
// AWBattleModel.simulate(), rolls one die against the win chance, and stages the fight so
// it ends exactly on that outcome. Everything decided here is pure, so it is tested in
// Node (src/utils/fight-plan.test.js); public/js/ui/battle-anim.js only draws it.
//
// The roll: u is uniform in [0, 1). The defender wins when u < winD, so a 33.6% defender
// wins on rolls 0–33.6. The loser is wiped (ships and starbase), the way real battle
// reports look; the winner keeps the model's survivors.
//
// LOADING: same dual-runtime pattern as battle-model.js.
//   • Node:    require('../../public/js/utils/fight-plan.js')
//   • Browser: import '../utils/fight-plan.js';  then read globalThis.AWFightPlan
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWFightPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Above these counts one icon stands for several ships, so a 900-destroyer fleet
    // still fits on a phone screen. Order: destroyers, cruisers, battleships.
    const ICON_CAPS = [60, 28, 14];

    function rollOutcome(result, u) {
        const winner = u < result.winD ? 'def' : 'atk';
        return {
            u,
            winner,
            survDef: winner === 'def' ? result.survDef.slice() : [0, 0, 0],
            survAtk: winner === 'atk' ? result.survAtk.slice() : [0, 0, 0],
            survSB: winner === 'def' ? result.survSB : 0,
        };
    }

    // How many icons each ship type gets, how many ships one icon stands for, and how
    // many icons are still flying at the end. A surviving half ship or more keeps at
    // least one icon, so a winner never looks wiped out on screen.
    function iconPlan(fleet, surv) {
        return fleet.map((n, t) => {
            const per = Math.max(1, Math.ceil(n / ICON_CAPS[t]));
            const icons = Math.ceil(n / per);
            // By share of the fleet, not surv/per: 40 battleships shown as 14 icons of 3
            // must keep all 14 when all 40 survive (40/3 rounds to 13).
            const keep = surv[t] >= 0.5 ? Math.min(icons, Math.max(1, Math.round(icons * surv[t] / n))) : 0;
            return { per, icons, keep };
        });
    }

    // Highest whole starbase level whose CV fits in what is left.
    function sbLevelLeft(sbCV, sbLvl, survSB) {
        const left = survSB * sbCV(sbLvl);
        let n = 0;
        while (n < 50 && sbCV(n + 1) <= left + 1e-9) n++;
        return n;
    }

    return { ICON_CAPS, rollOutcome, iconPlan, sbLevelLeft };
});
