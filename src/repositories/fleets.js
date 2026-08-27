const db = require('../database');

const countFleetsStmt = db.prepare(`SELECT COUNT(*) as count FROM fleets`);
function countFleets() {
    return countFleetsStmt.get().count;
}

const getFleetsForSystemStmt = db.prepare(`
    SELECT f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships,
           u.name as owner_name, a.tag as alliance_tag
    FROM fleets f
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE f.system_id = ?
`);
function getFleetsForSystem(sysId) {
    return getFleetsForSystemStmt.all(sysId);
}

const getFleetsForSystemFullStmt = db.prepare(`
    SELECT f.*, u.name as owner_name, a.tag as ally_tag
    FROM fleets f
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE f.system_id = ?
`);
function getFleetsForSystemFull(sysId) {
    return getFleetsForSystemFullStmt.all(sysId);
}

const getFleetsFullDbStmt = db.prepare(`
    SELECT f.*,
           s.name as system_name, s.x, s.y,
           u.name as owner_name, a.tag as alliance_tag
    FROM fleets f
    LEFT JOIN systems s ON f.system_id = s.id
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
`);
function getFleetsFullDb() {
    return getFleetsFullDbStmt.all();
}

const getFleetsForTimelineStmt = db.prepare(`
    SELECT f.*,
           s.name as system_name, s.x, s.y,
           p.name as owner_name, a.tag as alliance_tag,
           pl.note as plan_note, u.game_name as plan_author
    FROM fleets f
    LEFT JOIN systems s ON f.system_id = s.id
    LEFT JOIN players p ON f.owner_id = p.id
    LEFT JOIN alliances a ON p.alliance_id = a.id
    LEFT JOIN planet_plans pl ON f.system_id = pl.system_id AND f.planet_index = pl.planet_index
    LEFT JOIN app_users u ON pl.author_id = u.id
    WHERE f.arrival_time IS NOT NULL AND f.arrival_time != '-'
    ORDER BY f.arrival_time ASC
`);
function getFleetsForTimeline() {
    return getFleetsForTimelineStmt.all();
}

const deleteFleetsOlderThan10DaysStmt = db.prepare(`DELETE FROM fleets WHERE updated_at <= datetime('now', '-10 days')`);
function deleteFleetsOlderThan10Days() {
    return deleteFleetsOlderThan10DaysStmt.run();
}

const deleteAllFleetsStmt = db.prepare(`DELETE FROM fleets`);
function deleteAllFleets() {
    deleteAllFleetsStmt.run();
}

const deleteFleetsByOwnerStmt = db.prepare(`DELETE FROM fleets WHERE owner_id = ?`);
function deleteFleetsByOwner(ownerId) {
    deleteFleetsByOwnerStmt.run(ownerId);
}

const insertFleetForAllianceStatsStmt = db.prepare(`
    INSERT INTO fleets (owner_id, system_id, planet_index, transports, colony_ships, destroyers, cruisers, battleships, arrival_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function insertFleetForAllianceStats(ownerId, systemId, planetIndex, transports, colonyShips, destroyers, cruisers, battleships, arrivalAt) {
    insertFleetForAllianceStatsStmt.run(ownerId, systemId, planetIndex, transports, colonyShips, destroyers, cruisers, battleships, arrivalAt);
}

const updateFleetGameIdStmt = db.prepare(`
    UPDATE fleets SET game_fleet_id = ?
    WHERE owner_id = ? AND system_id = ? AND planet_index = ?
`);
function updateFleetGameId(gameFleetId, ownerId, systemId, planetIndex) {
    return updateFleetGameIdStmt.run(gameFleetId, ownerId, systemId, planetIndex);
}

// Two fixed variants of interceptors.js's dynamic WHERE clause, so both stay
// module-level prepared statements instead of being rebuilt from a string per call.
const getInterceptFleetsByAllianceStmt = db.prepare(`
    SELECT f.system_id AS origin_sys, f.planet_index, f.game_fleet_id,
           f.destroyers, f.cruisers, f.battleships, f.arrival_at,
           p.id AS owner_id, p.name AS owner_name, p.energy, p.race_speed,
           s.x AS sx, s.y AS sy
    FROM fleets f
    JOIN players p ON f.owner_id = p.id
    JOIN systems s ON f.system_id = s.id
    WHERE p.alliance_id = @aid AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptFleetsByAlliance(allianceId) {
    return getInterceptFleetsByAllianceStmt.all({ aid: allianceId });
}

const getInterceptFleetsByActiveUsersStmt = db.prepare(`
    SELECT f.system_id AS origin_sys, f.planet_index, f.game_fleet_id,
           f.destroyers, f.cruisers, f.battleships, f.arrival_at,
           p.id AS owner_id, p.name AS owner_name, p.energy, p.race_speed,
           s.x AS sx, s.y AS sy
    FROM fleets f
    JOIN players p ON f.owner_id = p.id
    JOIN systems s ON f.system_id = s.id
    WHERE LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1) AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptFleetsByActiveUsers() {
    return getInterceptFleetsByActiveUsersStmt.all();
}

module.exports = {
    countFleets, getFleetsForSystem, getFleetsForSystemFull, getFleetsFullDb,
    getFleetsForTimeline, deleteFleetsOlderThan10Days, deleteAllFleets, deleteFleetsByOwner,
    insertFleetForAllianceStats, updateFleetGameId,
    getInterceptFleetsByAlliance, getInterceptFleetsByActiveUsers,
};
