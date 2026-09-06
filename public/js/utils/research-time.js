// How long research takes from one level to another — the arithmetic the Science page's
// Research Time Calculator and the Economy price-drop countdown (issue #139) share.
//
// One science is researched at a time and every science shares one rate (docs/game-rules.md,
// "Science"). Reaching level k costs pointsByLevel[k] points; at `effRate` points per hour
// that is pointsByLevel[k] / effRate hours. When a level is in progress its remaining timer
// counts instead of its points: the timer was measured at the CURRENT rate, so it is scaled
// to the effective rate for the what-if inputs to stay consistent.
//
// LOADING: same dual Node/browser pattern as column-prefs.js.
//   • Node:    require('../../public/js/utils/research-time.js')
//   • Browser: import '../utils/research-time.js'; then read globalThis.AWResearch
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWResearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * @param {{level:number, rate:number, timerSecs?:number, researching?:boolean}} state
     *        as readScienceState returns it: current level, live rate (pts/h, bonus included),
     *        and the remaining seconds of the level in progress, if any
     * @param {Array<number>|Object<number,number>} pointsByLevel  points needed to REACH level k, indexed by k
     * @param {number} target       level to reach
     * @param {number} [effRate]    points/h to compute with (what-if); defaults to state.rate
     * @returns {{seconds:number, missing:number[], levels:number, reason?:string}}
     *          seconds is NaN when there is no rate to divide by; `missing` lists levels the
     *          table has no points for (their time is left out, not guessed)
     */
    function secondsToLevel(state, pointsByLevel, target, effRate) {
        const level = Math.max(0, Math.floor(Number(state && state.level) || 0));
        const rate = Number(state && state.rate) || 0;
        const eff = Number(effRate) > 0 ? Number(effRate) : rate;
        const tgt = Math.floor(Number(target));
        if (!Number.isFinite(tgt) || tgt <= level) return { seconds: 0, missing: [], levels: 0 };
        if (!(eff > 0)) return { seconds: NaN, missing: [], levels: tgt - level, reason: 'no-rate' };

        let seconds = 0;
        let startK = level + 1;
        if (state && state.researching) {
            seconds += (Number(state.timerSecs) || 0) * (rate > 0 ? rate / eff : 1);
            startK = level + 2;
        }
        const missing = [];
        for (let k = startK; k <= tgt; k++) {
            const pts = pointsByLevel ? Number(pointsByLevel[k]) : NaN;
            if (pointsByLevel == null || pointsByLevel[k] == null || !Number.isFinite(pts)) { missing.push(k); continue; }
            seconds += (pts / eff) * 3600;
        }
        return { seconds, missing, levels: tgt - level };
    }

    return { secondsToLevel };
});
