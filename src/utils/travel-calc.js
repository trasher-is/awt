function calcTravelSeconds(startX, startY, endX, endY, energy, raceSpeed, isAlliance) {
    const eng = parseInt(energy) || 0;
    const spd = parseInt(raceSpeed) || 0;
    const energyMod = Math.pow(0.91, eng);
    const speedMod = 1.0 - (spd * 0.11);
    const totalMod = energyMod * speedMod;

    let travelTime = 0;

    if (startX === endX && startY === endY) {
        travelTime = Math.floor((14400 * totalMod) + 1200); 
    } else {
        const dx = endX - startX;
        const dy = endY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        travelTime = Math.floor((dist * 36000 * totalMod) + 2700); 
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