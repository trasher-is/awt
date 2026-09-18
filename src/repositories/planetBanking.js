const db = require('../database');
const AWTables = require('../../public/js/utils/game-tables.js');

// --- planet_banking: My Savings (2026-09-18) ---
// See database.js's comment for why `banking` survives every sync while every other
// column is wholesale-replaced.

const bankingFlagsForPlayerStmt = db.prepare(`SELECT game_planet_id, banking FROM planet_banking WHERE player_id = ?`);
const deleteForPlayerStmt = db.prepare(`DELETE FROM planet_banking WHERE player_id = ?`);
const insertStmt = db.prepare(`
    INSERT INTO planet_banking (game_planet_id, player_id, system_id, name, population, population_progress, growth_rate, production_pp, production_rate, banking, updated_at)
    VALUES (@game_planet_id, @player_id, @system_id, @name, @population, @population_progress, @growth_rate, @production_pp, @production_rate, @banking, CURRENT_TIMESTAMP)
`);

// `planets`: [{ game_planet_id, system_id, name, population, population_progress,
// growth_rate, production_pp, production_rate }]. Wholesale-replaces this player's rows (a
// lost/gifted/conquered planet must disappear, same reasoning as best_planets_snapshot),
// but every existing `banking` flag is read first and carried over by game_planet_id — a
// fresh sync must never silently reset a planet the player already marked as banking back
// to "still building".
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
                population_progress: p.population_progress ?? null,
                growth_rate: p.growth_rate ?? null,
                production_pp: p.production_pp ?? null,
                production_rate: p.production_rate ?? null,
                banking: existing.get(p.game_planet_id) ?? 0,
            });
        }
    });
    tx(planets);
}

const getPlayerPlanetsStmt = db.prepare(`
    SELECT game_planet_id, system_id, name, population, population_progress, growth_rate, production_pp, production_rate, banking, updated_at
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

// --- TR outlook (2026-09-18b): projected population-10 crossings, alliance-wide ---
// Each of a player's planets at population 10+ adds 1% trade revenue for whoever partners
// with them (docs/road-to-ta.md's own "1% per planet at population 10+" rule). This
// projects the next two crossings among their sub-10 planets from the same growth data My
// Savings already collects — current level, points already banked toward the next level,
// and points/hour — via game-tables.js's POP_GROWTH table, the same one Road to TA and
// build-order.js use, so this never carries a second copy of the game's own numbers.
const QUALIFYING_POPULATION = 10;

// Hours until `currentLevel` (with `progressPoints` already banked toward its next level)
// reaches `targetLevel` at a constant `growthRate` (points/hour). Null when that can't be
// computed — no observed growth rate is "unknown", not "never", so it must not silently
// sort as infinitely far away or, worse, as already there.
function hoursToPopulationLevel(currentLevel, progressPoints, growthRate, targetLevel) {
    if (!Number.isFinite(currentLevel) || currentLevel >= targetLevel) return 0;
    if (!(growthRate > 0)) return null;
    const totalNeeded = AWTables.aggregate(AWTables.POP_GROWTH, currentLevel, targetLevel);
    const remaining = Math.max(0, totalNeeded - (Number.isFinite(progressPoints) ? progressPoints : 0));
    return remaining / growthRate;
}

// Scoped to the current alliance roster the same way Board already is (everyone in
// alliance_member_stats) — this hub serves one alliance, so there is no separate id to
// filter on. Members who have never opened My Savings simply have no planet_banking rows
// and so no entry in the result; the caller treats a missing name as "no data" for them.
const trOutlookRowsStmt = db.prepare(`
    SELECT p.name, pb.population, pb.population_progress, pb.growth_rate
    FROM planet_banking pb
    JOIN players p ON p.id = pb.player_id
    JOIN alliance_member_stats ams ON ams.player_id = p.id
`);
function getAllianceTrOutlook() {
    const byName = new Map();
    for (const row of trOutlookRowsStmt.all()) {
        const key = row.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name: row.name, planets: [] });
        byName.get(key).planets.push(row);
    }
    const outlook = [];
    for (const { name, planets } of byName.values()) {
        const qualifiedNow = planets.filter(p => (p.population ?? 0) >= QUALIFYING_POPULATION).length;
        const projections = planets
            .filter(p => (p.population ?? 0) < QUALIFYING_POPULATION)
            .map(p => hoursToPopulationLevel(p.population, p.population_progress, p.growth_rate, QUALIFYING_POPULATION))
            .filter(hours => hours !== null)
            .sort((a, b) => a - b);
        outlook.push({ name, qualified_now: qualifiedNow, next_hours: projections[0] ?? null, next2_hours: projections[1] ?? null });
    }
    return outlook;
}

module.exports = { syncPlayerPlanets, getPlayerPlanets, setPlanetBanking, getAllianceTrOutlook };
