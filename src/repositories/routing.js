const db = require('../database');

const purgeExpiredRoutesStmt = db.prepare(`DELETE FROM routes WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`);
function purgeExpiredRoutes() {
    return purgeExpiredRoutesStmt.run().changes;
}

function getRouteLegsForRouteIds(ids) {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`
        SELECT rl.*, sf.name AS from_system_name, sf.x AS from_x, sf.y AS from_y,
               st.name AS to_system_name,   st.x AS to_x,   st.y AS to_y
        FROM route_legs rl
        LEFT JOIN systems sf ON sf.id = rl.from_system_id
        LEFT JOIN systems st ON st.id = rl.to_system_id
        WHERE rl.route_id IN (${marks})
        ORDER BY rl.route_id, rl.leg_index
    `).all(...ids);
}

const getRoutesForUserStmt = db.prepare(`
    SELECT r.*, u.game_name AS author_name
    FROM routes r
    LEFT JOIN app_users u ON u.id = r.author_id
    WHERE r.visibility = 'alliance' OR r.author_id = ?
    ORDER BY COALESCE(r.planned_start_at, r.created_at) ASC
`);
function getRoutesForUser(userId) {
    return getRoutesForUserStmt.all(userId);
}

const getRouteByIdStmt = db.prepare(`
    SELECT r.*, u.game_name AS author_name
    FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
    WHERE r.id = ?
`);
function getRouteById(id) {
    return getRouteByIdStmt.get(id);
}

const getRouteOwnershipStmt = db.prepare(`SELECT id, author_id FROM routes WHERE id = ?`);
function getRouteOwnership(id) {
    return getRouteOwnershipStmt.get(id);
}

const updateRouteStmt = db.prepare(`
    UPDATE routes SET title=?, note=?, planned_start_at=?, energy=?, race_speed=?,
                      is_alliance_move=?, biology=?, visibility=?, expires_at=?,
                      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
`);
function updateRoute(id, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt) {
    updateRouteStmt.run(title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, id);
}

const insertRouteStmt = db.prepare(`
    INSERT INTO routes (author_id, title, note, planned_start_at, energy, race_speed,
                        is_alliance_move, biology, visibility, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function insertRoute(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt) {
    return insertRouteStmt.run(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt).lastInsertRowid;
}

const deleteRouteLegsForRouteStmt = db.prepare(`DELETE FROM route_legs WHERE route_id = ?`);
function deleteRouteLegsForRoute(routeId) {
    deleteRouteLegsForRouteStmt.run(routeId);
}

const insertRouteLegStmt = db.prepare(`
    INSERT INTO route_legs (route_id, leg_index, from_system_id, from_planet_index,
                            to_system_id, to_planet_index, travel_seconds, distance, bio_needed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function insertRouteLeg(routeId, legIndex, fromSystemId, fromPlanetIndex, toSystemId, toPlanetIndex, travelSeconds, distance, bioNeeded) {
    insertRouteLegStmt.run(routeId, legIndex, fromSystemId, fromPlanetIndex, toSystemId, toPlanetIndex, travelSeconds, distance, bioNeeded);
}

const deleteRouteStmt = db.prepare(`DELETE FROM routes WHERE id = ?`);
function deleteRoute(id) {
    deleteRouteStmt.run(id);
}

module.exports = {
    purgeExpiredRoutes, getRouteLegsForRouteIds, getRoutesForUser, getRouteById,
    getRouteOwnership, updateRoute, insertRoute, deleteRouteLegsForRoute, insertRouteLeg,
    deleteRoute
};
