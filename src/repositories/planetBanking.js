const db = require('../database');

// --- planet_banking: My Savings (2026-09-18) ---
// See database.js's comment for why `banking` survives every sync while every other
// column is wholesale-replaced.

const bankingFlagsForPlayerStmt = db.prepare(`SELECT game_planet_id, banking FROM planet_banking WHERE player_id = ?`);
const deleteForPlayerStmt = db.prepare(`DELETE FROM planet_banking WHERE player_id = ?`);
const insertStmt = db.prepare(`
    INSERT INTO planet_banking (game_planet_id, player_id, system_id, name, population, production_pp, production_rate, banking, updated_at)
    VALUES (@game_planet_id, @player_id, @system_id, @name, @population, @production_pp, @production_rate, @banking, CURRENT_TIMESTAMP)
`);

// `planets`: [{ game_planet_id, system_id, name, population, production_pp, production_rate }].
// Wholesale-replaces this player's rows (a lost/gifted/conquered planet must disappear,
// same reasoning as best_planets_snapshot), but every existing `banking` flag is read
// first and carried over by game_planet_id — a fresh sync must never silently reset a
// planet the player already marked as banking back to "still building".
function syncPlayerPlanets(playerId, planets) {
    const existing = new Map(bankingFlagsForPlayerStmt.all(playerId).map(row => [row.game_planet_id, row.banking]));
    const tx = db.transaction((rows) => {
        deleteForPlayerStmt.run(playerId);
        for (const p of rows) {
            insertStmt.run({
                game_planet_id: p.game_planet_id,
                player_id: playerId,
                system_id: p.system_id ?? null,
                name: p.name ?? null,
                population: p.population ?? null,
                production_pp: p.production_pp ?? null,
                production_rate: p.production_rate ?? null,
                banking: existing.get(p.game_planet_id) ?? 0,
            });
        }
    });
    tx(planets);
}

const getPlayerPlanetsStmt = db.prepare(`
    SELECT game_planet_id, system_id, name, population, production_pp, production_rate, banking, updated_at
    FROM planet_banking WHERE player_id = ? ORDER BY game_planet_id
`);
function getPlayerPlanets(playerId) {
    return getPlayerPlanetsStmt.all(playerId);
}

// Scoped by player_id as well as game_planet_id so a request can only ever toggle the
// requesting account's own planets, never another member's row with a guessed id.
const setBankingStmt = db.prepare(`UPDATE planet_banking SET banking = ? WHERE player_id = ? AND game_planet_id = ?`);
function setPlanetBanking(playerId, gamePlanetId, banking) {
    return setBankingStmt.run(banking ? 1 : 0, playerId, gamePlanetId).changes > 0;
}

module.exports = { syncPlayerPlanets, getPlayerPlanets, setPlanetBanking };
