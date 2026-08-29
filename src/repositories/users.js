const db = require('../database');

// --- app_users: read ---

// Consolidates discord_bot.js's cover-button handler and handleLink's "already linked?"
// check — both used byte-identical SQL. See Global Constraints dedup #1.
const getUserByDiscordIdStmt = db.prepare(`SELECT game_name FROM app_users WHERE discord_id = ?`);
function getUserByDiscordId(discordId) {
    return getUserByDiscordIdStmt.get(discordId);
}

// Consolidates discord_bot.js's !bio and !plan commands — both used byte-identical SQL.
// See Global Constraints dedup #2.
const getUserByDiscordNameStmt = db.prepare(`SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`);
function getUserByDiscordName(discordName, atDiscordName) {
    return getUserByDiscordNameStmt.get(discordName, atDiscordName);
}

const getUserAllianceTagByDiscordNameStmt = db.prepare(`
    SELECT a.tag
    FROM app_users u
    JOIN players p ON u.game_name = p.name
    JOIN alliances a ON p.alliance_id = a.id
    WHERE LOWER(u.discord_name) = ? OR LOWER(u.discord_name) = ?
`);
function getUserAllianceTagByDiscordName(discordName, atDiscordName) {
    return getUserAllianceTagByDiscordNameStmt.get(discordName, atDiscordName);
}

const getUserMentionByGameNameStmt = db.prepare(`
    SELECT discord_id FROM app_users WHERE LOWER(game_name) = ? AND discord_id IS NOT NULL
`);
function getUserMentionByGameName(gameNameLower) {
    return getUserMentionByGameNameStmt.get(gameNameLower);
}

const getActiveRecipientsExcludingAdminStmt = db.prepare(`
    SELECT id, game_name FROM app_users
    WHERE is_active = 1 AND (game_name != 'admin' OR id = ?)
    ORDER BY game_name COLLATE NOCASE
`);
function getActiveRecipientsExcludingAdmin(sessionUserId) {
    return getActiveRecipientsExcludingAdminStmt.all(sessionUserId);
}

// Arity varies per call (ids length), so prepared fresh each call — same reasoning as
// systems.js's getSystemsByIds.
function getValidActiveUserIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id FROM app_users WHERE is_active = 1 AND id IN (${placeholders})`).all(...ids);
}

const getUserByGameNameStmt = db.prepare(`SELECT * FROM app_users WHERE game_name = ?`);
function getUserByGameName(gameName) {
    return getUserByGameNameStmt.get(gameName);
}

const getUserAllianceIdBridgeStmt = db.prepare(`
    SELECT p.alliance_id AS alliance_id
    FROM app_users u
    JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
    WHERE u.id = ?
`);
function getUserAllianceIdBridge(userId) {
    return getUserAllianceIdBridgeStmt.get(userId);
}

const getUserByIdStmt = db.prepare(`SELECT id, game_name, discord_id, discord_name FROM app_users WHERE id = ?`);
function getUserById(id) {
    return getUserByIdStmt.get(id);
}

const getAllUsersWithIdleStmt = db.prepare(`
    SELECT u.id, u.game_name, u.role, u.is_active, u.discord_name, p.idle_time
    FROM app_users u
    LEFT JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
    ORDER BY u.id ASC
`);
function getAllUsersWithIdle() {
    return getAllUsersWithIdleStmt.all();
}

// Consolidates admin.js's edit-name/delete-user/change-role/change-password load queries —
// all four used byte-identical SQL. See Global Constraints dedup #3.
const getUserNameByIdStmt = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`);
function getUserNameById(id) {
    return getUserNameByIdStmt.get(id);
}

// NOT the same as getUserById above — this one omits `id` from the column list. See
// Global Constraints: these two must stay distinct.
const getUserDiscordInfoByIdStmt = db.prepare(`SELECT game_name, discord_id, discord_name FROM app_users WHERE id = ?`);
function getUserDiscordInfoById(id) {
    return getUserDiscordInfoByIdStmt.get(id);
}

const getUserActiveStatusByIdStmt = db.prepare(`SELECT game_name, is_active FROM app_users WHERE id = ?`);
function getUserActiveStatusById(id) {
    return getUserActiveStatusByIdStmt.get(id);
}

const getAdminPasswordHashStmt = db.prepare(`SELECT password_hash FROM app_users WHERE game_name = 'admin'`);
function getAdminPasswordHash() {
    return getAdminPasswordHashStmt.get();
}

const getActiveMemberNamesStmt = db.prepare(`SELECT game_name FROM app_users WHERE is_active = 1`);
function getActiveMemberNames() {
    return getActiveMemberNamesStmt.all();
}

// --- app_users: write ---

const updateUserGameNameStmt = db.prepare(`UPDATE app_users SET game_name = ? WHERE id = ?`);
function updateUserGameName(id, newName) {
    updateUserGameNameStmt.run(newName, id);
}

