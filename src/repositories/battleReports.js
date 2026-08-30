const db = require('../database');

const deleteAllBattleReportsStmt = db.prepare(`DELETE FROM battle_reports`);
function deleteAllBattleReports() {
    return deleteAllBattleReportsStmt.run().changes;
}

const getPendingAnnouncementsStmt = db.prepare(
    `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`
);
function getPendingAnnouncements() {
    return getPendingAnnouncementsStmt.all();
}

const markAnnouncedStmt = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
function markAnnounced(id) {
    markAnnouncedStmt.run(id);
}

const getNewestStartedAtStmt = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`);
function getNewestStartedAt() {
    return getNewestStartedAtStmt.get().newest || null;
}

const getReportsNeedingShipDetailStmt = db.prepare(`
    SELECT id FROM battle_reports
    WHERE ship_detail_scraped_at IS NULL
    ORDER BY started_at DESC
    LIMIT ?
`);
function getReportsNeedingShipDetail(limit) {
    return getReportsNeedingShipDetailStmt.all(limit).map(r => r.id);
}

// Arity varies per call (ids length) — prepared fresh each call, same reasoning as
// systems.js's getSystemsByIds / players.js's markPlayersApiScanned.
function markShipDetailScraped(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE battle_reports SET ship_detail_scraped_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
}

const updateShipDetailStmt = db.prepare(`
    UPDATE battle_reports SET
        att_destroyers=@att_destroyers, att_destroyers_lost=@att_destroyers_lost,
        att_cruisers=@att_cruisers, att_cruisers_lost=@att_cruisers_lost,
        att_battleships=@att_battleships, att_battleships_lost=@att_battleships_lost,
        att_transports=@att_transports, att_transports_lost=@att_transports_lost,
        att_colony_ships=@att_colony_ships, att_colony_ships_lost=@att_colony_ships_lost,
        att_starbases=@att_starbases, att_starbases_lost=@att_starbases_lost,
        def_destroyers=@def_destroyers, def_destroyers_lost=@def_destroyers_lost,
        def_cruisers=@def_cruisers, def_cruisers_lost=@def_cruisers_lost,
        def_battleships=@def_battleships, def_battleships_lost=@def_battleships_lost,
        def_transports=@def_transports, def_transports_lost=@def_transports_lost,
        def_colony_ships=@def_colony_ships, def_colony_ships_lost=@def_colony_ships_lost,
        def_starbases=@def_starbases, def_starbases_lost=@def_starbases_lost,
        win_chance=@win_chance,
        system_id=@system_id, planet_index=@planet_index,
        ship_detail_scraped_at=CURRENT_TIMESTAMP
    WHERE id=@id
`);
function updateShipDetail(id, detail) {
    updateShipDetailStmt.run({ id, ...detail });
}

// "Last seen" for a player: the most recent events of ANY kind that name them, on either
// side (attacker/defender in battle_reports; either party in news_events — see
// news-battle-matching.js's other_player_id/player_id convention), newest first. Two
// different sources with two different location shapes: battle_reports gives (system_id,
// planet_index) — the planets table's own primary key, from the report page header (no
// game_planet_id available there at all); news_events gives (system_id, game_planet_id)
// from the News-page row's own links, plus credited_player_id/population_delta for
// bombardment rows. Both are returned as-is; the caller resolves display text (see
// discord_bot.js's !lastseen), since resolving a human-readable planet name needs the
// systems/planets tables this repository doesn't own.
const recentPlanetsBattleReportsStmt = db.prepare(`
    SELECT started_at AS occurred_at, system_id, planet_index, NULL AS game_planet_id,
           id AS source_id, 'battle_report' AS source, NULL AS credited_player_id, NULL AS population_delta,
           NULL AS message_type
    FROM battle_reports
    WHERE (att_player_id = ? OR def_player_id = ?) AND system_id IS NOT NULL
    ORDER BY started_at DESC LIMIT ?
`);
const recentPlanetsNewsEventsStmt = db.prepare(`
    SELECT occurred_at, system_id, NULL AS planet_index, game_planet_id,
           id AS source_id, 'news_event' AS source, credited_player_id, population_delta, message_type
    FROM news_events
    WHERE (player_id = ? OR other_player_id = ?) AND system_id IS NOT NULL
    ORDER BY occurred_at DESC LIMIT ?
`);
function getRecentPlanets(playerId, limit = 5) {
    const candidates = [
        ...recentPlanetsBattleReportsStmt.all(playerId, playerId, limit),
        ...recentPlanetsNewsEventsStmt.all(playerId, playerId, limit),
    ];
    candidates.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
    return candidates.slice(0, limit);
}

// Distinguishes "never in a recorded battle at all" from "has battles, but none with a
// resolved location yet" (e.g. the ship-detail scrape sweep hasn't reached that report) —
// getRecentPlanets alone can't tell those apart since it only ever returns located rows.
const hasHistoryBattleReportsStmt = db.prepare(`SELECT 1 FROM battle_reports WHERE att_player_id = ? OR def_player_id = ? LIMIT 1`);
const hasHistoryNewsEventsStmt = db.prepare(`SELECT 1 FROM news_events WHERE player_id = ? OR other_player_id = ? LIMIT 1`);
function hasAnyBattleHistory(playerId) {
    return !!(hasHistoryBattleReportsStmt.get(playerId, playerId) || hasHistoryNewsEventsStmt.get(playerId, playerId));
}

const findByPlayerPairNearStmt = db.prepare(`
    SELECT id FROM battle_reports
    WHERE ((att_player_id = @a AND def_player_id = @b) OR (att_player_id = @b AND def_player_id = @a))
      AND started_at BETWEEN @from AND @to
    LIMIT 1
`);

// News-page events carry no planet reference (battle_reports has no planet/system column
// at all) — matching is by player pair + time proximity instead. Direction doesn't matter:
// either player could be attacker or defender in the stored report.
function findByPlayerPairNear(playerA, playerB, occurredAtIso, windowMinutes) {
    const center = new Date(occurredAtIso).getTime();
    const from = new Date(center - windowMinutes * 60000).toISOString();
    const to = new Date(center + windowMinutes * 60000).toISOString();
    const row = findByPlayerPairNearStmt.get({ a: playerA, b: playerB, from, to });
    return row ? row.id : null;
}

module.exports = {
    deleteAllBattleReports,
    getPendingAnnouncements,
    markAnnounced,
    getNewestStartedAt,
    getReportsNeedingShipDetail,
    markShipDetailScraped,
    updateShipDetail,
    findByPlayerPairNear,
    getRecentPlanets,
    hasAnyBattleHistory,
};
