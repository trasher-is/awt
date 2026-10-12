const { validatePlanetStatisticsAvailability } = require('../../public/js/utils/aw-api');

// Called inside the system sync transaction AFTER its observation-order guard.
// Stats availability says nothing about current ownership, visibility or fleet presence.
function storePlanetStatistics(db, systemId, planet, observedAt) {
    const previous = db.prepare(`SELECT game_planet_id FROM planets WHERE system_id=? AND planet_index=?`)
        .get(systemId, planet.planet_index);
    const replaced = previous?.game_planet_id != null && planet.game_planet_id != null
        && previous.game_planet_id !== planet.game_planet_id;
    const present = Object.prototype.hasOwnProperty.call(planet, 'api_statistics');
    const flags = present ? validatePlanetStatisticsAvailability(planet.api_statistics) : undefined;
    // Return the intended write for execution after the normal planet upsert.
    if (flags === undefined) return replaced ? { json: null, observedAt: null } : null;
    return { json: JSON.stringify(flags), observedAt: observedAt || null };
}

function applyStatisticsWrite(db, systemId, planetIndex, write) {
    if (!write) return;
    db.prepare(`UPDATE planets SET api_statistics=?,api_statistics_observed_at=?
        WHERE system_id=? AND planet_index=?`).run(write.json, write.observedAt, systemId, planetIndex);
}

module.exports = { storePlanetStatistics, applyStatisticsWrite };
