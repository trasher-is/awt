const db = require('../database');

const getActiveNotesForOwnerStmt = db.prepare(`
    SELECT n.id, n.text, n.due_at, n.remind_15, n.done, n.done_at, n.created_at,
           a.game_name AS author_name
    FROM user_notes n
    LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
    WHERE n.owner_id = ? AND n.done = 0
    ORDER BY (n.due_at IS NULL), n.due_at ASC, n.created_at ASC
`);
function getActiveNotesForOwner(ownerId) {
    return getActiveNotesForOwnerStmt.all(ownerId);
}

const insertNoteStmt = db.prepare(`
    INSERT INTO user_notes (owner_id, author_id, text, due_at, remind_15) VALUES (?, ?, ?, ?, ?)
`);
function insertNote(ownerId, authorId, text, dueAt, remind15) {
    return insertNoteStmt.run(ownerId, authorId, text, dueAt, remind15).lastInsertRowid;
}

const markNoteDoneStmt = db.prepare(`
    UPDATE user_notes SET done = 1, done_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
`);
function markNoteDone(id, ownerId) {
    return markNoteDoneStmt.run(id, ownerId).changes;
}

const deleteNoteStmt = db.prepare(`DELETE FROM user_notes WHERE id = ? AND owner_id = ?`);
function deleteNote(id, ownerId) {
    return deleteNoteStmt.run(id, ownerId).changes;
}

const getDueRemindersStmt = db.prepare(`
    SELECT n.id, n.text, n.due_at, u.discord_id, u.game_name, a.game_name AS author_name
    FROM user_notes n
    JOIN app_users u ON u.id = n.owner_id
    LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
    WHERE n.done = 0 AND n.remind_15 = 1 AND n.reminded_at IS NULL AND n.due_at IS NOT NULL
`);
function getDueReminders() {
    return getDueRemindersStmt.all();
}

const markReminderSentStmt = db.prepare(`UPDATE user_notes SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?`);
function markReminderSent(id) {
    markReminderSentStmt.run(id);
}

module.exports = {
    getActiveNotesForOwner, insertNote, markNoteDone, deleteNote,
    getDueReminders, markReminderSent
};
