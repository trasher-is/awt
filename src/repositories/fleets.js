const db = require('../database');

const countFleetsStmt = db.prepare(`SELECT COUNT(*) as count FROM fleets`);
function countFleets() {
    return countFleetsStmt.get().count;
}

const getFleetsForSystemStmt = db.prepare(`
    SELECT f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships,
           f.arrival_at, f.arrival_time,
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
// comment) — run this FIRST in the sync route, before the wholesale replace below, so a
// scraper that's been silent for a while can't leave a misleadingly "current-looking" row
// sitting untouched forever.
const deleteStrongestFleetOlderThan5DaysStmt = db.prepare(`DELETE FROM strongest_fleet WHERE updated_at <= datetime('now', '-5 days')`);
function deleteStrongestFleetOlderThan5Days() {
    return deleteStrongestFleetOlderThan5DaysStmt.run();
}

const clearStrongestFleetStmt = db.prepare(`DELETE FROM strongest_fleet`);
function clearStrongestFleet() {
    clearStrongestFleetStmt.run();
}

// player_id is passed as `null` (not skipped) by the sync route when the ranking's owner
// isn't a known player yet — see that route's own comment for why silently dropping the
// row instead would be the wrong call.
const insertStrongestFleetStmt = db.prepare(`
    INSERT INTO strongest_fleet (rank, player_id, destroyers, cruisers, battleships, cv, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);
function insertStrongestFleet(rank, playerId, destroyers, cruisers, battleships, cv, updatedAt) {
    insertStrongestFleetStmt.run(rank, playerId, destroyers, cruisers, battleships, cv, updatedAt);
}

const getStrongestFleetFullStmt = db.prepare(`
    SELECT sf.rank, sf.player_id, sf.destroyers, sf.cruisers, sf.battleships, sf.cv, sf.updated_at,
           p.name as owner_name, a.tag as alliance_tag
    FROM strongest_fleet sf
    LEFT JOIN players p ON p.id = sf.player_id
    LEFT JOIN alliances a ON a.id = p.alliance_id
    ORDER BY sf.rank ASC
`);
function getStrongestFleetFull() {
    return getStrongestFleetFullStmt.all();
}

// --- fleet location cross-match (war-tool groundwork: locate a StrongestFleet entry by
// matching its CV against best_guarded, 2026-09-20) ---
//
// best_guarded carries no ship-composition breakdown, only a total CV per planet, so a
// match can only ever be established by CV equality — there is nothing on that side of the
// join for a destroyer/cruiser/battleship comparison to help disambiguate. Two different
// players occasionally field the literally identical fleet (confirmed live 2026-09-20: two
// players both at 105 CV / 35 destroyers on the same day) — but that is NOT automatically
// ambiguous: each of those two also owns a planet whose OWN best_guarded entry happens to
// be that same cv (each is simply sitting home, and their numbers coincide by chance), and
// self-ownership resolves that cleanly without needing to pick between them. So self-match
// is checked FIRST, before any collision logic runs at all: if a fleet's cv matches a
// planet it owns, that's `home`, full stop, regardless of how many unrelated players
// elsewhere happen to share the same cv. Only fleets that don't self-resolve enter the
// leftover pool, where a genuine collision (multiple candidate planets, or multiple other
// unclaimed fleets contending for one) comes back `location_status: 'ambiguous'` with
// every candidate listed rather than a silent pick — a wrong "he's parked at X" is worse
// than an honest "unknown". `away` means the fleet's cv matches no top-50 guarded planet at
// all: travelling, staged somewhere not worth top-50 defense, or genuinely unlocatable —
// the "gone" signal the war-tool design leaned on, since best_guarded can never show a
// fleet sitting on its owner's own OTHER, non-guarded home planet either.
const getBestGuardedForMatchStmt = db.prepare(`
    SELECT bg.game_planet_id,
           CAST(REPLACE(REPLACE(bg.cv, ',', ''), ' ', '') AS INTEGER) AS cv,
           bg.updated_at,
           p.system_id, p.planet_index, p.owner_id,
           s.name AS system_name, u.name AS owner_name, a.tag AS owner_tag
    FROM best_guarded bg
    JOIN planets p ON p.game_planet_id = bg.game_planet_id
    LEFT JOIN systems s ON s.id = p.system_id
    LEFT JOIN players u ON u.id = p.owner_id
    LEFT JOIN alliances a ON a.id = u.alliance_id
`);

function getFleetLocationMatches() {
    const fleets = getStrongestFleetFullStmt.all();
    const guarded = getBestGuardedForMatchStmt.all();
    const asCandidate = (g) => ({
        game_planet_id: g.game_planet_id, system_id: g.system_id, system_name: g.system_name,
        planet_index: g.planet_index, owner_id: g.owner_id, owner_name: g.owner_name,
        owner_tag: g.owner_tag, guard_updated_at: g.updated_at,
    });

    const guardedByCv = new Map();
    for (const g of guarded) {
        if (!guardedByCv.has(g.cv)) guardedByCv.set(g.cv, []);
        guardedByCv.get(g.cv).push(g);
    }

    // Pass 1: resolve every fleet that can self-match (owns a planet at its own cv) —
    // these are certain and must never be pulled into another fleet's collision count.
    const selfResolved = new Map(); // rank -> location
    for (const f of fleets) {
        const candidates = guardedByCv.get(f.cv) || [];
        const self = candidates.find((g) => g.owner_id === f.player_id);
        if (self) selfResolved.set(f.rank, asCandidate(self));
    }

    // Pass 2: among fleets that did NOT self-resolve, count how many are still contending
    // for each cv — this is the real collision count, with self-matched fleets removed
    // from contention (their cv coincidence with someone else is no longer anyone's problem).
    const unresolvedCountByCv = new Map();
    for (const f of fleets) {
        if (selfResolved.has(f.rank)) continue;
        unresolvedCountByCv.set(f.cv, (unresolvedCountByCv.get(f.cv) || 0) + 1);
    }

    return fleets.map((f) => {
        const home = selfResolved.get(f.rank);
        if (home) return { ...f, location_status: 'home', location: home, candidates: [] };

        const candidates = guardedByCv.get(f.cv) || [];
        if (candidates.length === 0) {
            return { ...f, location_status: 'away', location: null, candidates: [] };
        }
        if (candidates.length > 1 || unresolvedCountByCv.get(f.cv) > 1) {
            return { ...f, location_status: 'ambiguous', location: null, candidates: candidates.map(asCandidate) };
        }

        return { ...f, location_status: 'parked', location: asCandidate(candidates[0]), candidates: [] };
    });
}

module.exports = {
    countFleets, getFleetsForSystem, getFleetsForSystemFull, getFleetsFullDb,
    getFleetsForTimeline, deleteFleetsOlderThan10Days, deleteAllFleets, deleteFleetsByOwner,
    insertFleetForAllianceStats, updateFleetGameId,
    getMemberIdsForTags, replaceEnemyFleetsForSystem,
    getInterceptFleetsByAlliance, getInterceptFleetsByActiveUsers,
    deleteStrongestFleetOlderThan5Days, clearStrongestFleet, insertStrongestFleet, getStrongestFleetFull,
    getFleetLocationMatches,
};
