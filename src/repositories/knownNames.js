const db = require('../database');

// Names a member knows a player by, typed in by hand on the player's profile: another game,
// Discord, a name from before the game's own History page begins. Keyed by the player id,
// which is stable across rounds, so these survive a round reset.
const listStmt = db.prepare(`
    SELECT id, name, added_by, added_by_user_id, created_at
    FROM player_known_names WHERE player_id = ? ORDER BY name COLLATE NOCASE
`);
function listKnownNames(playerId) {
    return listStmt.all(playerId);
}

const getStmt = db.prepare(`SELECT * FROM player_known_names WHERE id = ? AND player_id = ?`);
function getKnownName(playerId, id) {
    return getStmt.get(id, playerId);
}

const addStmt = db.prepare(`
    INSERT INTO player_known_names (player_id, name, added_by, added_by_user_id)
    VALUES (?, ?, ?, ?) ON CONFLICT(player_id, name) DO NOTHING
`);
// False when this player already has that name on record.
function addKnownName(playerId, name, user) {
    return addStmt.run(playerId, name, user.gameName, user.id).changes > 0;
}

const deleteStmt = db.prepare(`DELETE FROM player_known_names WHERE id = ? AND player_id = ?`);
function deleteKnownName(playerId, id) {
    return deleteStmt.run(id, playerId).changes > 0;
}

module.exports = { listKnownNames, getKnownName, addKnownName, deleteKnownName };
