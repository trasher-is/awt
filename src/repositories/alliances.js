const db = require('../database');

// --- alliances: read ---

const getWarRoomAllianceIntelTagsStmt = db.prepare(`
    SELECT DISTINCT a.id, a.tag
    FROM alliances a
    JOIN players p ON p.alliance_id = a.id
    WHERE p.has_intel = 1
    ORDER BY a.tag ASC
`);
function getWarRoomAllianceIntelTags() {
    return getWarRoomAllianceIntelTagsStmt.all();
}

const countAlliancesStmt = db.prepare(`SELECT COUNT(*) as count FROM alliances`);
function countAlliances() {
    return countAlliancesStmt.get().count;
}

const getWarRoomAlliancesStmt = db.prepare(`
    SELECT a.id, a.tag, a.name, COUNT(p.id) as active_members_count, MAX(p.updated_at) as last_scan_time
    FROM alliances a
    JOIN players p ON p.alliance_id = a.id
    GROUP BY a.id, a.tag, a.name
    HAVING COUNT(p.id) >= 1
    ORDER BY COUNT(p.id) DESC, a.tag ASC
`);
function getWarRoomAlliances() {
    return getWarRoomAlliancesStmt.all();
}

const searchAlliancesByTagOrNameStmt = db.prepare(`
    SELECT id, name, tag, full_name, member_count
    FROM alliances
    WHERE name LIKE ? OR tag LIKE ? OR CAST(id AS TEXT) = ?
    LIMIT 20
`);
function searchAlliancesByTagOrName(likeTerm, exactTerm) {
    return searchAlliancesByTagOrNameStmt.all(likeTerm, likeTerm, exactTerm);
}

// --- alliances: write ---

