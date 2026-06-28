// Server-side port of the (fleet-only) battle model from public/js/ui/battle-calc.js.
// Used to estimate each interceptor's chance of beating an incoming fleet. No starbase
// (space interception), so only ships + racial/science stats matter.

const SHIPS = [
    { att: 2, def: 1, cv: 3 },   // Destroyer
    { att: 8, def: 16, cv: 24 }, // Cruiser
    { att: 36, def: 24, cv: 60 } // Battleship
];
const TOUGH = i => SHIPS[i].att + 2 * SHIPS[i].def;
const RACE_DEF = 0.11;
const MATH_TOUGH = 0.0015;
const WIN_FORCE = 12.25;   // CV-ratio weight (12.25 + WIN_ATT 3.0 = old 15.25)
const WIN_ATT = 3.0;       // attack-power ratio weight (decides mixed-composition fights)
const WIN_RA = 0.50;
const WIN_LVL = 0.069;
const WIN_PHYS_LIN = 0.1034;
const WIN_PHYS_BRACKET = 1.475; // halved from 2.95 to match in-game +6-physics samples
const ANNIHILATE = 1.25;

const cvOf = f => f[0] * 3 + f[1] * 24 + f[2] * 60;
const attOf = f => f[0] * SHIPS[0].att + f[1] * SHIPS[1].att + f[2] * SHIPS[2].att;
const toughOf = f => f[0] * TOUGH(0) + f[1] * TOUGH(1) + f[2] * TOUGH(2);

// Resolve a player's combat stats with the agreed fallbacks:
//   • no intel on the race  -> assume race attack/defence +4, and physics = maths =
//     science_level (the public ceiling).
//   • race known but intel sciences are stale (>24h) -> keep the race, but use
//     science_level for physics & maths.
// Returns { ra, rd, phys, math, lvl, unknown }.
function resolveStats(p) {
    if (!p) return { ra: 4, rd: 4, phys: 0, math: 0, lvl: 0, unknown: true };
    const sci = p.science_level || 0;
    if (p.has_intel) {
        const ts = p.intel_updated_at ? Date.parse(p.intel_updated_at) : 0;
        const fresh = ts && (Date.now() - ts < 24 * 3600 * 1000);
        return {
            ra: p.race_attack || 0,
            rd: p.race_defense || 0,
            phys: fresh ? (p.physics || 0) : sci,
            math: fresh ? (p.mathematics || 0) : sci,
            lvl: p.level || 0,
            unknown: false
        };
    }
    return { ra: 4, rd: 4, phys: sci, math: sci, lvl: p.level || 0, unknown: true };
}

// Probability (0..1) that the ally fleet beats the enemy fleet. Fleets are [D, C, B].
function winChance(allyFleet, ally, enemyFleet, enemy) {
    // +6 math bracket grants +12.5% combat to that side.
    const cmD = 1 + 0.125 * ((ally.math - enemy.math) >= 6 ? 1 : 0);
    const cmA = 1 + 0.125 * ((enemy.math - ally.math) >= 6 ? 1 : 0);

    const dT = toughOf(allyFleet) * (1 + RACE_DEF * ally.rd) * (1 + MATH_TOUGH * ally.math) * cmD;
    const aT = toughOf(enemyFleet) * (1 + RACE_DEF * enemy.rd) * (1 + MATH_TOUGH * enemy.math) * cmA;
    if (dT <= 0 && aT <= 0) return 0.5;

    const rawAlly = dT > 0 ? (cvOf(enemyFleet) * cmA) / dT : 99;
    const rawEnemy = aT > 0 ? (cvOf(allyFleet) * cmD) / aT : 99;
    // A guaranteed win needs the loser annihilated AND the winner to meaningfully survive
    // (loses <90%). Otherwise a near-mutual wipe snaps to 0/1 and one ship flips the result;
    // those contested cases fall through to the stat/force logistic below.
    const SURVIVES = 0.9;
    const enemyGone = rawEnemy >= ANNIHILATE && rawAlly < SURVIVES;
    const allyGone = rawAlly >= ANNIHILATE && rawEnemy < SURVIVES;
    if (enemyGone && !allyGone) return 1;
    if (allyGone && !enemyGone) return 0;

    const cvD = cvOf(allyFleet), cvA = cvOf(enemyFleet);
    const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const dp = ally.phys - enemy.phys, adp = Math.abs(dp);
    let statS = WIN_RA * (ally.ra - enemy.ra) + sgn(dp) * (WIN_PHYS_LIN * adp + WIN_PHYS_BRACKET * Math.floor(adp / 6));
    const dFull = allyFleet.every(n => n > 0), aFull = enemyFleet.every(n => n > 0);
    if (dFull && aFull) statS += WIN_LVL * (ally.lvl - enemy.lvl);

    if (cvA >= 1.5 * cvD && statS <= 0) return 0;
    if (cvD >= 1.5 * cvA && statS >= 0) return 1;

    const attD = attOf(allyFleet), attA = attOf(enemyFleet);
    const denom = cvD + cvA, attDenom = attD + attA;
    const S = (denom > 0 ? WIN_FORCE * ((cvD - cvA) / denom) : 0)
            + (attDenom > 0 ? WIN_ATT * ((attD - attA) / attDenom) : 0)
            + statS;
    return 1 / (1 + Math.exp(-S));
}

module.exports = { winChance, resolveStats };
