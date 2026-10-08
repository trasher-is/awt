const db = require('../database');
const { cvOf } = require('../../public/js/utils/battle-model.js');
const { parseTimestamp } = require('../../public/js/utils/sqlite-time.js');

const countFleetsStmt = db.prepare(`SELECT COUNT(*) as count FROM fleets`);
function countFleets() {
    return countFleetsStmt.get().count;
}

const getFleetsForSystemStmt = db.prepare(`
    SELECT f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships,
           f.arrival_at, f.arrival_time,
           f.owner_id, u.name as owner_name, a.id as alliance_id, a.tag as alliance_tag
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
           u.name as owner_name, a.id as alliance_id, a.tag as alliance_tag,
           pl.game_planet_id
    FROM fleets f
    LEFT JOIN systems s ON f.system_id = s.id
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    LEFT JOIN planets pl ON pl.system_id = f.system_id AND pl.planet_index = f.planet_index
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

// Arity varies per call (tag count, usually 1) — prepared fresh each call, same reasoning
// as systems.js's getSystemsByIds.
function getMemberIdsForTags(tagsUpper) {
    const tags = [...new Set((tagsUpper || []).filter(Boolean))];
    if (!tags.length) return [];
    const placeholders = tags.map(() => '?').join(',');
    return db.prepare(`
        SELECT p.id FROM players p JOIN alliances a ON p.alliance_id = a.id
        WHERE UPPER(a.tag) IN (${placeholders})
    `).all(...tags).map(r => r.id);
}

// Enemy/unknown fleets seen on a live system-map DOM view (2026-09-14) — the only source
// of this intel there is. No alliance-page equivalent exists for anyone but our own
// members, who stay covered separately and more completely by the alliance-scan path (see
// insertFleetForAllianceStats's own comment on WHY that one exists) — this function is
// scoped to explicitly exclude ownMemberIds so it can never step on those authoritative
// rows. Replaces exactly "this system's non-own fleet rows" with exactly "what the DOM
// just showed": a fleet that moved on or landed and is no longer listed correctly
// disappears, the same way a planet's stale siege/ownership doesn't survive a fresh scan.
function replaceEnemyFleetsForSystem(systemId, enemyFleets, ownMemberIds) {
    const ownIds = [...new Set((ownMemberIds || []).filter(id => Number.isInteger(id)))];
    if (ownIds.length) {
        const placeholders = ownIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM fleets WHERE system_id = ? AND owner_id NOT IN (${placeholders})`).run(systemId, ...ownIds);
    } else {
        db.prepare(`DELETE FROM fleets WHERE system_id = ?`).run(systemId);
    }
    for (const f of enemyFleets) {
        insertFleetForAllianceStatsStmt.run(
            f.owner_id, systemId, f.planet_index,
            f.transports || 0, f.colony_ships || 0, f.destroyers || 0, f.cruisers || 0, f.battleships || 0,
            f.arrival_at || null
        );
        if (f.game_fleet_id) {
            updateFleetGameIdStmt.run(f.game_fleet_id, f.owner_id, systemId, f.planet_index);
        }
    }
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

// --- strongest_fleet (Ranking: /Ranking/StrongestFleet, war-tool groundwork) ---

// Anything not touched by a sync in 5+ days ages out on its own (see database.js's table
// comment) — run this FIRST in the sync route, before the upsert below, so a scraper
// that's been silent for a while can't leave a misleadingly "current-looking" row sitting
// untouched forever, and so a player who genuinely dropped off 5+ days ago doesn't linger
// in the "more than the top-50" history this table exists to keep.
const deleteStrongestFleetOlderThan5DaysStmt = db.prepare(`DELETE FROM strongest_fleet WHERE updated_at <= datetime('now', '-5 days')`);
function deleteStrongestFleetOlderThan5Days() {
    return deleteStrongestFleetOlderThan5DaysStmt.run();
}

