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
router.delete('/plans/:systemId/:planetIndex', requireAuth, (req, res) => {
    try {
        db.prepare(`DELETE FROM planet_plans WHERE system_id = ? AND planet_index = ?`)
          .run(req.params.systemId, req.params.planetIndex);
        res.json({ success: true });
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
