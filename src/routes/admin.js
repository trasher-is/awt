const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAuth, requireAdmin } = require('./_middleware');
const router = express.Router();

// --- 3. ADMIN DASHBOARD TOOLS ---

// Get all users (joined with players table for idle_time)
router.get('/admin/users', requireAdmin, (req, res) => {
    try {
        const users = db.prepare(`
            SELECT u.id, u.game_name, u.role, u.is_active, u.discord_name, p.idle_time
            FROM app_users u
            LEFT JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
            ORDER BY u.id ASC
        `).all();
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// Edit User Name
router.post('/admin/users/:id/name', requireAdmin, (req, res) => {
    const { new_name } = req.body;
    if (!new_name || new_name.trim() === '') return res.status(400).json({ error: 'Name cannot be empty' });

    try {
        const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot rename the master admin' });
        if (new_name.toLowerCase() === 'admin') return res.status(400).json({ error: 'Cannot use reserved name' });

        db.prepare(`UPDATE app_users SET game_name = ? WHERE id = ?`).run(new_name.trim(), req.params.id);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: 'Failed to update name' });
    }
});

// Delete User
router.delete('/admin/users/:id', requireAdmin, (req, res) => {
    try {
        const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot delete the master admin' });

        db.prepare(`DELETE FROM app_users WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Add a new user
router.post('/admin/users', requireAdmin, (req, res) => {
    const { game_name, password, role, discord_name } = req.body;
    try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare(`INSERT INTO app_users (game_name, password_hash, role, discord_name) VALUES (?, ?, ?, ?)`).run(game_name, hash, role || 'user', discord_name || null);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: 'Database error' });
    }
});

// Update Discord Name
router.post('/admin/users/:id/discord', requireAdmin, (req, res) => {
    const { discord_name } = req.body;
    try {
        db.prepare(`UPDATE app_users SET discord_name = ? WHERE id = ?`).run(discord_name, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update discord name' });
    }
});

// Toggle Active Status (Ban/Unban)
router.post('/admin/users/:id/toggle', requireAdmin, (req, res) => {
    const user = db.prepare(`SELECT game_name, is_active FROM app_users WHERE id = ?`).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot ban the master admin' });

    const newStatus = user.is_active === 1 ? 0 : 1;
    db.prepare(`UPDATE app_users SET is_active = ? WHERE id = ?`).run(newStatus, req.params.id);
    res.json({ success: true, is_active: newStatus });
});

// Change User Role
router.post('/admin/users/:id/role', requireAdmin, (req, res) => {
    const { role } = req.body;
    const validRoles = ['admin', 'user', 'guest'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot change the master admin role' });

    db.prepare(`UPDATE app_users SET role = ? WHERE id = ?`).run(role, req.params.id);
    res.json({ success: true, role });
});

// Change a user's password
router.post('/admin/users/:id/password', requireAdmin, (req, res) => {
    const { new_password } = req.body;
    const targetUser = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);

    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // SECURITY: Only the session holding the 'admin' game_name can change the master admin password
    if (targetUser.game_name === 'admin' && req.session.gameName !== 'admin') {
        return res.status(403).json({ error: 'Only the Master Admin can change this password.' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hash, req.params.id);
    res.json({ success: true });
});

// --- DATABASE CONTROLS ---

// Get DB Status
router.get('/admin/status', requireAdmin, (req, res) => {
    try {
        const stats = {
            systems: db.prepare(`SELECT COUNT(*) as count FROM systems`).get().count,
            planets: db.prepare(`SELECT COUNT(*) as count FROM planets`).get().count,
            players: db.prepare(`SELECT COUNT(*) as count FROM players`).get().count,
            fleets: db.prepare(`SELECT COUNT(*) as count FROM fleets`).get().count,
            uptime: process.uptime()
        };
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// Clear Old Fleets (> 10 Days)
router.post('/admin/clear-fleets', requireAdmin, (req, res) => {
    try {
        const result = db.prepare(`DELETE FROM fleets WHERE updated_at <= datetime('now', '-10 days')`).run();
        res.json({ success: true, deleted: result.changes });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear fleets' });
    }
});

// Nuke All Intel (Requires Master Admin Password)
router.post('/admin/nuke-intel', requireAdmin, (req, res) => {
    const { password } = req.body;

    if (req.session.gameName !== 'admin') {
        return res.status(403).json({ error: 'Only the Master Admin can execute a database nuke.' });
    }

    const adminUser = db.prepare(`SELECT password_hash FROM app_users WHERE game_name = 'admin'`).get();
    if (!bcrypt.compareSync(password, adminUser.password_hash)) {
        return res.status(401).json({ error: 'Invalid master password. Aborting nuke.' });
    }

    try {
        const nukeTx = db.transaction(() => {
            db.prepare(`DELETE FROM fleets`).run();
            db.prepare(`DELETE FROM planet_plans`).run();
            db.prepare(`DELETE FROM planet_events`).run();
            db.prepare(`DELETE FROM planets`).run();
            db.prepare(`DELETE FROM players`).run();
            db.prepare(`DELETE FROM alliances`).run();
            db.prepare(`DELETE FROM systems`).run();
        });

        nukeTx();
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Nuke failed:", err);
        res.status(500).json({ error: 'Nuke transaction failed.' });
    }
});

// --- ADMIN: PUBLISH BROADCAST ---
router.post('/admin/broadcasts', requireAdmin, (req, res) => {
    const { title, message, author_name, display_time } = req.body;
    if (!message || !author_name || !display_time) return res.status(400).json({ error: 'Missing required parameters.' });

    try {
        db.prepare(`
            INSERT INTO alliance_broadcasts (title, message, author_name, display_time)
            VALUES (?, ?, ?, ?)
        `).run(title || 'Attention!!!', message, author_name, display_time);
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to insert broadcast:", err);
        res.status(500).json({ error: 'Failed to create broadcast' });
    }
});

// --- USER & ADMIN: FETCH ALL BROADCASTS ---
router.get('/broadcasts', requireAuth, (req, res) => {
    try {
        const activeAlerts = db.prepare(`
            SELECT id, title, message, author_name, display_time
            FROM alliance_broadcasts
            ORDER BY id DESC
        `).all();
        res.json({ success: true, broadcasts: activeAlerts });
    } catch (err) {
        console.error("[DB Error] Failed to fetch broadcasts:", err);
        res.status(500).json({ error: 'Failed to load broadcasts' });
    }
});

// --- ADMIN: EDIT EXISTENT BROADCAST ---
router.put('/admin/broadcasts/:id', requireAdmin, (req, res) => {
    const { title, message, author_name, display_time } = req.body;
    if (!message || !author_name || !display_time) return res.status(400).json({ error: 'Missing fields.' });

    try {
        db.prepare(`
            UPDATE alliance_broadcasts
            SET title = ?, message = ?, author_name = ?, display_time = ?
            WHERE id = ?
        `).run(title || 'Attention!!!', message, author_name, display_time, req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to update broadcast:", err);
        res.status(500).json({ error: 'Update execution failed.' });
    }
});

// --- ADMIN: DELETE BROADCAST ---
router.delete('/admin/broadcasts/:id', requireAdmin, (req, res) => {
    try {
        db.prepare(`DELETE FROM alliance_broadcasts WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to delete broadcast:", err);
        res.status(500).json({ error: 'Delete execution failed.' });
    }
});

module.exports = router;
