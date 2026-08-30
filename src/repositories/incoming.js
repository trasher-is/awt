const db = require('../database');

const getCoveringRowStmt = db.prepare(`SELECT covering FROM incoming_msgs WHERE alert_key = ?`);
function getCoveringRow(alertKey) {
    return getCoveringRowStmt.get(alertKey);
}

const upsertCoveringStmt = db.prepare(`
    INSERT INTO incoming_msgs (alert_key, covering) VALUES (?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET covering = excluded.covering, updated_at = CURRENT_TIMESTAMP
`);
function upsertCovering(alertKey, covering) {
    upsertCoveringStmt.run(alertKey, covering);
}

const upsertMessageRefStmt = db.prepare(`
    INSERT INTO incoming_msgs (alert_key, channel_id, message_id) VALUES (?, ?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertMessageRef(alertKey, channelId, messageId) {
    upsertMessageRefStmt.run(alertKey, channelId, messageId);
}

const getMessageRefStmt = db.prepare(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`);
function getMessageRef(alertKey) {
    return getMessageRefStmt.get(alertKey);
}

const getLastOntimeRowStmt = db.prepare(`SELECT last_ontime FROM incoming_msgs WHERE alert_key = ?`);
function getLastOntimeRow(alertKey) {
    return getLastOntimeRowStmt.get(alertKey);
}

const updateLastOntimeStmt = db.prepare(`UPDATE incoming_msgs SET last_ontime = ? WHERE alert_key = ?`);
function updateLastOntime(alertKey, lastOntime) {
    updateLastOntimeStmt.run(lastOntime, alertKey);
}

// alert_key is system:planet:attacker — an identity that only means anything against the
// current round's map, so a round reset must clear it or the next round's first genuinely
// new incoming at the same coordinates would be treated as an edit of a stale message.
const deleteAllIncomingMsgsStmt = db.prepare(`DELETE FROM incoming_msgs`);
function deleteAllIncomingMsgs() {
    deleteAllIncomingMsgsStmt.run();
}

// incoming_alerts (fleet_id-keyed) was superseded by incoming_msgs (alert_key-keyed) — no
// other code in this repo still reads or writes it. Kept clearable here anyway: whatever
// wrote its existing rows made them round-scoped too, and leftover rows should not survive
// a reset just because the table itself is otherwise dead.
const deleteAllIncomingAlertsStmt = db.prepare(`DELETE FROM incoming_alerts`);
function deleteAllIncomingAlerts() {
    deleteAllIncomingAlertsStmt.run();
}

module.exports = {
    getCoveringRow, upsertCovering, upsertMessageRef, getMessageRef,
    getLastOntimeRow, updateLastOntime,
    deleteAllIncomingMsgs, deleteAllIncomingAlerts,
};
