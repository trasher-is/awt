// Personal task/reminder notes — like a lightweight task manager, private to each
// recipient. A note may carry a due date/time (local, sent as a UTC ISO string) and an
// optional "remind 15 min before" flag; the reminder itself is delivered by discord_bot's
// scheduler (see checkNoteReminders) as a channel mention, independent of this route.
//
// A note can be assigned to any number of teammates: creating one with N recipients
// stores N independent rows (one per owner_id, all sharing the same author_id), so each
// person's copy has its own due/reminded/done state — marking yours done never touches
// anyone else's.
const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- RECIPIENT PICKER — active members you can assign a note to ---
// GET /hub-api/notes/recipients
router.get('/notes/recipients', requireAuth, (req, res) => {
    try {
        // The bootstrap 'admin' account isn't a real player — hide it, unless someone is
        // actually logged in as it (edge case), so it can still assign notes to itself.
        const rows = db.prepare(`
            SELECT id, game_name FROM app_users
            WHERE is_active = 1 AND (game_name != 'admin' OR id = ?)
            ORDER BY game_name COLLATE NOCASE
        `).all(req.session.userId);
        res.json({ success: true, users: rows });
    } catch (err) {
        console.error('[Notes] recipients lookup failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load members' });
    }
});

// --- LIST — active (not-done) notes for the logged-in user, soonest due date first ---
// GET /hub-api/notes
router.get('/notes', requireAuth, (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT n.id, n.text, n.due_at, n.remind_15, n.done, n.done_at, n.created_at,
                   a.game_name AS author_name
            FROM user_notes n
            LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
            WHERE n.owner_id = ? AND n.done = 0
            ORDER BY (n.due_at IS NULL), n.due_at ASC, n.created_at ASC
        `).all(req.session.userId);
        res.json({ success: true, notes: rows });
    } catch (err) {
        console.error('[Notes] list failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load notes' });
    }
});

// --- CREATE ---
// POST /hub-api/notes
// Body: { text, due_at (ISO string or null), remind_15 (bool), recipient_ids (int[], optional) }
// recipient_ids defaults to [self] — the plain personal-note case. Any ids that aren't
// active members are silently dropped; if that empties the list it falls back to self
// rather than creating an orphaned note.
router.post('/notes', requireAuth, (req, res) => {
    try {
        const text = String(req.body.text || '').trim();
        if (!text) return res.status(400).json({ success: false, error: 'Note text is required' });

        const dueAt = req.body.due_at ? new Date(req.body.due_at) : null;
        if (dueAt && isNaN(dueAt.getTime())) return res.status(400).json({ success: false, error: 'Invalid due date' });
        const remind15 = dueAt && req.body.remind_15 ? 1 : 0;

        let recipientIds = Array.isArray(req.body.recipient_ids)
            ? [...new Set(req.body.recipient_ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))]
            : [];
        if (recipientIds.length) {
            const placeholders = recipientIds.map(() => '?').join(',');
            const validIds = db.prepare(`SELECT id FROM app_users WHERE is_active = 1 AND id IN (${placeholders})`)
                .all(...recipientIds).map((r) => r.id);
            recipientIds = validIds;
        }
        if (!recipientIds.length) recipientIds = [req.session.userId];

        const insert = db.prepare(`
            INSERT INTO user_notes (owner_id, author_id, text, due_at, remind_15) VALUES (?, ?, ?, ?, ?)
        `);
        const insertAll = db.transaction((ids) => {
            const created = [];
            for (const ownerId of ids) {
                const info = insert.run(ownerId, req.session.userId, text, dueAt ? dueAt.toISOString() : null, remind15);
                created.push(info.lastInsertRowid);
            }
            return created;
        });
        const ids = insertAll(recipientIds);
        res.json({ success: true, ids, recipientCount: recipientIds.length });
    } catch (err) {
        console.error('[Notes] create failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save note' });
    }
});

// --- MARK DONE (hides it from the list) ---
// PATCH /hub-api/notes/:id/done
router.patch('/notes/:id/done', requireAuth, (req, res) => {
    try {
        const info = db.prepare(`
            UPDATE user_notes SET done = 1, done_at = CURRENT_TIMESTAMP
            WHERE id = ? AND owner_id = ?
        `).run(req.params.id, req.session.userId);
        if (info.changes === 0) return res.status(404).json({ success: false, error: 'Note not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Notes] mark-done failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to update note' });
    }
});

// --- DELETE ---
// DELETE /hub-api/notes/:id
router.delete('/notes/:id', requireAuth, (req, res) => {
    try {
        const info = db.prepare(`DELETE FROM user_notes WHERE id = ? AND owner_id = ?`).run(req.params.id, req.session.userId);
        if (info.changes === 0) return res.status(404).json({ success: false, error: 'Note not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Notes] delete failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to delete note' });
    }
});

module.exports = router;
