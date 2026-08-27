const db = require('../database');

// --- systems ---

const countSystemsStmt = db.prepare(`SELECT COUNT(*) as count FROM systems`);
function countSystems() {
    return countSystemsStmt.get().count;
}

const countPlanetsStmt = db.prepare(`SELECT COUNT(*) as count FROM planets`);
function countPlanets() {
    return countPlanetsStmt.get().count;
}

// Consolidates 8 near-identical lookups (discord_bot.js x6, sync.js announce x1,
// interceptors.js x1) into one shape: id, name, x, y. See Global Constraints.
const getSystemCoordsStmt = db.prepare(`SELECT id, name, x, y FROM systems WHERE id = ?`);
function getSystemCoords(id) {
    return getSystemCoordsStmt.get(id);
}

const getFullSystemStmt = db.prepare(`SELECT * FROM systems WHERE id = ?`);
function getFullSystem(id) {
    return getFullSystemStmt.get(id);
}

const listSystemIdsStmt = db.prepare(`SELECT id FROM systems ORDER BY id ASC`);
function listSystemIds() {
    return listSystemIdsStmt.all();
}

// Arity varies per call, so this statement is prepared fresh each call (matches the
// original behavior in routes/routes.js) rather than cached at module load.
// Minor addition: the empty-array early return below wasn't in the original inline
// query in routes/routes.js. It's harmless (the only caller already guards against
// empty arrays) but is a deliberate defensive addition, not a preserved behavior.
function getSystemsByIds(ids) {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id, name, x, y FROM systems WHERE id IN (${marks})`).all(...ids);
}

const listSystemsWithCoordsLimitedStmt = db.prepare(
    `SELECT id, name, x, y FROM systems WHERE x IS NOT NULL ORDER BY id LIMIT ?`
);
function listSystemsWithCoordsLimited(limit) {
    return listSystemsWithCoordsLimitedStmt.all(limit);
}

const searchSystemsByQueryPrefixStmt = db.prepare(`
    SELECT id, name, x, y FROM systems
    WHERE name LIKE ? OR CAST(id AS TEXT) LIKE ?
    ORDER BY LENGTH(COALESCE(name, '')) ASC LIMIT ?
`);
function searchSystemsByQueryPrefix(likeTerm, prefixTerm, limit) {
    return searchSystemsByQueryPrefixStmt.all(likeTerm, prefixTerm, limit);
}

const searchSystemsByNameOrIdStmt = db.prepare(`
    SELECT id, name, x, y
    FROM systems
    WHERE name LIKE ? OR CAST(id AS TEXT) = ?
    LIMIT 20
`);
function searchSystemsByNameOrId(likeTerm, exactTerm) {
    return searchSystemsByNameOrIdStmt.all(likeTerm, exactTerm);
}

const getSystemsDbSummaryStmt = db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM planets WHERE system_id = s.id) as planet_count,
           (SELECT COUNT(*) FROM fleets WHERE system_id = s.id) as fleet_count
    FROM systems s
`);
function getSystemsDbSummary() {
    return getSystemsDbSummaryStmt.all();
}

