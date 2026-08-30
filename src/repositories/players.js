const db = require('../database');

// --- players: read (intel.js) ---

const getWarRoomPlayersStmt = db.prepare(`
    SELECT p.id, p.name, p.economy, p.social, p.physics, p.mathematics, p.energy, p.biology, p.idle_time,
           p.race_attack, p.race_defense, p.race_speed, p.race_production, p.race_science,
           p.updated_at as player_scan_time, p.intel_updated_at,
           p.total_population, p.total_factories, p.total_farms, p.total_cybernetics, p.total_labs,
           p.trade_revenue, p.artefact,
           p.level, p.culture_level, p.has_intel,
           a.tag as alliance_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as total_planets
    FROM players p
    JOIN alliances a ON p.alliance_id = a.id
    WHERE p.alliance_id = ?
`);
function getWarRoomPlayers(allianceId) {
    return getWarRoomPlayersStmt.all(allianceId);
}

const getAllianceIntelPlayerIdsStmt = db.prepare(`
    SELECT id FROM players
    WHERE alliance_id = ? AND has_intel = 1
`);
function getAllianceIntelPlayerIds(allianceId) {
    return getAllianceIntelPlayerIdsStmt.all(allianceId);
}

const countPlayersStmt = db.prepare(`SELECT COUNT(*) as count FROM players`);
function countPlayers() {
    return countPlayersStmt.get().count;
}

const listPlayerIdsStmt = db.prepare(`SELECT id FROM players ORDER BY id ASC`);
function listPlayerIds() {
    return listPlayerIdsStmt.all();
}

const getFullPlayersDbStmt = db.prepare(`
    SELECT p.*, a.tag as alliance_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as planet_count
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
`);
function getFullPlayersDb() {
    return getFullPlayersDbStmt.all();
}

// Arity varies per call (memberIds length), so prepared fresh each call — same reasoning as
// systems.js's getSystemsByIds.
function getAllianceTagForMembers(memberIds) {
    if (!memberIds.length) return undefined;
    const marks = memberIds.map(() => '?').join(',');
    return db.prepare(`
        SELECT a.tag, COUNT(*) AS n
        FROM players p JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id IN (${marks})
        GROUP BY a.tag ORDER BY n DESC LIMIT 1
    `).get(...memberIds);
}

