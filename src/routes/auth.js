const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- 1. LOGIN SYSTEM ---
router.post('/login', (req, res) => {
    const { game_name, password } = req.body;

    // Find the user
    const user = db.prepare(`SELECT * FROM app_users WHERE game_name = ?`).get(game_name);

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_active === 0) return res.status(403).json({ error: 'Account has been deactivated' });

    // Check password
    if (bcrypt.compareSync(password, user.password_hash)) {
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.gameName = user.game_name;
        return res.json({ success: true, role: user.role });
    } else {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// --- TOOL USER CONTEXT ---
// The Wrapper calls this to figure out who is supposed to be playing
router.get('/me', requireAuth, (req, res) => {
    res.json({
        id: req.session.userId,
        gameName: req.session.gameName,
        role: req.session.role
    });
});

// --- THE SPY TRAP NUKE ---
// Triggered by the Wrapper if a name mismatch is detected
router.post('/nuke', requireAuth, (req, res) => {
    const { detectedName } = req.body;
    const toolName = req.session.gameName;
    const userId = req.session.userId;
    const role = req.session.role;

    // 1. Admin Immunity Check
    if (role === 'admin' || toolName.toLowerCase() === 'admin') {
        console.log(`[Admin Override] Name mismatch ignored for Admin '${toolName}'.`);
        return res.json({ success: true, bypassed: true });
    }

    // 2. Test Environment Bypass
    if (process.env.NODE_ENV === 'development' || process.env.IS_TEST_SERVER === 'true') {
        console.log(`[Test Mode] Bypassing ban for tool account: '${toolName}'.`);
        return res.json({ success: true, bypassed: true });
    }

    console.error(`\n[!!! CRITICAL SECURITY ALERT !!!]`);
    console.error(`Tool Account '${toolName}' was caught sharing credentials.`);
    console.error(`In-Game Player detected: '${detectedName}'`);
    console.error(`Action: PERMANENT BAN EXECUTED.\n`);

    // Ban the account
    db.prepare(`UPDATE app_users SET is_active = 0 WHERE id = ?`).run(userId);

    // Destroy their session
    req.session.destroy();

    // Explicitly tell the front-end that a ban occurred
    res.json({ success: true, banned: true });
});

module.exports = router;