// Replaces every row of one player with the fleets this sync saw for them; players the
// sync did not list are left alone, which is how the table keeps more than one day's top
// 50 (see database.js's table comment). The sync route only calls this with a player_id
// that resolves to a known player — there is no identity to file an unknown owner under.
const deleteStrongestFleetsForPlayerStmt = db.prepare(`DELETE FROM strongest_fleet WHERE player_id = ?`);
const insertStrongestFleetStmt = db.prepare(`
    INSERT INTO strongest_fleet (player_id, rank, destroyers, cruisers, battleships, cv, system_id, planet_index, planet_label, updated_at)
    VALUES (@playerId, @rank, @destroyers, @cruisers, @battleships, @cv, @system_id, @planet_index, @planet_label, @updatedAt)
`);
function replaceStrongestFleetsForPlayer(playerId, fleets, updatedAt) {
    deleteStrongestFleetsForPlayerStmt.run(playerId);
    for (const f of fleets) {
        insertStrongestFleetStmt.run({
            playerId, updatedAt, rank: f.rank,
            destroyers: f.destroyers || 0, cruisers: f.cruisers || 0, battleships: f.battleships || 0, cv: f.cv,
            system_id: f.system_id ?? null, planet_index: f.planet_index ?? null, planet_label: f.planet_label ?? null,
        });
    }
}

const deleteAllStrongestFleetStmt = db.prepare(`DELETE FROM strongest_fleet`);
function deleteAllStrongestFleet() {
    deleteAllStrongestFleetStmt.run();
}

const getStrongestFleetFullStmt = db.prepare(`
    SELECT sf.rank, sf.player_id, sf.destroyers, sf.cruisers, sf.battleships, sf.cv, sf.updated_at,
           sf.system_id, sf.planet_index, sf.planet_label,
           p.name as owner_name, a.id as alliance_id, a.tag as alliance_tag
    FROM strongest_fleet sf
    LEFT JOIN players p ON p.id = sf.player_id
    LEFT JOIN alliances a ON a.id = p.alliance_id
    ORDER BY sf.rank ASC, sf.cv DESC
`);
function getStrongestFleetFull() {
    return getStrongestFleetFullStmt.all();
}

// --- fleet locations (2026-10-08: read from the ranking's own Planet column) ---
//
// Until 2026-10-08 the ranking printed no location, and this guessed one by matching each
// fleet's CV against /Ranking/BestGuarded. The page now names the planet, so the guess is
// gone. location_status:
//  - 'home'    the fleet sits on a planet its owner holds;
//  - 'parked'  it sits on someone else's planet, or an unowned one;
//  - 'unknown' no system on record for it: a row from before the Planet column, or a
//              system name the hub has never scanned (planet_label still says where).
const getStrongestFleetLocatedStmt = db.prepare(`
    SELECT sf.rank, sf.player_id, sf.destroyers, sf.cruisers, sf.battleships, sf.cv, sf.updated_at,
           sf.system_id, sf.planet_index, sf.planet_label,
           p.name AS owner_name, a.id AS alliance_id, a.tag AS alliance_tag,
           s.name AS system_name, pl.game_planet_id, pl.owner_id AS planet_owner_id,
           u.name AS planet_owner_name, ua.id AS planet_owner_alliance_id, ua.tag AS planet_owner_tag
    FROM strongest_fleet sf
    LEFT JOIN players p ON p.id = sf.player_id
    LEFT JOIN alliances a ON a.id = p.alliance_id
    LEFT JOIN systems s ON s.id = sf.system_id
    LEFT JOIN planets pl ON pl.system_id = sf.system_id AND pl.planet_index = sf.planet_index
    LEFT JOIN players u ON u.id = pl.owner_id
    LEFT JOIN alliances ua ON ua.id = u.alliance_id
    WHERE (@playerId IS NULL OR sf.player_id = @playerId)
    ORDER BY sf.rank ASC, sf.cv DESC
`);
function toLocatedFleet(r) {
    const base = {
        rank: r.rank, player_id: r.player_id, destroyers: r.destroyers, cruisers: r.cruisers,
        battleships: r.battleships, cv: r.cv, updated_at: r.updated_at,
        owner_name: r.owner_name, alliance_id: r.alliance_id, alliance_tag: r.alliance_tag,
        planet_label: r.planet_label,
    };
    if (r.system_id == null) return { ...base, location_status: 'unknown', location: null };
    return {
        ...base,
        location_status: r.planet_owner_id === r.player_id ? 'home' : 'parked',
        location: {
            game_planet_id: r.game_planet_id, system_id: r.system_id, system_name: r.system_name,
            planet_index: r.planet_index, owner_id: r.planet_owner_id, owner_name: r.planet_owner_name,
            owner_alliance_id: r.planet_owner_alliance_id, owner_tag: r.planet_owner_tag,
        },
    };
}
function getFleetLocationMatches() {
    return getStrongestFleetLocatedStmt.all({ playerId: null }).map(toLocatedFleet);
}
function getFleetLocationMatchesForPlayer(playerId) {
    return getStrongestFleetLocatedStmt.all({ playerId }).map(toLocatedFleet);
}

