const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const { requireAuth, requireAdmin } = require('./_middleware');
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const plansRepo = require('../repositories/plans');
const playersRepo = require('../repositories/players');
const { archiveRound, listRounds, roundDetail } = require('../utils/round-archive');
const router = express.Router();

// Reject empty or whitespace-only passwords before they reach bcrypt. hashSync(undefined)
// throws, which the surrounding handlers reported as a generic "Database error".
function invalidPassword(pw) {
    if (typeof pw !== 'string' || pw.trim().length === 0) return 'Password is required';
    if (pw.length < 8) return 'Password must be at least 8 characters';
    return null;
}

// --- 3. ADMIN DASHBOARD TOOLS ---

// --- SERVER LOG VIEWER ---
// The admin panel fetches /hub-api/admin/logs, but no such route existed - the request
// fell through the hub router to the game proxy, so the viewer never worked. The only
// implementation lived in server.js as /api/admin/logs, registered above the session
// middleware, which made it unauthenticated. It lives here now, behind requireAdmin.
router.get('/admin/logs', requireAdmin, (req, res) => {
    let logPath = process.env.LOG_PATH || '/root/.pm2/logs/awt-error.log';

    // config.json is read with JSON.parse rather than require(): require() caches, so
    // edits needed a restart to take effect, and it executes the file as a module, which
    // turns "can write config.json" into "can run code in this process".
    try {
        const configPath = path.join(__dirname, '..', '..', 'config.json');
        if (fs.existsSync(configPath)) {
            const localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (localConfig.logPath) logPath = localConfig.logPath;
        }
    } catch (err) {
        console.error('[Admin] Could not read config.json:', err.message);
    }

    if (!fs.existsSync(logPath)) {
        return res.json({ success: false, logs: `Log file not found at: ${logPath}` });
    }

    fs.readFile(logPath, 'utf8', (err, data) => {
        if (err) {
            console.error('[Admin] Log read failed:', err.message);
            return res.json({ success: false, logs: 'Permission denied or unable to read log file.' });
        }
        res.json({ success: true, logs: data.trim().split('\n').slice(-20).join('\n') });
    });
});

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

    if (typeof game_name !== 'string' || game_name.trim() === '') {
        return res.status(400).json({ error: 'Username is required' });
    }
    const pwError = invalidPassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (role && !['admin', 'user', 'guest'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }

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

// Clear a Discord link. Linking is now a one-time-code challenge that only the account
// holder can complete, and a link can never be reassigned from Discord — so this is the
// only way to move one, e.g. when a member changes Discord account or someone linked the
// wrong Hub account before the code flow existed.
router.delete('/admin/users/:id/discord', requireAdmin, (req, res) => {
    try {
        const user = db.prepare(`SELECT game_name, discord_id, discord_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.discord_id && !user.discord_name) {
            return res.json({ success: true, changed: false, message: 'That account has no Discord link.' });
        }
        db.transaction(() => {
            db.prepare(`UPDATE app_users SET discord_id = NULL, discord_name = NULL WHERE id = ?`).run(req.params.id);
            // Any pending link codes for this account are void once an admin intervenes.
            db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ?`).run(req.params.id);
        })();
        console.log(`[Admin] Discord link cleared for '${user.game_name}' (was ${user.discord_id || user.discord_name}).`);
        res.json({ success: true, changed: true });
    } catch (err) {
        console.error('[Admin] Failed to clear Discord link:', err);
        res.status(500).json({ error: 'Failed to clear the Discord link' });
    }
});

