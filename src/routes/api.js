const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
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

// --- 2. MIDDLEWARE: ADMIN CHECK ---
// Put this in front of any route that only admins should touch
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.role === 'admin') return next();
    return res.status(403).json({ error: 'Unauthorized: Admins only' });
};

// --- 3. ADMIN DASHBOARD TOOLS ---
// Get all users
router.get('/admin/users', requireAdmin, (req, res) => {
    const users = db.prepare(`SELECT id, game_name, role, is_active FROM app_users`).all();
    res.json(users);
});

// Add a new user
router.post('/admin/users', requireAdmin, (req, res) => {
    const { game_name, password, role } = req.body;
    try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES (?, ?, ?)`).run(game_name, hash, role || 'user');
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: 'Database error' });
    }
});

// Toggle Active Status (Ban/Unban instantly)
router.post('/admin/users/:id/toggle', requireAdmin, (req, res) => {
    const user = db.prepare(`SELECT game_name, is_active FROM app_users WHERE id = ?`).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // HARD LOCK: Prevent banning the master admin
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
    
    // HARD LOCK: Prevent demoting the master admin
    if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot change the master admin role' });

    db.prepare(`UPDATE app_users SET role = ? WHERE id = ?`).run(role, req.params.id);
    res.json({ success: true, role });
});

// Change a user's password
router.post('/admin/users/:id/password', requireAdmin, (req, res) => {
    const { new_password } = req.body;
    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hash, req.params.id);
    res.json({ success: true });
});

module.exports = router;