// Best-known home location for a player, used ONLY as a fallback below when a rankings
// entry has no location of its own (a row from before the Planet column) — same COALESCE(home_system_id, origin_system) /
// COALESCE(home_planet_index, 1) convention already used for the intercept-homes queries
// elsewhere in players.js.
const getHomeFallbackStmt = db.prepare(`
    SELECT COALESCE(p.home_system_id, p.origin_system) AS system_id,
           COALESCE(p.home_planet_index, 1) AS planet_index,
           s.name AS system_name
    FROM players p
    LEFT JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
    WHERE p.id = ?
`);
function getHomeFallback(playerId) {
    const row = getHomeFallbackStmt.get(playerId);
    return row && row.system_id != null ? row : null;
}

// --- fleet sighting history (player-profile Fleets table, 2026-09-20; revised same day:
// rankings now always shows a location, and battle reports show what SURVIVED, not what
// was fielded) ---
// Merges three independent, genuinely different sources of "we have seen this player's
// fleet" into one newest-first timeline, tagged with where each entry came from. Nothing
// here deduplicates across sources — a battle report and a rankings snapshot from the same
// day are two separate confirmations worth keeping side by side, not one row to merge:
//
//  - 'rankings'      one entry per strongest_fleet row the player holds (a player can
//                     have several fleets ranked at once), at the planet the ranking
//                     page printed for it. A row from before the Planet column has no
//                     location, and falls back to the player's own registered home planet
//                     instead of a bare dash: the Last Seen column already carries the "how
//                     sure are we, and since when" signal. `location_confirmed: false`
//                     marks that fallback so a caller can tell the two apart.
//  - 'battle_report' every battle report in the window with ship detail scraped, showing
//                     what SURVIVED that fight (committed minus lost per ship type), not
//                     what was fielded — a wiped-out ship type reads as 0, and a report
//                     where NOTHING survived at all is dropped from the history entirely:
//                     a fleet with nothing left isn't a sighting of a fleet, it's a record
//                     of one ending, and showing "0 / 0 / 0" would just read as noise on
//                     what should be a list of fleets that still exist.
//  - 'vision'        live system-map sightings from the `fleets` table (owner_id =
//                     player) — the same intel system-scan pages already capture.
//
// CV is recomputed from the observed composition for battle_report/vision rows (`fleets.
// combat_value` is never actually populated by any writer — see insertFleetForAllianceStats
// — and a report's own survived_cv is computed pre-transports/colony-ships, which have 0 CV
// anyway but would make "cv from composition" and "cv from the row" subtly different
// numbers for no reason). The rankings row's cv is used as-is: it's the ranking page's own
// number.
function getFleetSightingHistory(playerId, days = 5) {
    const cutoff = `-${Math.max(1, Math.round(Number(days) || 5))} days`;

    const entries = [];

    const windowStart = Date.now() - Math.max(1, Math.round(Number(days) || 5)) * 86400000;
    const rankingFleets = getFleetLocationMatchesForPlayer(playerId).filter((f) => {
        const seen = parseTimestamp(f.updated_at);
        return seen && seen.getTime() > windowStart;
    });
    for (const f of rankingFleets) {
        let loc = f.location;
        const locationConfirmed = !!loc;
        if (!loc) loc = getHomeFallback(playerId);
        entries.push({
            source: 'rankings', source_id: null, seen_at: f.updated_at,
            system_id: loc ? loc.system_id : null, system_name: loc ? loc.system_name : null,
            planet_index: loc ? loc.planet_index : null,
            location_status: f.location_status, location_confirmed: locationConfirmed,
            destroyers: f.destroyers, cruisers: f.cruisers, battleships: f.battleships,
            transports: null, colony_ships: null, cv: f.cv,
        });
    }

    const battleRows = db.prepare(`
        SELECT br.id AS source_id, br.started_at AS seen_at, br.system_id, s.name AS system_name, br.planet_index,
               CASE WHEN br.att_player_id = @playerId THEN br.att_destroyers ELSE br.def_destroyers END AS destroyers,
               CASE WHEN br.att_player_id = @playerId THEN br.att_destroyers_lost ELSE br.def_destroyers_lost END AS destroyers_lost,
               CASE WHEN br.att_player_id = @playerId THEN br.att_cruisers ELSE br.def_cruisers END AS cruisers,
               CASE WHEN br.att_player_id = @playerId THEN br.att_cruisers_lost ELSE br.def_cruisers_lost END AS cruisers_lost,
               CASE WHEN br.att_player_id = @playerId THEN br.att_battleships ELSE br.def_battleships END AS battleships,
               CASE WHEN br.att_player_id = @playerId THEN br.att_battleships_lost ELSE br.def_battleships_lost END AS battleships_lost,
               CASE WHEN br.att_player_id = @playerId THEN br.att_transports ELSE br.def_transports END AS transports,
               CASE WHEN br.att_player_id = @playerId THEN br.att_transports_lost ELSE br.def_transports_lost END AS transports_lost,
               CASE WHEN br.att_player_id = @playerId THEN br.att_colony_ships ELSE br.def_colony_ships END AS colony_ships,
               CASE WHEN br.att_player_id = @playerId THEN br.att_colony_ships_lost ELSE br.def_colony_ships_lost END AS colony_ships_lost
        FROM battle_reports br
        LEFT JOIN systems s ON s.id = br.system_id
        WHERE (br.att_player_id = @playerId OR br.def_player_id = @playerId)
          AND br.system_id IS NOT NULL
          AND br.started_at > datetime('now', @cutoff)
          AND (CASE WHEN br.att_player_id = @playerId THEN br.att_destroyers ELSE br.def_destroyers END) IS NOT NULL
    `).all({ playerId, cutoff });
    const survivors = (count, lost) => Math.max(0, (count || 0) - (lost || 0));
    for (const r of battleRows) {
        const destroyers = survivors(r.destroyers, r.destroyers_lost);
        const cruisers = survivors(r.cruisers, r.cruisers_lost);
        const battleships = survivors(r.battleships, r.battleships_lost);
        const transports = survivors(r.transports, r.transports_lost);
        const colony_ships = survivors(r.colony_ships, r.colony_ships_lost);
        if (destroyers + cruisers + battleships + transports + colony_ships === 0) continue; // wiped out -- nothing left to sight
        entries.push({
            source: 'battle_report', source_id: r.source_id, seen_at: r.seen_at,
            system_id: r.system_id, system_name: r.system_name, planet_index: r.planet_index,
            location_status: null, location_confirmed: true,
            destroyers, cruisers, battleships, transports, colony_ships,
            cv: cvOf({ destroyers, cruisers, battleships }),
        });
    }

    const visionRows = db.prepare(`
        SELECT f.id AS source_id, f.updated_at AS seen_at, f.system_id, s.name AS system_name, f.planet_index,
               f.destroyers, f.cruisers, f.battleships, f.transports, f.colony_ships
        FROM fleets f
        LEFT JOIN systems s ON s.id = f.system_id
        WHERE f.owner_id = ? AND f.updated_at > datetime('now', ?)
    `).all(playerId, cutoff);
    for (const r of visionRows) {
        entries.push({
            source: 'vision', source_id: null, seen_at: r.seen_at,
            system_id: r.system_id, system_name: r.system_name, planet_index: r.planet_index,
            location_status: null, location_confirmed: true,
            destroyers: r.destroyers, cruisers: r.cruisers, battleships: r.battleships,
            transports: r.transports, colony_ships: r.colony_ships,
            cv: cvOf({ destroyers: r.destroyers, cruisers: r.cruisers, battleships: r.battleships }),
        });
    }

    entries.sort((a, b) => (parseTimestamp(b.seen_at)?.getTime() || 0) - (parseTimestamp(a.seen_at)?.getTime() || 0));
    return entries;
}

module.exports = {
    countFleets, getFleetsForSystem, getFleetsForSystemFull, getFleetsFullDb,
    getFleetsForTimeline, deleteFleetsOlderThan10Days, deleteAllFleets, deleteFleetsByOwner,
    insertFleetForAllianceStats, updateFleetGameId,
    getMemberIdsForTags, replaceEnemyFleetsForSystem,
    getInterceptFleetsByAlliance, getInterceptFleetsByActiveUsers,
    deleteStrongestFleetOlderThan5Days, deleteAllStrongestFleet, replaceStrongestFleetsForPlayer, getStrongestFleetFull,
    getFleetLocationMatches, getFleetLocationMatchesForPlayer, getFleetSightingHistory,
};
