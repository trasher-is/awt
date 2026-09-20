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
// comment) — run this FIRST in the sync route, before the upsert below, so a scraper
// that's been silent for a while can't leave a misleadingly "current-looking" row sitting
// untouched forever, and so a player who genuinely dropped off 5+ days ago doesn't linger
// in the "more than the top-50" history this table exists to keep.
const deleteStrongestFleetOlderThan5DaysStmt = db.prepare(`DELETE FROM strongest_fleet WHERE updated_at <= datetime('now', '-5 days')`);
function deleteStrongestFleetOlderThan5Days() {
    return deleteStrongestFleetOlderThan5DaysStmt.run();
}

// Upsert, NOT wholesale-replace (2026-09-20 revision — see database.js's table comment for
// the full reasoning): a player missing from today's scrape simply isn't touched, so their
// last-known row survives until the 5-day purge above removes it. This is what lets the
// table hold more than one day's top-50 at once. The sync route is responsible for
// collapsing a player's multiple simultaneous fleets down to one row (largest cv) before
// calling this, and for never calling it with a player_id that doesn't resolve to a known
// player — there is no stable identity to upsert an unknown owner against.
const upsertStrongestFleetStmt = db.prepare(`
    INSERT INTO strongest_fleet (player_id, rank, destroyers, cruisers, battleships, cv, updated_at)
    VALUES (@playerId, @rank, @destroyers, @cruisers, @battleships, @cv, @updatedAt)
    ON CONFLICT(player_id) DO UPDATE SET
        rank = excluded.rank, destroyers = excluded.destroyers, cruisers = excluded.cruisers,
        battleships = excluded.battleships, cv = excluded.cv, updated_at = excluded.updated_at
`);
function upsertStrongestFleet(playerId, rank, destroyers, cruisers, battleships, cv, updatedAt) {
    upsertStrongestFleetStmt.run({ playerId, rank, destroyers, cruisers, battleships, cv, updatedAt });
}

const deleteAllStrongestFleetStmt = db.prepare(`DELETE FROM strongest_fleet`);
function deleteAllStrongestFleet() {
    deleteAllStrongestFleetStmt.run();
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
    // Keyed by player_id (the table's real primary key since the 2026-09-20 history
    // revision), not rank — rank is now just "last known rank" and can repeat across
    // different players' rows on different days, so it is no longer a safe map key.
    const selfResolved = new Map(); // player_id -> location
    for (const f of fleets) {
        const candidates = guardedByCv.get(f.cv) || [];
        const self = candidates.find((g) => g.owner_id === f.player_id);
        if (self) selfResolved.set(f.player_id, asCandidate(self));
    }

    // Pass 2: among fleets that did NOT self-resolve, count how many are still contending
    // for each cv — this is the real collision count, with self-matched fleets removed
    // from contention (their cv coincidence with someone else is no longer anyone's problem).
    const unresolvedCountByCv = new Map();
    for (const f of fleets) {
        if (selfResolved.has(f.player_id)) continue;
        unresolvedCountByCv.set(f.cv, (unresolvedCountByCv.get(f.cv) || 0) + 1);
    }

    return fleets.map((f) => {
        const home = selfResolved.get(f.player_id);
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

// Player-profile card (2026-09-20): the same cross-match as above, for exactly one player.
// Recomputes the full match set rather than querying strongest_fleet WHERE player_id = ?
// directly — the collision/self-match logic genuinely needs every OTHER fleet at the same
// cv to answer correctly (see the ambiguous-vs-home distinction above), and this table is
// small enough (5 days of a top-50 ranking, at most a few hundred rows) that recomputing
// is simpler than trying to answer the question from one row in isolation.
function getFleetLocationMatchForPlayer(playerId) {
    return getFleetLocationMatches().find((f) => f.player_id === playerId) || null;
}

// Best-known home location for a player, used ONLY as a fallback below when a rankings
// entry has no live best_guarded match — same COALESCE(home_system_id, origin_system) /
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
//  - 'rankings'      the player's current strongest_fleet row (at most one, since that
//                     table is itself upserted per player — see its own comment), located
//                     via the same self-match/collision logic as getFleetLocationMatches
//                     when that resolves (home/parked). When it doesn't (away/ambiguous —
//                     no best_guarded planet to point to), this falls back to the player's
//                     own registered home planet instead of leaving location blank: the
//                     Last Seen column already carries the "how sure are we, and since
//                     when" signal, so an unconfirmed-but-plausible location beats a bare
//                     dash. `location_confirmed: false` marks that fallback case so a
//                     caller can still tell the two apart if it wants to.
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

    const rankingsRow = db.prepare(`
        SELECT destroyers, cruisers, battleships, cv, updated_at
        FROM strongest_fleet WHERE player_id = ? AND updated_at > datetime('now', ?)
    `).get(playerId, cutoff);
    if (rankingsRow) {
        const match = getFleetLocationMatchForPlayer(playerId);
        let loc = match && match.location ? match.location : null;
        const locationConfirmed = !!loc;
        if (!loc) loc = getHomeFallback(playerId);
        entries.push({
            source: 'rankings', source_id: null, seen_at: rankingsRow.updated_at,
            system_id: loc ? loc.system_id : null, system_name: loc ? loc.system_name : null,
            planet_index: loc ? loc.planet_index : null,
            location_status: match ? match.location_status : null, location_confirmed: locationConfirmed,
            destroyers: rankingsRow.destroyers, cruisers: rankingsRow.cruisers, battleships: rankingsRow.battleships,
            transports: null, colony_ships: null, cv: rankingsRow.cv,
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
    deleteStrongestFleetOlderThan5Days, deleteAllStrongestFleet, upsertStrongestFleet, getStrongestFleetFull,
    getFleetLocationMatches, getFleetLocationMatchForPlayer, getFleetSightingHistory,
};
