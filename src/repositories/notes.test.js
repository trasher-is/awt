const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const notes = require('./notes');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('notes.test.js');

// Test getActiveNotesForOwner returns [] for an owner with no notes
const noNotes = notes.getActiveNotesForOwner(999);
ok('getActiveNotesForOwner returns [] for owner with no notes', Array.isArray(noNotes) && noNotes.length === 0);

// Insert a test user (owner) in app_users
db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES (?, ?)`).run('TestOwner', 'hash1');
const ownerRow = db.prepare(`SELECT id FROM app_users WHERE game_name = 'TestOwner'`).get();
const ownerId = ownerRow.id;

// Insert another user (author)
db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES (?, ?)`).run('TestAuthor', 'hash2');
const authorRow = db.prepare(`SELECT id FROM app_users WHERE game_name = 'TestAuthor'`).get();
const authorId = authorRow.id;

// Test insertNote creates a row; getActiveNotesForOwner returns it
const noteId = notes.insertNote(ownerId, authorId, 'Test note text', null, 0);
ok('insertNote returns a row id', typeof noteId === 'number' && noteId > 0);

const activeNotes = notes.getActiveNotesForOwner(ownerId);
ok('getActiveNotesForOwner returns inserted note', activeNotes.length === 1 && activeNotes[0].id === noteId && activeNotes[0].text === 'Test note text');

// Test that author_name is populated for notes from a different author
ok('getActiveNotesForOwner includes author_name from LEFT JOIN', activeNotes[0].author_name === 'TestAuthor');

// Test a note with done=1 does NOT appear in getActiveNotesForOwner results
const doneNoteId = notes.insertNote(ownerId, authorId, 'Already done', null, 0);
notes.markNoteDone(doneNoteId, ownerId);
const afterDone = notes.getActiveNotesForOwner(ownerId);
ok('getActiveNotesForOwner excludes done notes', afterDone.length === 1 && afterDone[0].id === noteId);

// Test markNoteDone returns 1 for existing note owned by user
const markResult = notes.markNoteDone(noteId, ownerId);
ok('markNoteDone returns 1 for existing note owned by user', markResult === 1);

// Test markNoteDone returns 0 for note that doesn't exist
const notFoundResult = notes.markNoteDone(99999, ownerId);
ok('markNoteDone returns 0 for non-existent note', notFoundResult === 0);

// Test markNoteDone returns 0 for note owned by someone else
const otherOwnerId = 99998;
const markOtherResult = notes.markNoteDone(noteId, otherOwnerId);
ok('markNoteDone returns 0 for note owned by different user', markOtherResult === 0);

// Test deleteNote returns 1 for existing note owned by user
const deleteNoteId = notes.insertNote(ownerId, authorId, 'Delete me', null, 0);
const deleteResult = notes.deleteNote(deleteNoteId, ownerId);
ok('deleteNote returns 1 for existing note owned by user', deleteResult === 1);

// Verify row is actually gone
const checkDeleted = db.prepare(`SELECT COUNT(*) c FROM user_notes WHERE id = ?`).get(deleteNoteId).c;
ok('deleteNote actually removes the row from DB', checkDeleted === 0);

// Test deleteNote returns 0 for non-existent note
const deleteNotFoundResult = notes.deleteNote(99999, ownerId);
ok('deleteNote returns 0 for non-existent note', deleteNotFoundResult === 0);

// Test deleteNote returns 0 for note owned by someone else
const deleteOtherNoteId = notes.insertNote(ownerId, authorId, 'Not mine', null, 0);
const deleteOtherResult = notes.deleteNote(deleteOtherNoteId, otherOwnerId);
ok('deleteNote returns 0 for note owned by different user', deleteOtherResult === 0);
const stillExists = db.prepare(`SELECT COUNT(*) c FROM user_notes WHERE id = ?`).get(deleteOtherNoteId).c;
ok('deleteNote does not remove a note it did not have permission to delete', stillExists === 1);

// Test getDueReminders - need to insert owner with discord_id
db.prepare(`INSERT INTO app_users (game_name, password_hash, discord_id) VALUES (?, ?, ?)`).run('ReminderOwner', 'hash3', 'discord-123');
const reminderOwnerRow = db.prepare(`SELECT id FROM app_users WHERE game_name = 'ReminderOwner'`).get();
const reminderOwnerId = reminderOwnerRow.id;

const now = new Date().toISOString();
const future = new Date(Date.now() + 3600000).toISOString();

// Create various reminder notes to test filtering
const dueReminder = notes.insertNote(reminderOwnerId, reminderOwnerId, 'Due reminder', future, 1);
const noReminderFlag = notes.insertNote(reminderOwnerId, reminderOwnerId, 'No remind_15', future, 0);
const noDueDate = notes.insertNote(reminderOwnerId, reminderOwnerId, 'No due date', null, 1);
const alreadyDone = notes.insertNote(reminderOwnerId, reminderOwnerId, 'Already done', future, 1);
notes.markNoteDone(alreadyDone, reminderOwnerId);

const reminders = notes.getDueReminders();
ok('getDueReminders returns note with remind_15=1, done=0, reminded_at NULL, due_at not null',
    reminders.length === 1 && reminders[0].id === dueReminder);

ok('getDueReminders result includes required fields',
    reminders[0].id && reminders[0].text === 'Due reminder' && reminders[0].due_at && reminders[0].discord_id === 'discord-123' && reminders[0].game_name === 'ReminderOwner');

// Test markReminderSent
notes.markReminderSent(dueReminder);
const afterReminder = notes.getDueReminders();
ok('markReminderSent followed by getDueReminders no longer returns that note', afterReminder.length === 0);

// Verify the reminded_at was actually set
const checkReminded = db.prepare(`SELECT reminded_at FROM user_notes WHERE id = ?`).get(dueReminder).reminded_at;
ok('markReminderSent sets reminded_at timestamp', checkReminded !== null);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