const getGalaxyMapSystemsStmt = db.prepare(`
    SELECT s.id, s.name, s.x, s.y, s.updated_at
    FROM systems s
    WHERE s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getGalaxyMapSystems() {
    return getGalaxyMapSystemsStmt.all();
}

const getGalaxyMapOwnershipStmt = db.prepare(`
    SELECT p.system_id,
           a.id  AS alliance_id,
           a.tag AS alliance_tag,
           COUNT(*) AS planets,
           SUM(CASE WHEN p.owner_id IS NULL OR p.owner_id = 0 THEN 1 ELSE 0 END) AS free_planets,
           SUM(CASE WHEN p.is_sieged = 1 THEN 1 ELSE 0 END) AS sieged_planets,
           MAX(p.updated_at) AS last_seen
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    GROUP BY p.system_id, a.id
`);
function getGalaxyMapOwnership() {
    return getGalaxyMapOwnershipStmt.all();
}

const upsertSystemStubStmt = db.prepare(`INSERT INTO systems (id) VALUES (?) ON CONFLICT(id) DO NOTHING`);
function upsertSystemStub(id) {
    upsertSystemStubStmt.run(id);
}

const upsertSystemFullStmt = db.prepare(`
    INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        x=excluded.x,
        y=excluded.y,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertSystemFull(id, name, x, y) {
    upsertSystemFullStmt.run(id, name, x, y);
}

const deleteAllSystemsStmt = db.prepare(`DELETE FROM systems`);
function deleteAllSystems() {
    deleteAllSystemsStmt.run();
}

// --- best_guarded ---

const countBestGuardedAtStmt = db.prepare(`SELECT COUNT(*) as count FROM best_guarded WHERE updated_at = ?`);
function countBestGuardedAt(lastUpdate) {
    return countBestGuardedAtStmt.get(lastUpdate).count;
}

const clearBestGuardedStmt = db.prepare(`DELETE FROM best_guarded`);
function clearBestGuarded() {
    clearBestGuardedStmt.run();
}

const insertBestGuardedStmt = db.prepare(`
    INSERT INTO best_guarded (game_planet_id, cv, updated_at)
    VALUES (?, ?, ?)
`);
function insertBestGuarded(planetId, cv, updatedAt) {
    insertBestGuardedStmt.run(planetId, cv, updatedAt);
}

// --- planets ---

const getSystemPlanetsWithIntelStmt = db.prepare(`
    SELECT p.planet_index, p.population, p.starbase, p.has_fleet, p.is_sieged, p.game_planet_id,
           u.name as owner_name, u.home_system_id, u.home_planet_index, u.possible_homes,
           a.tag as alliance_tag,
           bg.cv as guard_cv
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    LEFT JOIN best_guarded bg ON p.game_planet_id = bg.game_planet_id
    WHERE p.system_id = ?
    ORDER BY p.planet_index ASC
`);
function getSystemPlanetsWithIntel(sysId) {
    return getSystemPlanetsWithIntelStmt.all(sysId);
}

const getSystemPlanetsForBotStmt = db.prepare(`
    SELECT p.*, u.name as owner_name, a.tag as ally_tag
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE p.system_id = ? ORDER BY p.planet_index ASC
`);
function getSystemPlanetsForBot(sysId) {
    return getSystemPlanetsForBotStmt.all(sysId);
}

const getPlanetsFullDbStmt = db.prepare(`
    SELECT p.system_id, p.planet_index, p.population, p.starbase, p.is_sieged, p.updated_at,
           s.name as system_name, s.x, s.y,
           u.name as owner_name, a.tag as alliance_tag
    FROM planets p
    LEFT JOIN systems s ON p.system_id = s.id
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
`);
function getPlanetsFullDb() {
    return getPlanetsFullDbStmt.all();
}

const getDistinctSystemsForPlayerStmt = db.prepare(`
    SELECT DISTINCT s.id, s.name, s.x, s.y
    FROM planets p
    JOIN systems s ON p.system_id = s.id
    WHERE p.owner_id = ?
`);
function getDistinctSystemsForPlayer(playerId) {
    return getDistinctSystemsForPlayerStmt.all(playerId);
}

const getPlanetCoordsForPlayerStmt = db.prepare(`
    SELECT p.planet_index, s.x, s.y
    FROM planets p
    JOIN systems s ON p.system_id = s.id
    WHERE p.owner_id = ?
`);
function getPlanetCoordsForPlayer(playerId) {
    return getPlanetCoordsForPlayerStmt.all(playerId);
}

const getOldPlanetStmt = db.prepare(`SELECT owner_id, population FROM planets WHERE system_id = ? AND planet_index = ?`);
function getOldPlanet(systemId, planetIndex) {
    return getOldPlanetStmt.get(systemId, planetIndex);
}

const getPlanetsForAllianceTagStmt = db.prepare(`
    SELECT p.system_id, s.name as sys_name, p.planet_index, u.name as owner_name, a.tag as owner_alliance_tag
    FROM planets p
    JOIN systems s ON p.system_id = s.id
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE p.system_id IN (
        SELECT DISTINCT p2.system_id
        FROM planets p2
        JOIN players u2 ON p2.owner_id = u2.id
        JOIN alliances a2 ON u2.alliance_id = a2.id
        WHERE a2.tag = ?
    )
`);
function getPlanetsForAllianceTag(tag) {
    return getPlanetsForAllianceTagStmt.all(tag);
}

const getPlanetOwnerNameStmt = db.prepare(`
    SELECT pl.name FROM planets pn
    JOIN players pl ON pn.owner_id = pl.id
    WHERE pn.system_id = ? AND pn.planet_index = ?
`);
function getPlanetOwnerName(systemId, planetIndex) {
    return getPlanetOwnerNameStmt.get(systemId, planetIndex);
}

const upsertPlanetStmt = db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        game_planet_id=excluded.game_planet_id,
        owner_id=excluded.owner_id,
        population=excluded.population,
        starbase=excluded.starbase,
        has_fleet=excluded.has_fleet,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet) {
    upsertPlanetStmt.run(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet);
}

