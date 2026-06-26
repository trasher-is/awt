// Fleet travel-time formula — EXACT (verified to 0s against all in-game data;
// see travel-calc.test.js).
//
// Shared modifier on the reducible (distance-dependent) part of both flight types:
//   mod = 0.91^energy / (1 + 0.11·speed)
//     • Energy: each level = 91% of previous (game's Energy table).
//     • Speed: race attribute raises velocity ±11%/level, so it DIVIDES time
//       (+4 → ÷1.44, −4 → ÷0.56).
//
// Each flight = a FIXED minimum (never reduced) + a reducible part scaled by mod:
//   same-system: 1200 + 14400·√(|Δplanet|+1) · mod          (20-min minimum)
//   deep-space:  2700 + (36000·dist + 3600·√(|Δplanet|+1)) · mod   (45-min minimum)
//     dist = Euclidean distance between system (x,y) coordinates.
//
// ALLIANCE / own-destination move: ×0.5 (always halved).
function calcTravelSeconds(startX, startY, startPlanet, endX, endY, endPlanet, energy, raceSpeed, isAlliance) {
    const eng = parseInt(energy) || 0;
    const spd = parseInt(raceSpeed) || 0;
    const mod = Math.pow(0.91, eng) / (1 + 0.11 * spd);
    const planetTerm = Math.sqrt(Math.abs(startPlanet - endPlanet) + 1);

    let travelTime;

    if (startX === endX && startY === endY) {
        // SAME SYSTEM
        travelTime = 1200 + 14400 * planetTerm * mod;
    } else {
        // DEEP SPACE
        const dx = endX - startX;
        const dy = endY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        travelTime = 2700 + (36000 * dist + 3600 * planetTerm) * mod;
    }

    travelTime = Math.floor(travelTime);
    return isAlliance ? Math.floor(travelTime * 0.5) : travelTime;
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

module.exports = {
    calcTravelSeconds,
    formatTime
};
