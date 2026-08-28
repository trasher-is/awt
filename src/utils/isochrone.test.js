// isochroneRadius is the analytic inverse of the deep-space travel formula, used by the
// galaxy map to draw "reachable within T" rings. Its contract, checked as a round-trip
// property over a grid of energy / race speed / alliance:
//
//   1. a point placed AT isochroneRadius(T) travels there in <= T seconds
//   2. a point slightly beyond that radius takes > T seconds
//   3. a budget below the (alliance-adjusted) deep-space minimum reaches nowhere: radius 0
//
// Run with:  node src/utils/isochrone.test.js
//
// Every constant comes from the model's own exports — formula constants live in
// public/js/utils/travel-model.js and nowhere else, this file included.

const path = require('path');

const model = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'travel-model.js'));
const { calcTravelSeconds, isochroneRadius, speedModifier } = model;
const { DEEP_SPACE_MIN, DEEP_SPACE_DIST, ALLIANCE_FACTOR } = model.constants;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

ok('isochroneRadius is exported by the shared model', typeof isochroneRadius === 'function');

// ─── THE ROUND TRIP ───────────────────────────────────────────────────────────
// Origin at (0,0), destination at (radius, 0), planet index 1 on both ends so the planet
// term is √(0+1) = 1 — the branch the inverse is defined for. Aggregated like the grid
// check in travel-calc.test.js: counts, not 200 printed lines.
console.log('── Round trip: radius -> travel time -> back under the budget ' + '─'.repeat(14));

const ENERGIES = [0, 5, 12, 27, 45];
const SPEEDS = [-4, -2, 0, 2, 4];
const HOURS = [1, 6, 12, 24, 48];

let checked = 0, within = 0, beyond = 0;
let firstWithinBad = null, firstBeyondBad = null;

for (const energy of ENERGIES) {
    for (const speed of SPEEDS) {
        for (const allied of [false, true]) {
            for (const h of HOURS) {
                const T = h * 3600;
                const r = isochroneRadius(T, energy, speed, allied);
                if (!(r > 0)) continue;   // budget too small for deep space at this mod
                checked++;

                const tAt = calcTravelSeconds(0, 0, 1, r, 0, 1, energy, speed, allied);
                if (tAt <= T) within++;
                else if (!firstWithinBad) firstWithinBad = { energy, speed, allied, T, r, tAt };

                // Enough extra distance to add 4 unmodified seconds: survives the final
                // floor, and the alliance ×0.5 (which needs at least +2), with margin
                // for float noise — while staying a sliver of a coordinate unit.
                const step = 4 / (DEEP_SPACE_DIST * speedModifier(energy, speed));
                const tBeyond = calcTravelSeconds(0, 0, 1, r + step, 0, 1, energy, speed, allied);
                if (tBeyond > T) beyond++;
                else if (!firstBeyondBad) firstBeyondBad = { energy, speed, allied, T, r, step, tBeyond };
            }
        }
    }
}

ok('the grid produced a meaningful number of in-range cases', checked >= 200, checked);
ok(`a point AT the radius arrives within its budget (${within}/${checked})`,
    within === checked, firstWithinBad);
ok(`a point slightly BEYOND the radius arrives late (${beyond}/${checked})`,
    beyond === checked, firstBeyondBad);

// ─── THE CLAMP ────────────────────────────────────────────────────────────────
// No budget below the fixed deep-space minimum reaches another system, so the radius is
// 0 — never negative. The minimum an ALLIED move must beat is the halved one: the ×0.5
// applies after the fixed part, so alliance budgets stretch twice as far.
console.log('\n── Budgets below the deep-space minimum draw no ring ' + '─'.repeat(23));

let clampChecked = 0, clampGood = 0;
let firstClampBad = null;
for (const energy of ENERGIES) {
    for (const speed of SPEEDS) {
        for (const allied of [false, true]) {
            const tMin = allied ? DEEP_SPACE_MIN * ALLIANCE_FACTOR : DEEP_SPACE_MIN;
            for (const T of [0, -60, tMin - 1, tMin]) {
                clampChecked++;
                const r = isochroneRadius(T, energy, speed, allied);
                if (r === 0) clampGood++;
                else if (!firstClampBad) firstClampBad = { energy, speed, allied, T, r };
            }
        }
    }
}
ok(`every too-small budget yields exactly 0 (${clampGood}/${clampChecked})`,
    clampGood === clampChecked, firstClampBad);

// ─── COERCION MATCHES THE FORWARD DIRECTION ───────────────────────────────────
// calcTravelSeconds parseInt-coerces energy and race speed; the inverse goes through the
// same speedModifier, so string levels cannot make the ring disagree with the times.
console.log('\n── Inputs are coerced the same way as calcTravelSeconds ' + '─'.repeat(20));
ok('string energy/speed levels behave like their integer values',
    isochroneRadius(43200, '12', '2', false) === isochroneRadius(43200, 12, 2, false));

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
