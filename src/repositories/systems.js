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
    INSERT INTO systems (id, name, x, y, full_name, info, population_level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        x=excluded.x,
        y=excluded.y,
        full_name=COALESCE(excluded.full_name, systems.full_name),
        info=COALESCE(excluded.info, systems.info),
        population_level=COALESCE(excluded.population_level, systems.population_level),
        updated_at=CURRENT_TIMESTAMP
`);
function upsertSystemFull(id, name, x, y, fullName = null, info = null, populationLevel = null) {
    upsertSystemFullStmt.run(id, name, x, y, fullName, info, populationLevel);
}

const setSystemInVisionStmt = db.prepare(`UPDATE systems SET is_in_vision = ? WHERE id = ?`);
function setSystemInVision(id, isInVision) {
    return setSystemInVisionStmt.run(isInVision ? 1 : 0, id).changes;
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

// Every current Best Guarded entry that resolves to a known system location AND is
// "in the area": owned by a friendly tag, or within `radiusSystems` straight-line systems
// of one (2026-09-12 — "all top50 in the area", not just #1/top10: best_guarded already
// holds however many rows the page shows, this just filters by location, not rank).
const getBestGuardedResolvedStmt = db.prepare(`
    SELECT bg.game_planet_id, bg.cv, p.system_id, p.planet_index, s.name as system_name, s.x, s.y
    FROM best_guarded bg
    JOIN planets p ON p.game_planet_id = bg.game_planet_id
    JOIN systems s ON s.id = p.system_id
    WHERE s.x IS NOT NULL AND s.y IS NOT NULL
`);
const getSystemOwnerTagsStmt = db.prepare(`
    SELECT DISTINCT p.system_id, s.x, s.y, a.tag
    FROM planets p
    JOIN systems s ON s.id = p.system_id
    JOIN players u ON p.owner_id = u.id
    JOIN alliances a ON u.alliance_id = a.id
    WHERE s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getBestGuardedInArea(friendlyTagsUpper, radiusSystems) {
    const { systemDistance } = require('../../public/js/utils/vision-model.js');
    const friendlySystems = getSystemOwnerTagsStmt.all()
        .filter(r => r.tag && friendlyTagsUpper.has(String(r.tag).toUpperCase()));
    const friendlyIds = new Set(friendlySystems.map(s => s.system_id));
    return getBestGuardedResolvedStmt.all().filter(row => {
        if (friendlyIds.has(row.system_id)) return true;
        return friendlySystems.some(f => systemDistance(f.x, f.y, row.x, row.y) <= radiusSystems);
    });
}

const getBestGuardedAreaWatchStmt = db.prepare(`SELECT game_planet_id FROM best_guarded_area_watch`);
const clearBestGuardedAreaWatchStmt = db.prepare(`DELETE FROM best_guarded_area_watch`);
const insertBestGuardedAreaWatchStmt = db.prepare(`INSERT INTO best_guarded_area_watch (game_planet_id) VALUES (?)`);

// Diffs the current in-area Best Guarded ids against what was there last time, then
// replaces the watch table with the new set. Returns { entered, left } (arrays of
// game_planet_id) — entered is what's worth announcing; left is informational.
function diffAndReplaceBestGuardedAreaWatch(currentIds) {
    const previous = new Set(getBestGuardedAreaWatchStmt.all().map(r => r.game_planet_id));
    const current = new Set(currentIds);
    const entered = [...current].filter(id => !previous.has(id));
    const left = [...previous].filter(id => !current.has(id));
    const replace = db.transaction((ids) => {
        clearBestGuardedAreaWatchStmt.run();
        for (const id of ids) insertBestGuardedAreaWatchStmt.run(id);
    });
    replace(currentIds);
    return { entered, left };
}

const countSecuredSystemsStmt = db.prepare(`SELECT COUNT(*) as n FROM systems WHERE is_secured = 1`);
function countSecuredSystems() {
    return countSecuredSystemsStmt.get().n;
}

// --- best_planets_snapshot (Various Changes: Best Planets coverage) ---

const clearBestPlanetsSnapshotStmt = db.prepare(`DELETE FROM best_planets_snapshot`);
function clearBestPlanetsSnapshot() {
    clearBestPlanetsSnapshotStmt.run();
}

const insertBestPlanetsSnapshotStmt = db.prepare(`INSERT INTO best_planets_snapshot (game_planet_id, rank, updated_at) VALUES (?, ?, ?)`);
function insertBestPlanetsSnapshot(gamePlanetId, rank, updatedAt) {
    insertBestPlanetsSnapshotStmt.run(gamePlanetId, rank, updatedAt);
}

// How many of the CURRENT Best Planets snapshot's planets are friendly-owned right now —
// resolved via our own synced ownership (planets/players/alliances), not the ranking
// page's own owner text, so this always reflects the freshest data the hub has. Total is
// the snapshot's full size (the page's own cutoff, whatever that is — "all top50", not a
// number this code hardcodes). Arity varies per call, so prepared fresh each time (same
// reasoning as getSystemsByIds/getFriendlyRouteAirports).
function getBestPlanetsFriendlyCoverage(friendlyTagsUpper) {
    const tags = [...friendlyTagsUpper];
    const total = db.prepare(`SELECT COUNT(*) as n FROM best_planets_snapshot`).get().n;
    if (!tags.length) return { friendly: 0, total };
    const placeholders = tags.map(() => '?').join(',');
    const friendly = db.prepare(`
        SELECT COUNT(*) as n
        FROM best_planets_snapshot bp
        JOIN planets p ON p.game_planet_id = bp.game_planet_id
        JOIN players u ON p.owner_id = u.id
        JOIN alliances a ON u.alliance_id = a.id
        WHERE UPPER(a.tag) IN (${placeholders})
    `).get(...tags).n;
    return { friendly, total };
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

// A system is "fully friendly" once every REAL owner in it (own alliance or an admin-
// configured NAP/ally — see friendly-alliance-tags.js) is friendly, AND at least one
// planet is actually owned by someone — an untouched or all-Free system is not "ours",
// so it never counts as secured just for having no enemies in it either.
function isSystemFullyFriendly(sysId, friendlyTagsUpper) {
    const rows = getSystemPlanetsForBotStmt.all(sysId);
    const owned = rows.filter(p => p.owner_id != null);
    if (!owned.length) return false;
    return owned.every(p => p.ally_tag && friendlyTagsUpper.has(String(p.ally_tag).toUpperCase()));
}

const getSystemSecuredStmt = db.prepare(`SELECT is_secured FROM systems WHERE id = ?`);
const setSystemSecuredStmt = db.prepare(`UPDATE systems SET is_secured = ? WHERE id = ?`);

// Recomputes "secured" for a system and persists any change. Returns 'secured' only on
// the 0->1 transition (the moment worth celebrating — see discord_bot.js's
// announceSystemMilestones), 'lost' on a silent 1->0 (no announcement for that, so a
// system can be re-secured and celebrated again later), or null when nothing changed.
function checkAndUpdateSystemSecured(sysId, friendlyTagsUpper) {
    const row = getSystemSecuredStmt.get(sysId);
    const wasSecured = !!(row && row.is_secured);
    const isSecuredNow = isSystemFullyFriendly(sysId, friendlyTagsUpper);
    if (isSecuredNow === wasSecured) return null;
    setSystemSecuredStmt.run(isSecuredNow ? 1 : 0, sysId);
    return isSecuredNow ? 'secured' : 'lost';
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

// A member's own planets with the population the hub last saw (intel.js, /intel/me/planets,
// for the Science page's Social marker — issue #138). updated_at travels with each row
// because the population comes from whichever member last scanned that system, so the
// client has to say how old it is.
const getPlanetsByOwnerStmt = db.prepare(`
    SELECT p.system_id, p.planet_index, p.game_planet_id, p.name, p.population, p.updated_at,
           s.name AS system_name
    FROM planets p
    LEFT JOIN systems s ON p.system_id = s.id
    WHERE p.owner_id = ?
    ORDER BY p.system_id ASC, p.planet_index ASC
`);
function getPlanetsByOwner(playerId) {
    return getPlanetsByOwnerStmt.all(playerId);
}

// starbase/has_fleet/is_sieged are selected because the fog-of-war guard in sync.js
// restores them: reading them off a row that never carried them bound `undefined`
// (-> NULL) and quietly erased the very values the guard exists to preserve.
const getOldPlanetStmt = db.prepare(`SELECT owner_id, population, starbase, has_fleet, is_sieged, updated_at FROM planets WHERE system_id = ? AND planet_index = ?`);
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

// Batched owner-alliance-tag lookup for a set of (system_id, planet_index) locations — used
// by routes.js's buildLegs to auto-detect which route legs land on an own/allied planet,
// without an N+1 query per leg. Arity varies per call (locations.length), so this is
// prepared fresh each time, same reasoning as getSystemsByIds. SQLite's row-value IN
// (VALUES (?,?), ...) form does the composite-key match in one query.
function getPlanetOwnersByLocations(locations) {
    if (!locations.length) return new Map();
    const placeholders = locations.map(() => '(?,?)').join(',');
    const params = locations.flatMap(l => [l.systemId, l.planetIndex]);
    const rows = db.prepare(`
        SELECT pn.system_id, pn.planet_index, a.tag AS alliance_tag
        FROM planets pn
        JOIN players pl ON pn.owner_id = pl.id
        LEFT JOIN alliances a ON pl.alliance_id = a.id
        WHERE (pn.system_id, pn.planet_index) IN (VALUES ${placeholders})
    `).all(...params);
    const map = new Map();
    for (const r of rows) map.set(`${r.system_id}:${r.planet_index}`, r.alliance_tag || null);
    return map;
}

// Route jump-point evidence is separate from the destination's travel-time modifier.
// Keep NULL starbases unknown; COALESCE here would recommend an unobserved airport.
// Lists may contain many saved routes, so chunk locations rather than querying per leg.
function getRoutePlanetIntelByLocations(locations) {
    const unique = [...new Map(locations.map(l => [`${l.systemId}:${l.planetIndex}`, l])).values()];
    const result = new Map();
    for (let start = 0; start < unique.length; start += 500) {
        const chunk = unique.slice(start, start + 500);
        const placeholders = chunk.map(() => '(?,?)').join(',');
        const rows = db.prepare(`
            SELECT p.system_id, p.planet_index, p.owner_id, p.starbase, p.is_sieged, p.updated_at,
                   u.name AS owner_name, a.tag AS alliance_tag, s.is_in_vision
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            LEFT JOIN systems s ON p.system_id = s.id
            WHERE (p.system_id, p.planet_index) IN (VALUES ${placeholders})
        `).all(...chunk.flatMap(l => [l.systemId, l.planetIndex]));
        for (const row of rows) result.set(`${row.system_id}:${row.planet_index}`, row);
    }
    return result;
}

function getFriendlyRouteAirports(tags) {
    if (!tags.length) return [];
    const placeholders = tags.map(() => '?').join(',');
    return db.prepare(`
        SELECT p.system_id, p.planet_index, p.owner_id, p.starbase, p.is_sieged, p.updated_at,
               u.name AS owner_name, a.tag AS alliance_tag,
               s.name AS system_name, s.x, s.y, s.is_in_vision
        FROM planets p
        JOIN systems s ON p.system_id = s.id
        JOIN players u ON p.owner_id = u.id
        JOIN alliances a ON u.alliance_id = a.id
        WHERE UPPER(a.tag) IN (${placeholders}) AND p.starbase = 0
          AND (p.is_sieged IS NULL OR p.is_sieged != 1)
          AND p.planet_index BETWEEN 1 AND 12
          AND s.x IS NOT NULL AND s.y IS NOT NULL
        ORDER BY p.system_id, p.planet_index
    `).all(...tags);
}

// Display-name lookups for battleReports.getLastSeenPlanet's two different location
// shapes: (system_id, planet_index) from a scraped battle report page, or a bare
// game_planet_id from a News-page bombardment row. Either can miss (the planet may never
// have been scanned into this table) — callers fall back to raw ids in that case.
const getPlanetNameByLocationStmt = db.prepare(`SELECT name FROM planets WHERE system_id = ? AND planet_index = ?`);
function getPlanetNameByLocation(systemId, planetIndex) {
    const row = getPlanetNameByLocationStmt.get(systemId, planetIndex);
    return row ? row.name : null;
}

const getPlanetNameByGameIdStmt = db.prepare(`SELECT name FROM planets WHERE game_planet_id = ?`);
function getPlanetNameByGameId(gamePlanetId) {
    const row = getPlanetNameByGameIdStmt.get(gamePlanetId);
    return row ? row.name : null;
}

// A news_events row only has game_planet_id, not planet_index — this resolves the rest
// of the planet's identity (system_id, planet_index, name) via the planets table's own
// game_planet_id UNIQUE key, for display purposes (e.g. !lastseen's "[272] Pherkad Minor
// #5" formatting). Returns null when the planet has never been scanned into this table.
const getPlanetLocationByGameIdStmt = db.prepare(`SELECT system_id, planet_index, name FROM planets WHERE game_planet_id = ?`);
function getPlanetLocationByGameId(gamePlanetId) {
    return getPlanetLocationByGameIdStmt.get(gamePlanetId) || null;
}

const upsertPlanetStmt = db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet, is_sieged, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        game_planet_id=excluded.game_planet_id,
        owner_id=excluded.owner_id,
        population=excluded.population,
        starbase=excluded.starbase,
        has_fleet=excluded.has_fleet,
        is_sieged=excluded.is_sieged,
        name=COALESCE(excluded.name, planets.name),
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet, isSieged, name = null) {
    upsertPlanetStmt.run(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet, isSieged, name);
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

// Latest logged population drop (event_type_id=2) for a planet at or before a given moment
// — used by /sync/news to credit a 'battle-conquer' entry with the population it actually
// destroyed, since the conquest itself carries no population number (see sync.js's POP DROP
// comment). `beforeIso` is compared via SQLite's own datetime() rather than string equality,
// since planet_events.timestamp is space-separated SQLite UTC while callers pass an ISO8601
// "...T...Z" string — the two don't compare correctly as raw strings (see the codebase-wide
// SQLite-UTC-vs-ISO8601 rule).
const getRecentPopDropStmt = db.prepare(`
    SELECT old_value, new_value, timestamp
    FROM planet_events
    WHERE system_id = ? AND planet_index = ? AND event_type_id = 2
      AND timestamp <= datetime(?)
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
`);
function getRecentPopDrop(systemId, planetIndex, beforeIso) {
    return getRecentPopDropStmt.get(systemId, planetIndex, beforeIso) || null;
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

// Round-scoped. planet_takeovers is keyed by (system_id, planet_index) with NO foreign key
// to systems, so a round reset that only deletes systems leaves last round's assignments
// behind — and the next scan reuses the same ids, so they reattach to the new map as if
// someone had just assigned them (issue #128). Called by the reset in src/routes/admin.js.
const deleteAllTakeoversStmt = db.prepare(`DELETE FROM planet_takeovers`);
function deleteAllTakeovers() {
    return deleteAllTakeoversStmt.run().changes;
}

module.exports = {
    countSystems, countPlanets, getSystemCoords, getFullSystem, listSystemIds, getSystemsByIds,
    listSystemsWithCoordsLimited, searchSystemsByQueryPrefix, searchSystemsByNameOrId,
    getSystemsDbSummary, getGalaxyMapSystems, getGalaxyMapOwnership, upsertSystemStub,
    upsertSystemFull, setSystemInVision, deleteAllSystems, countBestGuardedAt, clearBestGuarded, insertBestGuarded,
    getSystemPlanetsWithIntel, getSystemPlanetsForBot, getPlanetsFullDb, checkAndUpdateSystemSecured,
    getBestGuardedInArea, diffAndReplaceBestGuardedAreaWatch,
    clearBestPlanetsSnapshot, insertBestPlanetsSnapshot, getBestPlanetsFriendlyCoverage, countSecuredSystems,
    getDistinctSystemsForPlayer, getPlanetCoordsForPlayer, getPlanetsByOwner, getOldPlanet, upsertPlanet,
    getPlanetsForAllianceTag, getPlanetOwnerName, getPlanetOwnersByLocations, getRoutePlanetIntelByLocations,
    getFriendlyRouteAirports, getPlanetNameByLocation, getPlanetNameByGameId, getPlanetLocationByGameId,
    clearMovedPlanet, deleteAllPlanets, logPlanetEvent, getPlanetHistory, getRecentPopDrop, deleteAllPlanetEvents,
    getTakeoverBoard, upsertTakeover, deleteAllTakeovers,
};
