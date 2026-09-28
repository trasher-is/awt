const db = require('../database');
const { summarizeLeaders } = require('../utils/unicorn-ranking');

// Best Planets is already captured by the browser's hourly ranking watch. This read
// adds only locations we can identify unambiguously; a missing location must not erase
// a real ranking entry or turn one planet into two map markers. Current databases have
// a UNIQUE game_planet_id, but do not guess if an older/imported database does not.
const bestPlanetsStmt = db.prepare(`
    SELECT bp.game_planet_id, bp.rank, bp.hf, bp.rf, bp.gc, bp.rl,
           s.id AS system_id,
           CASE WHEN s.id IS NOT NULL THEN p.planet_index ELSE NULL END AS planet_index,
           s.name AS system_name,
           MAX(bp.updated_at) OVER () AS synced_at
    FROM best_planets_snapshot bp
    LEFT JOIN (
        SELECT game_planet_id, MIN(system_id) AS system_id, MIN(planet_index) AS planet_index
        FROM planets
        GROUP BY game_planet_id
        HAVING COUNT(*) = 1
    ) p ON p.game_planet_id = bp.game_planet_id
        AND typeof(p.system_id) = 'integer' AND p.system_id > 0
        AND typeof(p.planet_index) = 'integer' AND p.planet_index BETWEEN 1 AND 99
    LEFT JOIN systems s ON s.id = p.system_id
    WHERE typeof(bp.rank) = 'integer' AND bp.rank BETWEEN 1 AND 50
      AND typeof(bp.game_planet_id) = 'integer' AND bp.game_planet_id > 0
    ORDER BY bp.rank, bp.game_planet_id
`);

function getUnicornIntel() {
    const ranked = bestPlanetsStmt.all();
    return {
        // The watch records when it synced, not when the game's daily ranking changed.
        synced_at: ranked.length ? ranked[0].synced_at : null,
        total: ranked.length,
        mapped: ranked.filter(row => row.system_id !== null).length,
        rows: ranked.map(({ synced_at, hf, rf, gc, rl, ...row }) => row),
        // Only direct planet-level values from the same complete ranking count. A
        // player's max_* history has no planet IDs and cannot identify these winners.
        ...summarizeLeaders(ranked),
    };
}

module.exports = { getUnicornIntel };
