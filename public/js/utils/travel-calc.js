function calcTravelSeconds(startX, startY, startPlanet, endX, endY, endPlanet, energy, raceSpeed, isAlliance) {
    const eng = parseInt(energy) || 0;
    const spd = parseInt(raceSpeed) || 0;
    const energyMod = Math.pow(0.91, eng);
    const speedMod = 1.0 - (spd * 0.11);
    const totalMod = energyMod * speedMod;

    let travelTime = 0;

    if (startX === endX && startY === endY) {
        // SAME SYSTEM TRAVEL
        const planetDiff = Math.abs(startPlanet - endPlanet);
        travelTime = Math.floor((14400 * Math.sqrt(planetDiff + 1) * totalMod) + 1200); 
    } else {
        // DEEP SPACE TRAVEL
        const dx = endX - startX;
        const dy = endY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Changed flat delay from 2700 to 6300 (1h 45m)
        travelTime = Math.floor((dist * 36000 * totalMod) + 6300); 
    }

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