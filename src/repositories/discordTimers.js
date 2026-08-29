const db = require('../database');

const insertTimerStmt = db.prepare(`
    INSERT INTO discord_timers (discord_user_id, channel_id, label, due_at)
    VALUES (?, ?, ?, ?)
`);
function insertTimer(discordUserId, channelId, label, dueAt) {
    insertTimerStmt.run(discordUserId, channelId, label, dueAt);
}

const getDueTimersStmt = db.prepare(`
    SELECT id, discord_user_id, channel_id, label, due_at
    FROM discord_timers
    WHERE fired_at IS NULL AND due_at <= ?
    ORDER BY due_at ASC
    LIMIT 50
`);
function getDueTimers(nowIso) {
    return getDueTimersStmt.all(nowIso);
}

const markTimerFiredStmt = db.prepare(`UPDATE discord_timers SET fired_at = CURRENT_TIMESTAMP WHERE id = ?`);
function markTimerFired(id) {
    markTimerFiredStmt.run(id);
}

module.exports = { insertTimer, getDueTimers, markTimerFired };
