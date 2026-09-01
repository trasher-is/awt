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
const alliancesRepo = require('../repositories/alliances');
const battleReportsRepo = require('../repositories/battleReports');
const newsEventsRepo = require('../repositories/newsEvents');
const usersRepo = require('../repositories/users');
const settingsRepo = require('../repositories/settings');
const incomingRepo = require('../repositories/incoming');
const tradeRepo = require('../repositories/trade');
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
        const users = usersRepo.getAllUsersWithIdle();
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
        const user = usersRepo.getUserNameById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot rename the master admin' });
        if (new_name.toLowerCase() === 'admin') return res.status(400).json({ error: 'Cannot use reserved name' });

        usersRepo.updateUserGameName(req.params.id, new_name.trim());
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: 'Failed to update name' });
    }
});

// Delete User
router.delete('/admin/users/:id', requireAdmin, (req, res) => {
    try {
        const user = usersRepo.getUserNameById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot delete the master admin' });

        usersRepo.deleteUser(req.params.id);
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
        usersRepo.createUser(game_name, hash, role || 'user', discord_name || null);
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
        usersRepo.updateUserDiscordName(req.params.id, discord_name);
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
        const user = usersRepo.getUserDiscordInfoById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.discord_id && !user.discord_name) {
            return res.json({ success: true, changed: false, message: 'That account has no Discord link.' });
        }
        db.transaction(() => {
            usersRepo.clearUserDiscordFields(req.params.id);
            // Any pending link codes for this account are void once an admin intervenes.
            usersRepo.deleteLinkCodesByUserId(req.params.id);
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
        const user = usersRepo.getUserActiveStatusById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot ban the master admin' });

        const newStatus = user.is_active === 1 ? 0 : 1;
        usersRepo.setUserActive(req.params.id, newStatus);
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
        const user = usersRepo.getUserNameById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot change the master admin role' });

        usersRepo.setUserRole(req.params.id, role);
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
        const targetUser = usersRepo.getUserNameById(req.params.id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        // SECURITY: Only the session holding the 'admin' game_name can change the master admin password
        if (targetUser.game_name === 'admin' && req.session.gameName !== 'admin') {
            return res.status(403).json({ error: 'Only the Master Admin can change this password.' });
        }

        const hash = bcrypt.hashSync(new_password, 10);
        usersRepo.setUserPasswordHash(req.params.id, hash);
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

    const adminUser = usersRepo.getAdminPasswordHash();
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
            // Battle reports describe battles on the map being wiped — they go with it.
            // News events are the same kind of record (walkover conquests/bombardments on
            // the same wiped map). starbase_order_audit is deliberately NOT here: it is an
            // operations record of who sent what through the hub, and that stays true
            // across rounds.
            battleReportsRepo.deleteAllBattleReports();
            newsEventsRepo.deleteAllNewsEvents();
            systemsRepo.deleteAllPlanets();
            playersRepo.deleteAllPlayers();
            alliancesRepo.deleteAllAlliances();
            // Keyed by player_id, which is stable across rounds — without this, last
            // round's rows survive the nuke and rejoin against the fresh (now-empty)
            // players table as an "Unknown" member still showing last round's stats.
            alliancesRepo.deleteAllAllianceMemberStats();
            // Planet CV leaderboard — meaningless once the planets it ranks are gone.
            systemsRepo.clearBestGuarded();
            // Both keyed by identities (system:planet:attacker / player names) that only
            // mean anything within the round that's being wiped.
            incomingRepo.deleteAllIncomingMsgs();
            incomingRepo.deleteAllIncomingAlerts();
            tradeRepo.deleteAllTradeAgreements();
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
        alliancesRepo.insertBroadcast(title || 'Attention!!!', message, author_name, display_time);
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to insert broadcast:", err);
        res.status(500).json({ error: 'Failed to create broadcast' });
    }
});

// --- USER & ADMIN: FETCH ALL BROADCASTS ---
router.get('/broadcasts', requireAuth, (req, res) => {
    try {
        const activeAlerts = alliancesRepo.getBroadcasts();
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
        alliancesRepo.updateBroadcast(title || 'Attention!!!', message, author_name, display_time, req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to update broadcast:", err);
        res.status(500).json({ error: 'Update execution failed.' });
    }
});

// --- ADMIN: DELETE BROADCAST ---
router.delete('/admin/broadcasts/:id', requireAdmin, (req, res) => {
    try {
        alliancesRepo.deleteBroadcast(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to delete broadcast:", err);
        res.status(500).json({ error: 'Delete execution failed.' });
    }
});

// --- ADMIN: APP SETTINGS (key/value) ---
router.get('/admin/settings', requireAdmin, (req, res) => {
    try {
        const rows = settingsRepo.getAllSettings();
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
    const allowedKeys = ['discord_announce_channel', 'discord_popdrop_channel', 'discord_incoming_channel', 'discord_battlereport_channel', 'discord_new_player_channel', 'discord_blocked_channels', 'discord_battlepoints_channel', 'battle_points_cv_ratio', 'battle_points_pop_ratio', 'battle_points_excluded_alliance_tags'];
    if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Unknown setting key' });

    try {
        settingsRepo.setSetting(key, value == null ? '' : String(value).trim());
        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Failed to save setting:", err);
        res.status(500).json({ error: 'Failed to save setting' });
    }
});

module.exports = router;
