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

module.exports = {
    getCoveringRow, upsertCovering, upsertMessageRef, getMessageRef,
    getLastOntimeRow, updateLastOntime
};
