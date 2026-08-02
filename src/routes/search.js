const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- PLANET PLANS (META-DATA) ---

// Get all plans for a specific system
router.get('/plans/:systemId', requireAuth, (req, res) => {
    try {
        const plans = db.prepare(`
            SELECT p.planet_index, p.note, p.updated_at, u.game_name as author
            FROM planet_plans p
            LEFT JOIN app_users u ON p.author_id = u.id
            WHERE p.system_id = ?
        `).all(req.params.systemId);
        res.json({ success: true, plans });
    } catch (err) {
        console.error("[DB Error] Failed to fetch plans:", err);
        res.status(500).json({ error: 'Failed to fetch plans' });
    }
});

// Create or Update a plan (Upsert)
router.post('/plans', requireAuth, (req, res) => {
    const { system_id, planet_index, note } = req.body;
    const author_id = req.session.userId;

    if (!system_id || !planet_index || !note) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Removed the ON CONFLICT clause to stop overwriting old records
        db.prepare(`
            INSERT INTO planet_plans (system_id, planet_index, author_id, note)
            VALUES (?, ?, ?, ?)
        `).run(system_id, planet_index, author_id, note);

        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to save plan:", err);
        res.status(500).json({ error: 'Failed to save plan' });
    }
});

// Delete a plan
// Plans are attributed - author_id is stored on insert and the author's name is shown
// in the UI - but the delete used to remove every row for the coordinate regardless of
// who wrote it, so any logged-in account could wipe another member's notes. Deletion is
// now limited to the author, with admins still able to clear anything and orphaned rows
// (author since deleted, so author_id is NULL) removable by anyone.
router.delete('/plans/:systemId/:planetIndex', requireAuth, (req, res) => {
    try {
        const { systemId, planetIndex } = req.params;
        const isAdmin = req.session.role === 'admin';

        const result = isAdmin
            ? db.prepare(`DELETE FROM planet_plans WHERE system_id = ? AND planet_index = ?`)
                .run(systemId, planetIndex)
            : db.prepare(`
                DELETE FROM planet_plans
                WHERE system_id = ? AND planet_index = ? AND (author_id = ? OR author_id IS NULL)
              `).run(systemId, planetIndex, req.session.userId);

        if (result.changes === 0) {
            const stillThere = db.prepare(
                `SELECT 1 FROM planet_plans WHERE system_id = ? AND planet_index = ?`
            ).get(systemId, planetIndex);
            if (stillThere) {
                return res.status(403).json({ error: 'That plan was written by someone else. Ask them or an admin to remove it.' });
            }
        }

        res.json({ success: true, deleted: result.changes });
    } catch (err) {
        console.error("[DB Error] Failed to delete plan:", err);
        res.status(500).json({ error: 'Failed to delete plan' });
    }
});

// --- DATABASE SEARCH ENDPOINTS ---

// Search Players by Name or Exact ID
router.get('/search/player', requireAuth, (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ success: true, results: [] });

    try {
        const searchTerm = `%${q}%`;
        const query = db.prepare(`
            SELECT p.id, p.name, a.tag as alliance_tag
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.name LIKE ? OR CAST(p.id AS TEXT) = ?
            LIMIT 20
        `);

        // Pass the wildcard string for the LIKE, and the raw string for the exact ID match
        const results = query.all(searchTerm, q);

        // Also match names from earlier rounds. Someone typing a name they remember should
        // find the account, not an empty list — the id is what carries across a wipe, the
        // name is not. These are appended rather than merged in SQL so the current-name
        // matches stay first and the former name can be labelled as one.
        const seen = new Set(results.map(r => r.id));
        const former = db.prepare(`
            SELECT rp.player_id AS id, p.name, a.tag AS alliance_tag,
                   rp.name AS former_name, r.label AS former_round
            FROM round_players rp
            JOIN rounds r ON r.id = rp.round_id
            LEFT JOIN players p ON p.id = rp.player_id
            LEFT JOIN alliances a ON a.id = p.alliance_id
            WHERE rp.name LIKE ? AND p.id IS NOT NULL
            GROUP BY rp.player_id
            ORDER BY r.id DESC
            LIMIT 20
        `).all(searchTerm);

        for (const row of former) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            results.push(row);
            if (results.length >= 20) break;
        }

        res.json({ success: true, results });
    } catch (err) {
        console.error("[DB Error] Player search failed:", err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Search Systems by Name or Exact ID
router.get('/search/system', requireAuth, (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ success: true, results: [] });

    try {
        const searchTerm = `%${q}%`;
        const query = db.prepare(`
            SELECT id, name, x, y
            FROM systems
            WHERE name LIKE ? OR CAST(id AS TEXT) = ?
            LIMIT 20
        `);

        const results = query.all(searchTerm, q);
        res.json({ success: true, results });
    } catch (err) {
        console.error("[DB Error] System search failed:", err);
        res.status(500).json({ error: 'Search failed' });
    }
});

module.exports = router;