// A planet's game_planet_id is globally UNIQUE, but it can show up at a new
// (system_id, planet_index) slot when a planet is re-slotted/relocated. The upsert
// above only resolves the (system_id, planet_index) conflict, so without this the
// INSERT path would trip the game_planet_id UNIQUE constraint and abort the whole
// system's transaction (losing all of that system's updates). Clear the stale row
// at the old location first.
const clearMovedPlanetStmt = db.prepare(`
    DELETE FROM planets WHERE game_planet_id = ? AND (system_id != ? OR planet_index != ?)
`);
function clearMovedPlanet(gamePlanetId, systemId, planetIndex) {
    clearMovedPlanetStmt.run(gamePlanetId, systemId, planetIndex);
}

const deleteAllPlanetsStmt = db.prepare(`DELETE FROM planets`);
function deleteAllPlanets() {
    deleteAllPlanetsStmt.run();
}

// --- planet_events ---

const logPlanetEventStmt = db.prepare(`
    INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
`);
function logPlanetEvent(systemId, planetIndex, eventTypeId, oldValue, newValue) {
    logPlanetEventStmt.run(systemId, planetIndex, eventTypeId, oldValue, newValue);
}

const getPlanetHistoryStmt = db.prepare(`
    SELECT e.id, e.planet_index, e.event_type_id, e.timestamp, e.old_value, e.new_value,
           o1.name as old_owner, o2.name as new_owner
    FROM planet_events e
    LEFT JOIN players o1 ON e.old_value = o1.id AND e.event_type_id = 1
    LEFT JOIN players o2 ON e.new_value = o2.id AND e.event_type_id = 1
    WHERE e.system_id = ?
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT 10
`);
function getPlanetHistory(sysId) {
    return getPlanetHistoryStmt.all(sysId);
}

const deleteAllPlanetEventsStmt = db.prepare(`DELETE FROM planet_events`);
function deleteAllPlanetEvents() {
    deleteAllPlanetEventsStmt.run();
}

// --- planet_takeovers ---

const getTakeoverBoardStmt = db.prepare(`
    SELECT p.planet_index, p.population, p.starbase, p.has_fleet,
           u.name as owner_name, a.tag as alliance_tag,
           t.assigned_name, t.pipeline_status, t.target_arrival_time,
           runner.energy as runner_energy, runner.race_speed as runner_speed,
           sys_target.x as target_x, sys_target.y as target_y,
           sys_origin.x as origin_x, sys_origin.y as origin_y
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    LEFT JOIN planet_takeovers t ON p.system_id = t.system_id AND p.planet_index = t.planet_index
    LEFT JOIN players runner ON LOWER(t.assigned_name) = LOWER(runner.name)
    LEFT JOIN systems sys_target ON p.system_id = sys_target.id
    LEFT JOIN systems sys_origin ON runner.origin_system = sys_origin.id
    WHERE p.system_id = ?
    ORDER BY p.planet_index ASC
`);
function getTakeoverBoard(sysId) {
    return getTakeoverBoardStmt.all(sysId);
}

const upsertTakeoverStmt = db.prepare(`
    INSERT INTO planet_takeovers (system_id, planet_index, assigned_name, pipeline_status, target_arrival_time, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        assigned_name = CASE WHEN excluded.assigned_name = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.assigned_name, assigned_name) END,
        pipeline_status = COALESCE(excluded.pipeline_status, pipeline_status),
        target_arrival_time = CASE WHEN excluded.target_arrival_time = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.target_arrival_time, target_arrival_time) END,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertTakeover(systemId, planetIndex, assignedName, pipelineStatus, targetArrivalTime) {
    upsertTakeoverStmt.run(systemId, planetIndex, assignedName, pipelineStatus, targetArrivalTime);
}

module.exports = {
    countSystems, countPlanets, getSystemCoords, getFullSystem, listSystemIds, getSystemsByIds,
    listSystemsWithCoordsLimited, searchSystemsByQueryPrefix, searchSystemsByNameOrId,
    getSystemsDbSummary, getGalaxyMapSystems, getGalaxyMapOwnership, upsertSystemStub,
    upsertSystemFull, deleteAllSystems, countBestGuardedAt, clearBestGuarded, insertBestGuarded,
    getSystemPlanetsWithIntel, getSystemPlanetsForBot, getPlanetsFullDb,
    getDistinctSystemsForPlayer, getPlanetCoordsForPlayer, getOldPlanet, upsertPlanet,
    getPlanetsForAllianceTag, getPlanetOwnerName,
    clearMovedPlanet, deleteAllPlanets, logPlanetEvent, getPlanetHistory, deleteAllPlanetEvents,
    getTakeoverBoard, upsertTakeover,
};
