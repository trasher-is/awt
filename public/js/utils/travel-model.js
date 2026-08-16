// THE fleet travel-time formula. One copy, used by every caller in this repo.
//
// LOADING: written so that ONE file serves both runtimes without a build step.
//   • Node:    require('../../public/js/utils/travel-model.js')
//   • Browser: import '../utils/travel-model.js';  then read globalThis.AWTravelModel
//     (no ESM exports, so the import runs the file for its side effect and the API lands
//     on globalThis — a static, synchronous import.)
//
// ─── THE FORMULA ──────────────────────────────────────────────────────────────
// Shared modifier on the reducible (distance-dependent) part of both flight types:
//   mod = 0.91^energy / (1 + 0.11·speed)
//     • Energy: each level is 91% of the previous one (the game's Energy table).
//     • Speed: the race attribute raises velocity ±11%/level, so it DIVIDES time
//       (+4 -> ÷1.44, −4 -> ÷0.56).
//
// Each flight is a FIXED minimum (never reduced) plus a reducible part scaled by mod:
//   same system: 1200 + 14400·√(|Δplanet|+1) · mod                  (20-minute minimum)
//   deep space:  2700 + (36000·dist + 3600·√(|Δplanet|+1)) · mod    (45-minute minimum)
//     dist = Euclidean distance between the two systems' (x, y) coordinates.
//
// ALLIANCE / own-destination move: ×0.5 (always halved).
//
// Rounding: floor at the end, then floor again after halving. Confirmed against the
// measurements in travel-fixtures.json — floor matches 9 of 9, round only 5 of 9,
// including a case whose unfloored value ends in .970. See docs/travel-calibration.md.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWTravelModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SAME_SYSTEM_MIN = 1200;      // 20 minutes
    const SAME_SYSTEM_PLANET = 14400;
    const DEEP_SPACE_MIN = 2700;       // 45 minutes
    const DEEP_SPACE_DIST = 36000;
    const DEEP_SPACE_PLANET = 3600;
    const ENERGY_BASE = 0.91;          // each energy level is 91% of the previous
    const SPEED_STEP = 0.11;           // race speed changes velocity by 11% per level
    const ALLIANCE_FACTOR = 0.5;

    // Energy and speed are integer levels. parseInt is what the server has always done;
    // the browser panel used to skip it, which is the only way the two copies could ever
    // have disagreed for the same route.
    const level = v => parseInt(v, 10) || 0;

    function speedModifier(energy, raceSpeed) {
        return Math.pow(ENERGY_BASE, level(energy)) / (1 + SPEED_STEP * level(raceSpeed));
    }

    function calcTravelSeconds(startX, startY, startPlanet, endX, endY, endPlanet, energy, raceSpeed, isAlliance) {
        const mod = speedModifier(energy, raceSpeed);
        const planetTerm = Math.sqrt(Math.abs(startPlanet - endPlanet) + 1);

        let travelTime;
        if (startX === endX && startY === endY) {
            travelTime = SAME_SYSTEM_MIN + SAME_SYSTEM_PLANET * planetTerm * mod;
        } else {
            const dx = endX - startX;
            const dy = endY - startY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            travelTime = DEEP_SPACE_MIN + (DEEP_SPACE_DIST * dist + DEEP_SPACE_PLANET * planetTerm) * mod;
        }

        travelTime = Math.floor(travelTime);
        return isAlliance ? Math.floor(travelTime * ALLIANCE_FACTOR) : travelTime;
    }

    function systemDistance(startX, startY, endX, endY) {
        const dx = endX - startX, dy = endY - startY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Analytic inverse of the deep-space branch, for the galaxy map's isochrone rings:
    // how far (in coordinate units) a fleet gets within a time budget of `seconds`.
    // The planet term is fixed at √(0+1) = 1 (same planet index on both ends), so
    //   T = 2700 + (36000·dist + 3600)·mod   inverts to
    //   dist = ((T[÷0.5 if alliance] − 2700)/mod − 3600)/36000
    // Clamped at 0: a budget below the fixed deep-space minimum reaches no other system.
    // The alliance halving is undone BEFORE inverting, mirroring where the forward
    // formula applies it (after everything else).
    function isochroneRadius(seconds, energy, raceSpeed, isAlliance) {
        const mod = speedModifier(energy, raceSpeed);
        const budget = isAlliance ? seconds / ALLIANCE_FACTOR : seconds;
        const dist = ((budget - DEEP_SPACE_MIN) / mod - DEEP_SPACE_PLANET) / DEEP_SPACE_DIST;
        return Math.max(0, dist);
    }

    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    return {
        calcTravelSeconds, formatTime, systemDistance, speedModifier, isochroneRadius,
        constants: {
            SAME_SYSTEM_MIN, SAME_SYSTEM_PLANET,
            DEEP_SPACE_MIN, DEEP_SPACE_DIST, DEEP_SPACE_PLANET,
            ENERGY_BASE, SPEED_STEP, ALLIANCE_FACTOR
        }
    };
});