function getVisionObservers(memberIds) {
    if (!memberIds.length) return [];
    const marks = memberIds.map(() => '?').join(',');
    return db.prepare(`
        SELECT p.id AS playerId, p.name, p.biology, p.science_level,
               s.id AS originSystemId, s.x, s.y
        FROM players p
        JOIN systems s ON p.origin_system = s.id
        WHERE p.id IN (${marks})
          AND p.origin_system IS NOT NULL AND p.origin_system > 0
          AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(...memberIds);
}

const getPlayerWithPlanetCountStmt = db.prepare(`
    SELECT p.*,
           a.tag as alliance_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = ?) as planet_count
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.id = ?
`);
function getPlayerWithPlanetCount(playerId) {
    return getPlayerWithPlanetCountStmt.get(playerId, playerId);
}

// --- player_logins: read (intel.js) ---

const getPlayerLoginHistoryStmt = db.prepare(`
    SELECT timestamp, total_logins
    FROM player_logins
    WHERE player_id = ?
    ORDER BY timestamp ASC
    LIMIT 30
`);
function getPlayerLoginHistory(playerId) {
    return getPlayerLoginHistoryStmt.all(playerId);
}

const getPlayerLoginHeatmapStmt = db.prepare(`
    SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
    FROM player_logins
    WHERE player_id = ?
    GROUP BY hour
`);
function getPlayerLoginHeatmap(playerId) {
    return getPlayerLoginHeatmapStmt.all(playerId);
}

// --- players / player_logins: write (sync.js) ---

// System-scan upsert: preserves existing alliance_id when the new value is null.
const upsertPlayerBasicStmt = db.prepare(`
    INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        alliance_id = CASE WHEN excluded.alliance_id IS NOT NULL THEN excluded.alliance_id ELSE players.alliance_id END,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertPlayerBasic(id, name, allianceId) {
    upsertPlayerBasicStmt.run(id, name, allianceId);
}

const getPlayerNameWithTagStmt = db.prepare(`
    SELECT p.name, a.tag AS alliance_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.id = ?
`);
function getPlayerNameWithTag(id) {
    return getPlayerNameWithTagStmt.get(id);
}

const getPlayerRestartCheckStmt = db.prepare(`SELECT logins, points, origin_system FROM players WHERE id = ?`);
function getPlayerRestartCheck(id) {
    return getPlayerRestartCheckStmt.get(id);
}

// Existence check only — used by /sync/news (sync.js) to guard other_player_id before it
// is stored or used for crediting: a News row can name a player the hub has never scanned
// (no players row exists yet), and news_events.other_player_id has a FOREIGN KEY to
// players(id) that would otherwise abort the insert.
const playerExistsByIdStmt = db.prepare(`SELECT 1 FROM players WHERE id = ?`);
function playerExistsById(id) {
    return playerExistsByIdStmt.get(id) !== undefined;
}

// The reset is a HEURISTIC and heuristics misfire (see issues #46/#48: a false
// restart once zeroed a player's race picks). So it may only clear columns the
// upsert below writes UNCONDITIONALLY — the public stats anyone can read off the
// profile/ranking. It must NOT touch the intel-derived columns (sciences per
// field, race picks, artefact, eco bonus, has_intel), because those are governed
// solely by the `has_intel` CASE guard in the upsert: hard-won intel must never
// be destroyed by a guess. A genuinely restarted player keeps stale intel (with
// its old intel_updated_at) until the next scan with vision overwrites it —
// cosmetic staleness beats irreversible data loss. origin_system IS reset here so
// the originChanged signal can re-arm on the next move.
const resetPlayerOnRestartStmt = db.prepare(`
    UPDATE players SET
        level=0, points=0, ranking=NULL, science_level=0, culture_level=0,
        origin_system=NULL,
        home_planet_id=NULL, home_system_id=NULL, home_planet_index=NULL, possible_homes='[]',
        total_planets=0, total_population=0, total_farms=0, total_factories=0, total_labs=0, total_cybernetics=0, cv_used=0, cv_limit=0,
        stats_scraped_at=NULL
    WHERE id = ?
`);
function resetPlayerOnRestart(id) {
    resetPlayerOnRestartStmt.run(id);
}

const upsertPlayerFullStmt = db.prepare(`
    INSERT INTO players (
        id, name, alliance_id, country, local_time, idle_time, origin_system,
        level, ranking, points, science_level, culture_level,
        biology, economy, energy, mathematics, physics, social,
        trade_revenue, artefact, eco_bonus,
        race_growth, race_science, race_culture, race_production, race_speed, race_attack, race_defense,
        race_trader, race_sul, joined, logins, has_intel, intel_updated_at,
        home_planet_id, home_system_id, home_planet_index, possible_homes,
        total_planets, total_population, total_farms, total_factories, total_labs, total_cybernetics, cv_used, cv_limit,
        stats_scraped_at
    ) VALUES (
        @id, @name, @alliance_id, @country, @local_time, @idle_time, @origin_system,
        @level, @ranking, @points, @science_level, @culture_level,
        @biology, @economy, @energy, @mathematics, @physics, @social,
        @trade_revenue, @artefact, @eco_bonus,
        @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack, @race_defense,
        @race_trader, @race_sul, @joined, @logins, @has_intel,
        CASE WHEN @has_intel = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        @home_planet_id, @home_system_id, @home_planet_index, @possible_homes,
        @total_planets, @total_population, @total_farms, @total_factories, @total_labs, @total_cybernetics, @cv_used, @cv_limit,
        CURRENT_TIMESTAMP
    ) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, alliance_id=excluded.alliance_id, country=excluded.country,
        local_time=excluded.local_time, idle_time=excluded.idle_time, origin_system=excluded.origin_system,
        level=excluded.level, ranking=excluded.ranking, points=excluded.points,
        science_level=excluded.science_level, culture_level=excluded.culture_level,
        joined=excluded.joined, logins=excluded.logins,
        home_planet_id=excluded.home_planet_id, home_system_id=excluded.home_system_id, home_planet_index=excluded.home_planet_index,
        possible_homes=excluded.possible_homes, total_planets=excluded.total_planets, total_population=excluded.total_population,
        total_farms=excluded.total_farms, total_factories=excluded.total_factories, total_labs=excluded.total_labs,
        total_cybernetics=excluded.total_cybernetics, cv_used=excluded.cv_used, cv_limit=excluded.cv_limit,
        stats_scraped_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP,

        biology = CASE WHEN excluded.has_intel = 1 THEN excluded.biology ELSE players.biology END,
        economy = CASE WHEN excluded.has_intel = 1 THEN excluded.economy ELSE players.economy END,
        energy = CASE WHEN excluded.has_intel = 1 THEN excluded.energy ELSE players.energy END,
        mathematics = CASE WHEN excluded.has_intel = 1 THEN excluded.mathematics ELSE players.mathematics END,
        physics = CASE WHEN excluded.has_intel = 1 THEN excluded.physics ELSE players.physics END,
        social = CASE WHEN excluded.has_intel = 1 THEN excluded.social ELSE players.social END,
        trade_revenue = CASE WHEN excluded.has_intel = 1 THEN excluded.trade_revenue ELSE players.trade_revenue END,
        artefact = CASE WHEN excluded.has_intel = 1 THEN excluded.artefact ELSE players.artefact END,
        eco_bonus = CASE WHEN excluded.has_intel = 1 THEN excluded.eco_bonus ELSE players.eco_bonus END,
        race_growth = CASE WHEN excluded.has_intel = 1 THEN excluded.race_growth ELSE players.race_growth END,
        race_science = CASE WHEN excluded.has_intel = 1 THEN excluded.race_science ELSE players.race_science END,
        race_culture = CASE WHEN excluded.has_intel = 1 THEN excluded.race_culture ELSE players.race_culture END,
        race_production = CASE WHEN excluded.has_intel = 1 THEN excluded.race_production ELSE players.race_production END,
        race_speed = CASE WHEN excluded.has_intel = 1 THEN excluded.race_speed ELSE players.race_speed END,
        race_attack = CASE WHEN excluded.has_intel = 1 THEN excluded.race_attack ELSE players.race_attack END,
        race_defense = CASE WHEN excluded.has_intel = 1 THEN excluded.race_defense ELSE players.race_defense END,
        race_trader = CASE WHEN excluded.has_intel = 1 THEN excluded.race_trader ELSE players.race_trader END,
        race_sul = CASE WHEN excluded.has_intel = 1 THEN excluded.race_sul ELSE players.race_sul END,
        intel_updated_at = CASE WHEN excluded.has_intel = 1 THEN CURRENT_TIMESTAMP ELSE players.intel_updated_at END,
        has_intel = CASE WHEN excluded.has_intel = 1 THEN 1 ELSE players.has_intel END
`);
function upsertPlayerFull(player) {
    upsertPlayerFullStmt.run(player);
}

const insertPlayerLoginStmt = db.prepare(`INSERT INTO player_logins (player_id, total_logins) VALUES (?, ?)`);
function insertPlayerLogin(playerId, totalLogins) {
    insertPlayerLoginStmt.run(playerId, totalLogins);
}

// Alliance-scan member upsert: unconditionally overwrites alliance_id (unlike
// upsertPlayerBasic above, which preserves it when the new value is null). Two distinct
// call shapes in the original code — kept separate per the no-behavior-change rule.
const upsertAllianceMemberBasicStmt = db.prepare(`
    INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        alliance_id=excluded.alliance_id,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceMemberBasic(id, name, allianceId) {
    upsertAllianceMemberBasicStmt.run(id, name, allianceId);
}

const upsertPlayerNameOnlyStmt = db.prepare(`
    INSERT INTO players (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=CURRENT_TIMESTAMP
`);
function upsertPlayerNameOnly(id, name) {
    upsertPlayerNameOnlyStmt.run(id, name);
}

// --- players: read (discord_bot.js) ---

const getPlayerBiologyByNameStmt = db.prepare(`SELECT id, biology FROM players WHERE LOWER(name) = ?`);
function getPlayerBiologyByName(name) {
    return getPlayerBiologyByNameStmt.get(name);
}

const getThreatPlayersByBiologyStmt = db.prepare(`
    SELECT p.name, p.biology, a.tag as ally_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.has_intel = 1 AND p.biology >= ? AND p.id != ?
    ORDER BY p.biology DESC, p.name ASC
    LIMIT 25
`);
function getThreatPlayersByBiology(threshold, excludeId) {
    return getThreatPlayersByBiologyStmt.all(threshold, excludeId);
}

const getThreatPlayersByScienceStmt = db.prepare(`
    SELECT p.name, p.science_level, a.tag as ally_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.has_intel = 0 AND p.science_level >= ? AND p.id != ?
    ORDER BY p.science_level DESC, p.name ASC
    LIMIT 25
`);
function getThreatPlayersByScience(threshold, excludeId) {
    return getThreatPlayersByScienceStmt.all(threshold, excludeId);
}

const getPlayerTravelStatsByNameStmt = db.prepare(`SELECT name, race_speed, energy FROM players WHERE name LIKE ?`);
function getPlayerTravelStatsByName(name) {
    return getPlayerTravelStatsByNameStmt.get(name);
}

const countUnaffiliatedIntelPlayersStmt = db.prepare(`
    SELECT COUNT(*) as count FROM players p
    WHERE p.alliance_id IS NULL
    AND p.has_intel = 1
`);
function countUnaffiliatedIntelPlayers() {
    return countUnaffiliatedIntelPlayersStmt.get().count;
}

const listUnaffiliatedIntelPlayersStmt = db.prepare(`
    SELECT id, name FROM players
    WHERE alliance_id IS NULL AND has_intel = 1
    ORDER BY name ASC
`);
function listUnaffiliatedIntelPlayers() {
    return listUnaffiliatedIntelPlayersStmt.all();
}

const listAllianceIntelPlayersStmt = db.prepare(`
    SELECT id, name FROM players
    WHERE alliance_id = ? AND has_intel = 1
    ORDER BY name ASC
`);
function listAllianceIntelPlayers(allianceId) {
    return listAllianceIntelPlayersStmt.all(allianceId);
}

const getPlayerFullByIdStmt = db.prepare(`
    SELECT p.*, a.tag as ally_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
           (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.id = ?
`);
function getPlayerFullById(id) {
    return getPlayerFullByIdStmt.get(id);
}

const getPlayerFullByNameStmt = db.prepare(`
    SELECT p.*, a.tag as ally_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
           (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.name LIKE ?
`);
function getPlayerFullByName(name) {
    return getPlayerFullByNameStmt.get(name);
}

const getAllianceOriginPlayersBriefStmt = db.prepare(`
    SELECT p.name, p.biology, p.science_level, s.x, s.y
    FROM players p
    JOIN alliances a ON p.alliance_id = a.id
    JOIN systems s ON p.origin_system = s.id
    WHERE a.tag = ?
    AND p.origin_system IS NOT NULL
    AND p.origin_system > 0
`);
function getAllianceOriginPlayersBrief(tag) {
    return getAllianceOriginPlayersBriefStmt.all(tag);
}

const getAllianceOriginPlayersDetailedStmt = db.prepare(`
    SELECT p.id, p.name, p.biology, p.science_level, p.energy, p.race_speed, s.id as orig_sys_id, s.x as orig_x, s.y as orig_y
    FROM players p
    JOIN alliances a ON p.alliance_id = a.id
    JOIN systems s ON p.origin_system = s.id
    WHERE a.tag = ?
`);
function getAllianceOriginPlayersDetailed(tag) {
    return getAllianceOriginPlayersDetailedStmt.all(tag);
}

// Consolidates discord_bot.js's !battlecalc --def and --atk lookups (byte-identical SQL in
// the original code — see Global Constraints exception #1).
const getPlayerCombatStatsStmt = db.prepare(`SELECT name, level, physics, mathematics, race_attack, race_defense FROM players WHERE name LIKE ?`);
function getPlayerCombatStats(name) {
    return getPlayerCombatStatsStmt.get(name);
}

// --- players: write (admin.js) ---

const deleteAllPlayersStmt = db.prepare(`DELETE FROM players`);
function deleteAllPlayers() {
    deleteAllPlayersStmt.run();
}

// --- players: read (trade.js) ---

const getPlayerIdByNameStmt = db.prepare(`SELECT id FROM players WHERE name = ? COLLATE NOCASE`);
function getPlayerIdByName(name) {
    return getPlayerIdByNameStmt.get(name);
}

// --- players: read (search.js) ---

const searchPlayersByNameOrIdStmt = db.prepare(`
    SELECT p.id, p.name, a.tag as alliance_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.name LIKE ? OR CAST(p.id AS TEXT) = ?
    LIMIT 20
`);
function searchPlayersByNameOrId(likeTerm, exactId) {
    return searchPlayersByNameOrIdStmt.all(likeTerm, exactId);
}

// --- players: read (incoming.js) ---

// Arity varies per call (ids length), prepared fresh each call.
function getPlayerStatsByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`
        SELECT p.id, p.name, p.level, p.has_intel,
               p.race_speed, p.race_attack, p.race_defense,
               p.physics, p.mathematics, p.energy,
               a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id IN (${placeholders})
    `).all(...ids);
}

const STAT_COLS = `race_attack, race_defense, physics, mathematics, science_level, level, has_intel, intel_updated_at`;

const getPlayerCombatStatsByIdStmt = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE id = ?`);
function getPlayerCombatStatsById(id) {
    return getPlayerCombatStatsByIdStmt.get(id);
}

// Consolidates incoming.js's attachWinChances enemy-by-name fallback and its per-defender
// statStmt loop (byte-identical SQL in the original code — see Global Constraints exception #2).
const getPlayerCombatStatsByNameStmt = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ?`);
function getPlayerCombatStatsByName(name) {
    return getPlayerCombatStatsByNameStmt.get(name);
}

const getPlayerWithAllianceByNameLowerStmt = db.prepare(`
    SELECT p.id, p.name, p.level, p.has_intel, p.race_speed, p.race_attack, p.race_defense,
           p.physics, p.mathematics, p.energy, a.tag AS alliance_tag
    FROM players p LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE LOWER(p.name) = ?
`);
function getPlayerWithAllianceByNameLower(name) {
    return getPlayerWithAllianceByNameLowerStmt.get(name);
}

// --- players: read (interceptors.js) ---

const getPlayerAllianceIdByNameStmt = db.prepare(`SELECT alliance_id FROM players WHERE name = ? COLLATE NOCASE`);
function getPlayerAllianceIdByName(name) {
    return getPlayerAllianceIdByNameStmt.get(name);
}

// Two fixed variants of interceptors.js's dynamic WHERE clause for the `homes` query —
// same pattern as fleets.js's getInterceptFleetsByAlliance/getInterceptFleetsByActiveUsers.
const getInterceptHomesByAllianceStmt = db.prepare(`
    SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
           COALESCE(p.home_planet_index, 1) AS launch_planet,
           ams.production_points, ams.astro_dollars,
           s.x AS sx, s.y AS sy
    FROM players p
    JOIN alliance_member_stats ams ON ams.player_id = p.id
    JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
    WHERE p.alliance_id = @aid AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptHomesByAlliance(allianceId) {
    return getInterceptHomesByAllianceStmt.all({ aid: allianceId });
}

const getInterceptHomesByActiveUsersStmt = db.prepare(`
    SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
           COALESCE(p.home_planet_index, 1) AS launch_planet,
           ams.production_points, ams.astro_dollars,
           s.x AS sx, s.y AS sy
    FROM players p
    JOIN alliance_member_stats ams ON ams.player_id = p.id
    JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
    WHERE LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1) AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptHomesByActiveUsers() {
    return getInterceptHomesByActiveUsersStmt.all({});
}

// --- players / player_name_history: write (game API integration) ---

const getPlayerNameStmt = db.prepare(`SELECT name FROM players WHERE id = ?`);
function getPlayerName(id) {
    return getPlayerNameStmt.get(id);
}

const recordNameChangeStmt = db.prepare(`INSERT INTO player_name_history (player_id, old_name) VALUES (?, ?)`);
function recordNameChange(playerId, oldName) {
    recordNameChangeStmt.run(playerId, oldName);
}

// Logs the OLD name to player_name_history before a write changes it — the within-round
// complement to round-archive.js's across-round alias tracking. Call this immediately
// before any statement that sets players.name, for every source (scrape or API).
function recordNameChangeIfDifferent(id, newName) {
    if (!newName) return;
    const current = getPlayerName(id);
    if (current && current.name && current.name !== newName) {
        recordNameChange(id, current.name);
    }
}

// Read-only snapshot of a player's currently-stored race_* columns (plus has_intel) — used
// to enforce the "race is write-once per round" rule at the route layer (see
// upsertPlayerFromApiDetail's caller in sync.js). has_intel is included deliberately: the
// race_* columns default to 0 (not NULL) for every freshly-created player row, so a plain
// "is this column non-null" test would treat every player as already having race on record
// and lock in zeros forever. has_intel is only ever set to 1 alongside a genuine race write
// (both are governed by the same CASE guard), so it is the real "race is on record yet?"
// signal — not the raw column value.
const getPlayerRaceValuesStmt = db.prepare(`
    SELECT race_growth, race_science, race_culture, race_production, race_speed,
           race_attack, race_defense, race_trader, race_sul, has_intel
    FROM players WHERE id = ?
`);
function getPlayerRaceValues(id) {
    return getPlayerRaceValuesStmt.get(id);
}

// ListPlayer-sourced upsert: writes only the fields the bulk list actually returns. Never
// touches home_planet_id/total_*/idle_time/eco_bonus/intel columns — the bulk list has no
// data for them, and this must not risk nulling out what a deeper scrape already knows.
// joined/country/ranking use COALESCE(excluded.x, players.x): ListPlayer can legitimately
// omit these per-player (unranked, no recorded join date) and a straight overwrite would
// silently null out a previously-known value (same pattern as Plan 1's systems fix and
// upsertPlayerFromApiDetail below). name/alliance_id/level/points/is_active_player are
// expected to always be present in a ListPlayer response, so they stay straight overwrites.
const upsertPlayerFromApiListStmt = db.prepare(`
    INSERT INTO players (id, name, alliance_id, level, points, ranking, country, is_active_player, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, alliance_id=excluded.alliance_id, level=excluded.level,
        points=excluded.points,
        ranking=COALESCE(excluded.ranking, players.ranking),
        country=COALESCE(excluded.country, players.country),
        is_active_player=excluded.is_active_player,
        joined=COALESCE(excluded.joined, players.joined),
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlayerFromApiList(id, name, allianceId, level, points, ranking, country, isActivePlayer, joined) {
    upsertPlayerFromApiListStmt.run(id, name, allianceId, level, points, ranking, country, isActivePlayer, joined);
}

// Player/{id}-sourced upsert: same has_intel-CASE-guard shape as upsertPlayerFull above,
// a SEPARATE statement (not shared) that never touches home_planet_id/total_*/idle_time/
// eco_bonus — those are scrape-only, the API detail response has no data for them.
const upsertPlayerFromApiDetailStmt = db.prepare(`
    INSERT INTO players (
        id, name, alliance_id, level, points, ranking, country,
        is_active_player, joined, logins, last_activity_at, last_login_at, resigned_at,
        number_of_battles, battle_luckiness, multi_status, is_top_permanent_ranker,
        has_supporter_badge, supporter_type,
        biology, economy, energy, mathematics, physics, social, trade_revenue, artefact,
        race_growth, race_science, race_culture, race_production, race_speed, race_attack,
        race_defense, race_trader, race_sul, has_intel, intel_updated_at
    ) VALUES (
        @id, @name, @alliance_id, @level, @points, @ranking, @country,
        @is_active_player, @joined, @logins, @last_activity_at, @last_login_at, @resigned_at,
        @number_of_battles, @battle_luckiness, @multi_status, @is_top_permanent_ranker,
        @has_supporter_badge, @supporter_type,
        @biology, @economy, @energy, @mathematics, @physics, @social, @trade_revenue, @artefact,
        @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack,
        @race_defense, @race_trader, @race_sul, @has_intel,
        CASE WHEN @has_intel = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
    ) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, alliance_id=excluded.alliance_id, level=excluded.level,
        points=excluded.points, ranking=excluded.ranking, country=excluded.country,
        is_active_player=excluded.is_active_player, joined=excluded.joined, logins=excluded.logins,
        last_activity_at=excluded.last_activity_at, last_login_at=excluded.last_login_at,
        resigned_at=excluded.resigned_at, number_of_battles=excluded.number_of_battles,
        battle_luckiness=excluded.battle_luckiness, multi_status=excluded.multi_status,
        is_top_permanent_ranker=excluded.is_top_permanent_ranker,
        has_supporter_badge=excluded.has_supporter_badge, supporter_type=excluded.supporter_type,
        updated_at=CURRENT_TIMESTAMP,

        biology = CASE WHEN excluded.has_intel = 1 THEN excluded.biology ELSE players.biology END,
        economy = CASE WHEN excluded.has_intel = 1 THEN excluded.economy ELSE players.economy END,
        energy = CASE WHEN excluded.has_intel = 1 THEN excluded.energy ELSE players.energy END,
        mathematics = CASE WHEN excluded.has_intel = 1 THEN excluded.mathematics ELSE players.mathematics END,
        physics = CASE WHEN excluded.has_intel = 1 THEN excluded.physics ELSE players.physics END,
        social = CASE WHEN excluded.has_intel = 1 THEN excluded.social ELSE players.social END,
        trade_revenue = CASE WHEN excluded.has_intel = 1 THEN excluded.trade_revenue ELSE players.trade_revenue END,
        artefact = CASE WHEN excluded.has_intel = 1 THEN excluded.artefact ELSE players.artefact END,
        race_growth = CASE WHEN excluded.has_intel = 1 THEN excluded.race_growth ELSE players.race_growth END,
        race_science = CASE WHEN excluded.has_intel = 1 THEN excluded.race_science ELSE players.race_science END,
        race_culture = CASE WHEN excluded.has_intel = 1 THEN excluded.race_culture ELSE players.race_culture END,
        race_production = CASE WHEN excluded.has_intel = 1 THEN excluded.race_production ELSE players.race_production END,
        race_speed = CASE WHEN excluded.has_intel = 1 THEN excluded.race_speed ELSE players.race_speed END,
        race_attack = CASE WHEN excluded.has_intel = 1 THEN excluded.race_attack ELSE players.race_attack END,
        race_defense = CASE WHEN excluded.has_intel = 1 THEN excluded.race_defense ELSE players.race_defense END,
        race_trader = CASE WHEN excluded.has_intel = 1 THEN excluded.race_trader ELSE players.race_trader END,
        race_sul = CASE WHEN excluded.has_intel = 1 THEN excluded.race_sul ELSE players.race_sul END,
        intel_updated_at = CASE WHEN excluded.has_intel = 1 THEN CURRENT_TIMESTAMP ELSE players.intel_updated_at END,
        has_intel = CASE WHEN excluded.has_intel = 1 THEN 1 ELSE players.has_intel END
`);
function upsertPlayerFromApiDetail(player) {
    upsertPlayerFromApiDetailStmt.run(player);
}

// Floored at 6 hours: without a WHERE clause the queue never empties even once every
// player was scanned seconds ago, so the background sweep burns its budget forever
// re-scanning slow-changing fields instead of yielding once the roster is genuinely fresh.
const getStalePlayerIdsForApiScanStmt = db.prepare(`
    SELECT id FROM players
    WHERE last_api_scan_at IS NULL OR last_api_scan_at < datetime('now', '-6 hours')
    ORDER BY (last_api_scan_at IS NULL) DESC, last_api_scan_at ASC
    LIMIT ?
`);
function getStalePlayerIdsForApiScan(limit) {
    return getStalePlayerIdsForApiScanStmt.all(limit).map(r => r.id);
}

// Arity varies per call (ids length) — prepared fresh each call, same reasoning as
// systems.js's getSystemsByIds/alliances.js's deleteStaleAllianceMembers.
function markPlayersApiScanned(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE players SET last_api_scan_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
}

// Feeds the "Deep scan" button's status line — total roster size, how many are still
// stale by the SAME 6-hour floor getStalePlayerIdsForApiScan uses (so the count on screen
// never disagrees with what a claim would actually hand out), and when the most recent
// claim of any size last touched a row.
const getPlayerApiScanStatsStmt = db.prepare(`
    SELECT
        (SELECT COUNT(*) FROM players) as total,
        (SELECT COUNT(*) FROM players
            WHERE last_api_scan_at IS NULL OR last_api_scan_at < datetime('now', '-6 hours')) as stale,
        (SELECT MAX(last_api_scan_at) FROM players) as last_scan_at
`);
function getPlayerApiScanStats() {
    return getPlayerApiScanStatsStmt.get();
}

// --- players: read (discord-commands.js) ---

const suggestPlayersByQueryStmt = db.prepare(`
    SELECT p.name, a.tag
    FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
    WHERE p.name LIKE ? ORDER BY LENGTH(p.name) ASC LIMIT ?
`);
function suggestPlayersByQuery(likeTerm, limit) {
    return suggestPlayersByQueryStmt.all(likeTerm, limit);
}

const suggestPlayersTopByPointsStmt = db.prepare(`
    SELECT p.name, a.tag
    FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
    ORDER BY p.points DESC LIMIT ?
`);
function suggestPlayersTopByPoints(limit) {
    return suggestPlayersTopByPointsStmt.all(limit);
}

module.exports = {
    getWarRoomPlayers, getAllianceIntelPlayerIds, countPlayers, listPlayerIds, getFullPlayersDb,
    getAllianceTagForMembers, getVisionObservers, getPlayerWithPlanetCount,
    getPlayerLoginHistory, getPlayerLoginHeatmap,
    upsertPlayerBasic, getPlayerNameWithTag, getPlayerRestartCheck, playerExistsById, resetPlayerOnRestart,
    upsertPlayerFull, insertPlayerLogin, upsertAllianceMemberBasic, upsertPlayerNameOnly,
    getPlayerBiologyByName, getThreatPlayersByBiology, getThreatPlayersByScience,
    getPlayerTravelStatsByName, countUnaffiliatedIntelPlayers, listUnaffiliatedIntelPlayers,
    listAllianceIntelPlayers, getPlayerFullById, getPlayerFullByName,
    getAllianceOriginPlayersBrief, getAllianceOriginPlayersDetailed, getPlayerCombatStats,
    deleteAllPlayers, getPlayerIdByName, searchPlayersByNameOrId, getPlayerStatsByIds,
    getPlayerCombatStatsById, getPlayerCombatStatsByName, getPlayerWithAllianceByNameLower,
    getPlayerAllianceIdByName, getInterceptHomesByAlliance, getInterceptHomesByActiveUsers,
    suggestPlayersByQuery, suggestPlayersTopByPoints,
    getPlayerName, recordNameChange, recordNameChangeIfDifferent, getPlayerRaceValues,
    upsertPlayerFromApiList, upsertPlayerFromApiDetail,
    getStalePlayerIdsForApiScan, markPlayersApiScanned, getPlayerApiScanStats,
};