// System-scan upsert: touches updated_at on conflict. NOT the same statement as
// upsertAllianceTagOnly below — see Global Constraints.
const upsertAllianceBasicStmt = db.prepare(`
    INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceBasic(id, tag, name) {
    upsertAllianceBasicStmt.run(id, tag, name);
}

// Player-profile-scan upsert: does NOT touch updated_at on conflict. NOT the same
// statement as upsertAllianceBasic above — see Global Constraints.
const upsertAllianceTagOnlyStmt = db.prepare(`
    INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag
`);
function upsertAllianceTagOnly(id, tag, name) {
    upsertAllianceTagOnlyStmt.run(id, tag, name);
}

const upsertAllianceFullStmt = db.prepare(`
    INSERT INTO alliances (id, name, tag, leader_id, ranking, points_current)
    VALUES (@id, @name, @tag, @leader_id, @ranking, @points)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        tag=excluded.tag,
        leader_id=excluded.leader_id,
        ranking=excluded.ranking,
        points_current=excluded.points_current,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceFull(alliance) {
    upsertAllianceFullStmt.run(alliance);
}

// A fourth, distinct alliance upsert — sourced from Alliance/search, not a scrape. NOT the
// same as upsertAllianceBasic/upsertAllianceTagOnly/upsertAllianceFull: this is the only
// one that writes full_name/member_count, and it does not touch leader_id/ranking/points
// (Alliance/search's response has no such fields).
const upsertAllianceFromApiSearchStmt = db.prepare(`
    INSERT INTO alliances (id, name, tag, full_name, member_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        tag=excluded.tag,
        full_name=excluded.full_name,
        member_count=excluded.member_count,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceFromApiSearch(id, name, tag, fullName, memberCount) {
    upsertAllianceFromApiSearchStmt.run(id, name, tag, fullName, memberCount);
}

const deleteAllAlliancesStmt = db.prepare(`DELETE FROM alliances`);
function deleteAllAlliances() {
    deleteAllAlliancesStmt.run();
}

// --- alliance_broadcasts ---

const insertBroadcastStmt = db.prepare(`
    INSERT INTO alliance_broadcasts (title, message, author_name, display_time)
    VALUES (?, ?, ?, ?)
`);
function insertBroadcast(title, message, authorName, displayTime) {
    insertBroadcastStmt.run(title, message, authorName, displayTime);
}

const getBroadcastsStmt = db.prepare(`
    SELECT id, title, message, author_name, display_time
    FROM alliance_broadcasts
    ORDER BY id DESC
`);
function getBroadcasts() {
    return getBroadcastsStmt.all();
}

const updateBroadcastStmt = db.prepare(`
    UPDATE alliance_broadcasts
    SET title = ?, message = ?, author_name = ?, display_time = ?
    WHERE id = ?
`);
function updateBroadcast(title, message, authorName, displayTime, id) {
    updateBroadcastStmt.run(title, message, authorName, displayTime, id);
}

const deleteBroadcastStmt = db.prepare(`DELETE FROM alliance_broadcasts WHERE id = ?`);
function deleteBroadcast(id) {
    deleteBroadcastStmt.run(id);
}

// --- alliance_member_stats: read ---

const getAllianceMemberStatIdsStmt = db.prepare(`SELECT player_id FROM alliance_member_stats`);
function getAllianceMemberStatIds() {
    return getAllianceMemberStatIdsStmt.all();
}

const getTradeAnalysisRowsStmt = db.prepare(`
    SELECT p.name,
           ams.production_rate,
           ams.astro_dollars,
           ams.production_points,
           p.trade_partners
    FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
`);
function getTradeAnalysisRows() {
    return getTradeAnalysisRowsStmt.all();
}

const getAllianceStatsForArchiveStmt = db.prepare(`
    SELECT s.*, p.name as player_name
    FROM alliance_member_stats s
    LEFT JOIN players p ON s.player_id = p.id
    ORDER BY s.player_id ASC
`);
function getAllianceStatsForArchive() {
    return getAllianceStatsForArchiveStmt.all();
}

const getTradersStmt = db.prepare(`
    SELECT p.name
    FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
    WHERE p.has_intel = 1 AND p.race_trader > 0
`);
function getTraders() {
    return getTradersStmt.all();
}

const getMembersWithStatsStmt = db.prepare(`
    SELECT p.name, p.has_intel, p.race_trader,
           ams.hoarded_au, ams.astro_dollars, ams.production_points, ams.production_rate
    FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
    ORDER BY p.name COLLATE NOCASE ASC
`);
function getMembersWithStats() {
    return getMembersWithStatsStmt.all();
}

const getCanonicalNameFromStatsStmt = db.prepare(`
    SELECT p.name FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
    WHERE p.name = ? COLLATE NOCASE LIMIT 1
`);
function getCanonicalNameFromStats(name) {
    return getCanonicalNameFromStatsStmt.get(name);
}

// --- alliance_member_stats: write ---

const upsertHoardedAuStmt = db.prepare(`
    INSERT INTO alliance_member_stats (player_id, hoarded_au, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET hoarded_au = excluded.hoarded_au, updated_at = CURRENT_TIMESTAMP
`);
function upsertHoardedAu(playerId, value) {
    upsertHoardedAuStmt.run(playerId, value);
}

const upsertAllianceMemberStatsStmt = db.prepare(`
    INSERT INTO alliance_member_stats (
        player_id, planets_text, next_culture_at, science_rate, culture_rate, production_rate,
        astro_dollars, production_points, artefact, level_text, cv_limit_text,
        economy, energy, mathematics, physics, population, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET
        planets_text=excluded.planets_text,
        next_culture_at=excluded.next_culture_at,
        science_rate=excluded.science_rate,
        culture_rate=excluded.culture_rate,
        production_rate=excluded.production_rate,
        astro_dollars=excluded.astro_dollars,
        production_points=excluded.production_points,
        artefact=excluded.artefact,
        level_text=excluded.level_text,
        cv_limit_text=excluded.cv_limit_text,
        economy=excluded.economy,
        energy=excluded.energy,
        mathematics=excluded.mathematics,
        physics=excluded.physics,
        population=excluded.population,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceMemberStats(playerId, planetsText, nextCultureAt, scienceRate, cultureRate, productionRate, astroDollars, productionPoints, artefact, levelText, cvLimitText, economy, energy, mathematics, physics, population) {
    upsertAllianceMemberStatsStmt.run(
        playerId, planetsText, nextCultureAt, scienceRate, cultureRate, productionRate,
        astroDollars, productionPoints, artefact, levelText, cvLimitText,
        economy, energy, mathematics, physics, population
    );
}

// Arity varies per call (ids length), so prepared fresh each call — same reasoning as
// systems.js's getSystemsByIds.
function deleteStaleAllianceMembers(ids) {
    if (!ids.length) return { changes: 0 };
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`DELETE FROM alliance_member_stats WHERE player_id NOT IN (${placeholders})`).run(...ids);
}

module.exports = {
    getWarRoomAllianceIntelTags, countAlliances, getWarRoomAlliances,
    searchAlliancesByTagOrName, upsertAllianceFromApiSearch,
    upsertAllianceBasic, upsertAllianceTagOnly, upsertAllianceFull, deleteAllAlliances,
    insertBroadcast, getBroadcasts, updateBroadcast, deleteBroadcast,
    getAllianceMemberStatIds, getTradeAnalysisRows, getAllianceStatsForArchive,
    getTraders, getMembersWithStats, getCanonicalNameFromStats,
    upsertHoardedAu, upsertAllianceMemberStats, deleteStaleAllianceMembers,
};
