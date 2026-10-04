const db = require('../database');

// --- defence_choices: "I'll land before / after" from the Defence panel ---

const listStmt = db.prepare(`SELECT game_name, role, option_json, updated_at FROM defence_choices WHERE alert_key = ? ORDER BY updated_at`);
function listChoices(alertKey) {
    return listStmt.all(alertKey).map(r => {
        let option = null;
        try { option = r.option_json ? JSON.parse(r.option_json) : null; } catch (e) { option = null; }
        return { name: r.game_name, role: r.role, option, updatedAt: r.updated_at };
    });
}

const setStmt = db.prepare(`
    INSERT INTO defence_choices (alert_key, game_name, role, option_json, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(alert_key, game_name) DO UPDATE SET
        role = excluded.role, option_json = excluded.option_json, updated_at = CURRENT_TIMESTAMP
`);
function setChoice(alertKey, gameName, role, option) {
    setStmt.run(alertKey, gameName, role, option ? JSON.stringify(option) : null);
}

const removeStmt = db.prepare(`DELETE FROM defence_choices WHERE alert_key = ? AND LOWER(game_name) = LOWER(?)`);
function removeChoice(alertKey, gameName) {
    return removeStmt.run(alertKey, gameName).changes > 0;
}

// Round reset: the keys mean nothing against the next round's map (same as incoming_msgs).
const deleteAllStmt = db.prepare(`DELETE FROM defence_choices`);
function deleteAllChoices() {
    deleteAllStmt.run();
}

module.exports = { listChoices, setChoice, removeChoice, deleteAllChoices };