// Toggle Active Status (Ban/Unban)
router.post('/admin/users/:id/toggle', requireAdmin, (req, res) => {
    try {
        const user = db.prepare(`SELECT game_name, is_active FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot ban the master admin' });

        const newStatus = user.is_active === 1 ? 0 : 1;
        db.prepare(`UPDATE app_users SET is_active = ? WHERE id = ?`).run(newStatus, req.params.id);
        res.json({ success: true, is_active: newStatus });
    } catch (err) {
        console.error('[DB Error] Failed to toggle user:', err);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// Change User Role
router.post('/admin/users/:id/role', requireAdmin, (req, res) => {
    const { role } = req.body;
    const validRoles = ['admin', 'user', 'guest'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    try {
        const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot change the master admin role' });

        db.prepare(`UPDATE app_users SET role = ? WHERE id = ?`).run(role, req.params.id);
        res.json({ success: true, role });
    } catch (err) {
        console.error('[DB Error] Failed to change role:', err);
        res.status(500).json({ error: 'Failed to change role' });
    }
});

// Change a user's password
router.post('/admin/users/:id/password', requireAdmin, (req, res) => {
    const { new_password } = req.body;

    const pwError = invalidPassword(new_password);
    if (pwError) return res.status(400).json({ error: pwError });

    try {
        const targetUser = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        // SECURITY: Only the session holding the 'admin' game_name can change the master admin password
        if (targetUser.game_name === 'admin' && req.session.gameName !== 'admin') {
            return res.status(403).json({ error: 'Only the Master Admin can change this password.' });
        }

        const hash = bcrypt.hashSync(new_password, 10);
        db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hash, req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to change password:', err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// --- DATABASE CONTROLS ---

// Get DB Status
router.get('/admin/status', requireAdmin, (req, res) => {
    try {
        const stats = {
            systems: systemsRepo.countSystems(),
            planets: systemsRepo.countPlanets(),
            players: playersRepo.countPlayers(),
            fleets: fleetsRepo.countFleets(),
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
        const result = fleetsRepo.deleteFleetsOlderThan10Days();
        res.json({ success: true, deleted: result.changes });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear fleets' });
    }
});

// --- ROUND ARCHIVE ---
// The index of past rounds, and a way to snapshot the current one WITHOUT wiping it.
// The manual snapshot matters because the automatic one runs at wipe time, by which point
// the round is over and some players have already gone inactive and stopped being
// scraped. Taking one while the round is still live captures a fuller picture.
router.get('/admin/rounds', requireAdmin, (req, res) => {
    try {
        res.json({ success: true, rounds: listRounds(db) });
    } catch (err) {
        console.error('[DB Error] Failed to list rounds:', err);
        res.status(500).json({ error: 'Failed to list archived rounds' });
    }
});

router.get('/admin/rounds/:id', requireAdmin, (req, res) => {
    try {
        const round = roundDetail(db, req.params.id);
        if (!round) return res.status(404).json({ error: 'No such archived round' });
        res.json({ success: true, round });
    } catch (err) {
        console.error('[DB Error] Failed to read round:', err);
        res.status(500).json({ error: 'Failed to read archived round' });
    }
});

router.post('/admin/rounds/archive', requireAdmin, (req, res) => {
    const { label, note } = req.body;
    try {
        const result = db.transaction(() => archiveRound(db, { label, note }))();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[DB Error] Failed to archive round:', err);
        res.status(500).json({ error: 'Failed to archive the current round' });
    }
});

// Nuke All Intel (Requires Master Admin Password)
router.post('/admin/nuke-intel', requireAdmin, (req, res) => {
    const { password, label, note } = req.body;

    if (req.session.gameName !== 'admin') {
        return res.status(403).json({ error: 'Only the Master Admin can execute a database nuke.' });
    }

    const adminUser = db.prepare(`SELECT password_hash FROM app_users WHERE game_name = 'admin'`).get();
    if (!bcrypt.compareSync(password, adminUser.password_hash)) {
        return res.status(401).json({ error: 'Invalid master password. Aborting nuke.' });
    }

    try {
        let archived;
        const nukeTx = db.transaction(() => {
            // Snapshot BEFORE the deletes, in the same transaction. A player id is stable
            // for the life of an account and people rename between rounds, so this is the
            // only chance to record that the account now called Chewie played the last
            // round as Elfenlied. If the snapshot throws, nothing is deleted.
            archived = archiveRound(db, { label, note });

            fleetsRepo.deleteAllFleets();
            plansRepo.deleteAllPlans();
            systemsRepo.deleteAllPlanetEvents();
            systemsRepo.deleteAllPlanets();
            playersRepo.deleteAllPlayers();
            db.prepare(`DELETE FROM alliances`).run();
            systemsRepo.deleteAllSystems();
        });

        nukeTx();
        console.log(`[Admin] Round wiped. Archived ${archived.players} players and ${archived.systems} systems as "${archived.label}".`);
        res.json({ success: true, archived });
    } catch (err) {
        console.error("[DB Error] Nuke failed:", err);
        res.status(500).json({ error: 'Nuke transaction failed. Nothing was deleted.' });
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

// --- ADMIN: APP SETTINGS (key/value) ---
router.get('/admin/settings', requireAdmin, (req, res) => {
    try {
        const rows = db.prepare(`SELECT key, value FROM app_settings`).all();
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        res.json({ success: true, settings });
    } catch (err) {
        console.error("[DB Error] Failed to fetch settings:", err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

router.post('/admin/settings', requireAdmin, (req, res) => {
    const { key, value } = req.body;
    const allowedKeys = ['discord_announce_channel', 'discord_popdrop_channel', 'discord_incoming_channel', 'discord_reminder_channel', 'discord_blocked_channels'];
    if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Unknown setting key' });

    try {
        db.prepare(`
            INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(key, value == null ? '' : String(value).trim());
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to save setting:", err);
        res.status(500).json({ error: 'Failed to save setting' });
    }
});

module.exports = router;