const deleteUserStmt = db.prepare(`DELETE FROM app_users WHERE id = ?`);
function deleteUser(id) {
    deleteUserStmt.run(id);
}

const createUserStmt = db.prepare(`INSERT INTO app_users (game_name, password_hash, role, discord_name) VALUES (?, ?, ?, ?)`);
function createUser(gameName, passwordHash, role, discordName) {
    createUserStmt.run(gameName, passwordHash, role, discordName);
}

const updateUserDiscordNameStmt = db.prepare(`UPDATE app_users SET discord_name = ? WHERE id = ?`);
function updateUserDiscordName(id, discordName) {
    updateUserDiscordNameStmt.run(discordName, id);
}

const clearUserDiscordFieldsStmt = db.prepare(`UPDATE app_users SET discord_id = NULL, discord_name = NULL WHERE id = ?`);
function clearUserDiscordFields(id) {
    clearUserDiscordFieldsStmt.run(id);
}

const setUserActiveStmt = db.prepare(`UPDATE app_users SET is_active = ? WHERE id = ?`);
function setUserActive(id, isActive) {
    setUserActiveStmt.run(isActive, id);
}

const setUserRoleStmt = db.prepare(`UPDATE app_users SET role = ? WHERE id = ?`);
function setUserRole(id, role) {
    setUserRoleStmt.run(role, id);
}

const setUserPasswordHashStmt = db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`);
function setUserPasswordHash(id, hash) {
    setUserPasswordHashStmt.run(hash, id);
}

const updateUserDiscordLinkStmt = db.prepare(`UPDATE app_users SET discord_id = ?, discord_name = ? WHERE id = ?`);
function updateUserDiscordLink(discordId, discordName, userId) {
    updateUserDiscordLinkStmt.run(discordId, discordName, userId);
}

const banUserStmt = db.prepare(`UPDATE app_users SET is_active = 0 WHERE id = ?`);
function banUser(id) {
    banUserStmt.run(id);
}

// --- discord_link_codes ---

// Consolidates discord_bot.js's handleLink sweep and auth.js's /link-code mint transaction
// — both used byte-identical SQL. See Global Constraints dedup #4. The caller in
// discord_bot.js wraps its own call in try/catch (unchanged) — this function has none,
// same as every other thin wrapper in this codebase.
const deleteExpiredLinkCodesStmt = db.prepare(`DELETE FROM discord_link_codes WHERE expires_at < datetime('now')`);
function deleteExpiredLinkCodes() {
    deleteExpiredLinkCodesStmt.run();
}

const getLinkCodeWithUserStmt = db.prepare(`
    SELECT c.code, c.user_id, c.used_at, c.expires_at, u.game_name, u.discord_id
    FROM discord_link_codes c
    JOIN app_users u ON u.id = c.user_id
    WHERE c.code = ?
`);
function getLinkCodeWithUser(code) {
    return getLinkCodeWithUserStmt.get(code);
}

// Consolidates discord_bot.js's "already linked to you" short-circuit and the real link
// commit inside a transaction — both used byte-identical SQL. See Global Constraints
// dedup #5.
const markLinkCodeUsedStmt = db.prepare(`UPDATE discord_link_codes SET used_at = CURRENT_TIMESTAMP, used_by_discord_id = ? WHERE code = ?`);
function markLinkCodeUsed(discordId, code) {
    markLinkCodeUsedStmt.run(discordId, code);
}

const mintLinkCodeStmt = db.prepare(`INSERT INTO discord_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`);
function mintLinkCode(code, userId, expiresAt) {
    mintLinkCodeStmt.run(code, userId, expiresAt);
}

// NOT the same as deleteLinkCodesByUserId below — this one filters on used_at IS NULL.
// See Global Constraints: these two must stay distinct.
const deleteUnusedLinkCodesForUserStmt = db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ? AND used_at IS NULL`);
function deleteUnusedLinkCodesForUser(userId) {
    deleteUnusedLinkCodesForUserStmt.run(userId);
}

const deleteLinkCodesByUserIdStmt = db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ?`);
function deleteLinkCodesByUserId(userId) {
    deleteLinkCodesByUserIdStmt.run(userId);
}

module.exports = {
    getUserByDiscordId, getUserByDiscordName, getUserAllianceTagByDiscordName,
    getUserMentionByGameName, getActiveRecipientsExcludingAdmin, getValidActiveUserIds,
    getUserByGameName, getUserAllianceIdBridge, getUserById, getAllUsersWithIdle,
    getUserNameById, getUserDiscordInfoById, getUserActiveStatusById, getAdminPasswordHash,
    getActiveMemberNames,
    updateUserGameName, deleteUser, createUser, updateUserDiscordName, clearUserDiscordFields,
    setUserActive, setUserRole, setUserPasswordHash, updateUserDiscordLink, banUser,
    deleteExpiredLinkCodes, getLinkCodeWithUser, markLinkCodeUsed, mintLinkCode,
    deleteUnusedLinkCodesForUser, deleteLinkCodesByUserId,
};
