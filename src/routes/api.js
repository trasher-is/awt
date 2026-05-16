const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const router = express.Router();


// --- MIDDLEWARE: AUTH CHECK ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'Unauthorized: Please log in' });
};

// --- 2. MIDDLEWARE: ADMIN CHECK ---
// Put this in front of any route that only admins should touch
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.role === 'admin') return next();
    return res.status(403).json({ error: 'Unauthorized: Admins only' });
};

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

// --- MAP SCRAPER DATA RECEIVER ---
router.post('/sync/system', requireAuth, (req, res) => {
    const { system_id, planets, fleets } = req.body; // <-- Added fleets
    
    if (!system_id || !Array.isArray(planets)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    db.prepare(`INSERT INTO systems (id) VALUES (?) ON CONFLICT(id) DO NOTHING`).run(system_id);

    const upsertAlliance = db.prepare(`
        INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) 
        ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, updated_at=CURRENT_TIMESTAMP
    `);
    
    const upsertPlayer = db.prepare(`
        INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?) 
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, alliance_id=excluded.alliance_id, updated_at=CURRENT_TIMESTAMP
    `);
    
    const upsertPlanet = db.prepare(`
        INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(system_id, planet_index) DO UPDATE SET
            game_planet_id=excluded.game_planet_id,
            owner_id=excluded.owner_id,
            population=excluded.population,
            starbase=excluded.starbase,
            has_fleet=excluded.has_fleet,
            updated_at=CURRENT_TIMESTAMP
    `);

    // Prepared statement for the new fleets
    const insertFleet = db.prepare(`
        INSERT INTO fleets (game_fleet_id, owner_id, system_id, planet_index, transports, colony_ships, destroyers, cruisers, battleships)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // --- NEW: History Logging Prep ---
    const getOldPlanet = db.prepare(`SELECT owner_id, population FROM planets WHERE system_id = ? AND planet_index = ?`);
    const logEvent = db.prepare(`
        INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value)
        VALUES (?, ?, ?, ?, ?)
    `);

    const syncTransaction = db.transaction((planetsData, fleetsData) => {
        
        // 1. Process Planets, Owners, and History
        for (const p of planetsData) {
            
            // Check for history events BEFORE upserting
            const oldP = getOldPlanet.get(system_id, p.planet_index);
            if (oldP) {
                const newOwnerId = p.owner ? p.owner.id : null;
                // Owner Change
                if (oldP.owner_id !== newOwnerId) {
                    logEvent.run(system_id, p.planet_index, 1, oldP.owner_id, newOwnerId); // 1 = OWNER_CHANGE
                }
                // Significant Population Drop (possible bombardment)
                if (oldP.population > 0 && p.population < oldP.population - 5) {
                    logEvent.run(system_id, p.planet_index, 2, oldP.population, p.population); // 2 = POP_DROP
                }
            }

            // Standard Upsert
            if (p.owner) {
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag, p.owner.alliance_tag); 
                upsertPlayer.run(p.owner.id, p.owner.name, p.owner.alliance_id || null);
            }
            upsertPlanet.run(p.game_planet_id, system_id, p.planet_index, p.owner ? p.owner.id : null, p.population, p.starbase, p.has_fleet);
        }

        // 2. Wipe & Replace Fleets
        if (Array.isArray(fleetsData)) {
            db.prepare(`DELETE FROM fleets WHERE system_id = ?`).run(system_id);
            for (const f of fleetsData) {
                if (f.owner_id) {
                    db.prepare(`INSERT INTO players (id, name) VALUES (?, 'Unknown') ON CONFLICT(id) DO NOTHING`).run(f.owner_id);
                }
                insertFleet.run(f.game_fleet_id, f.owner_id, system_id, f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships);
            }
        }
    });

    try {
        syncTransaction(planets, fleets || []);
        res.json({ success: true, synced_count: planets.length });
    } catch (err) {
        console.error(`[DB Error] Failed to sync system ${system_id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- PLAYER PROFILE SCRAPER RECEIVER ---
router.post('/sync/player', requireAuth, (req, res) => {
    const p = req.body;
    
    if (!p || !p.id) return res.status(400).json({ error: 'Invalid player payload' });
    
    console.log(`\n[API] Incoming profile sync for Player ID: ${p.id} (${p.name})`);

    const syncTransaction = db.transaction((player) => {
        
        // Ensure alliance exists to respect Foreign Keys
        if (player.alliance_id) {
            db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag`).run(player.alliance_id, player.alliance_tag, player.alliance_tag);
        }

        // Upsert the massive player object
        db.prepare(`
            INSERT INTO players (
                id, name, alliance_id, country, local_time, origin_system, 
                level, ranking, points, science_level, culture_level, 
                biology, economy, energy, mathematics, physics, social, 
                trade_revenue, artefact, 
                race_growth, race_science, race_culture, race_production, race_speed, race_attack, race_defense
            ) VALUES (
                @id, @name, @alliance_id, @country, @local_time, @origin_system, 
                @level, @ranking, @points, @science_level, @culture_level, 
                @biology, @economy, @energy, @mathematics, @physics, @social, 
                @trade_revenue, @artefact, 
                @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack, @race_defense
            ) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, alliance_id=excluded.alliance_id, country=excluded.country, 
                local_time=excluded.local_time, origin_system=excluded.origin_system,
                level=excluded.level, ranking=excluded.ranking, points=excluded.points, 
                science_level=excluded.science_level, culture_level=excluded.culture_level,
                biology=excluded.biology, economy=excluded.economy, energy=excluded.energy, 
                mathematics=excluded.mathematics, physics=excluded.physics, social=excluded.social,
                trade_revenue=excluded.trade_revenue, artefact=excluded.artefact, 
                race_growth=excluded.race_growth, race_science=excluded.race_science, race_culture=excluded.race_culture,
                race_production=excluded.race_production, race_speed=excluded.race_speed, race_attack=excluded.race_attack, race_defense=excluded.race_defense,
                updated_at=CURRENT_TIMESTAMP
        `).run(player);
    });

    try {
        syncTransaction(p);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync player ${p.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- ALLIANCE PROFILE SCRAPER RECEIVER ---
router.post('/sync/alliance', requireAuth, (req, res) => {
    const ally = req.body;
    
    if (!ally || !ally.id) return res.status(400).json({ error: 'Invalid alliance payload' });
    
    console.log(`\n[API] Incoming profile sync for Alliance ID: ${ally.id} (${ally.tag})`);

    const syncTransaction = db.transaction((a) => {
        // 1. Upsert Alliance Data
        db.prepare(`
            INSERT INTO alliances (id, name, tag, leader_id, ranking, points_current)
            VALUES (@id, @name, @tag, @leader_id, @ranking, @points)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, 
                tag=excluded.tag, 
                leader_id=excluded.leader_id,
                ranking=excluded.ranking, 
                points_current=excluded.points_current,
                updated_at=CURRENT_TIMESTAMP
        `).run(a);

        // 2. Map all members to this Alliance
        const upsertPlayer = db.prepare(`
            INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                name=excluded.name, 
                alliance_id=excluded.alliance_id, 
                updated_at=CURRENT_TIMESTAMP
        `);

        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                upsertPlayer.run(member.id, member.name, a.id);
            }
        }
    });

    try {
        syncTransaction(ally);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync alliance ${ally.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- GALAXY MASTER INDEX RECEIVER ---
router.post('/sync/galaxy', requireAuth, (req, res) => {
    const { systems } = req.body;
    
    if (!Array.isArray(systems) || systems.length === 0) {
        return res.status(400).json({ error: 'Invalid galaxy payload' });
    }
    
    console.log(`\n[API] Incoming Galaxy Index sync (${systems.length} systems)`);

    const upsertSystem = db.prepare(`
        INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
            name=excluded.name, 
            x=excluded.x, 
            y=excluded.y, 
            updated_at=CURRENT_TIMESTAMP
    `);

    const syncTransaction = db.transaction((sysList) => {
        for (const s of sysList) {
            upsertSystem.run(s.id, s.name, s.x, s.y);
        }
    });

    try {
        syncTransaction(systems);
        res.json({ success: true, count: systems.length });
    } catch (err) {
        console.error(`[DB Error] Failed to sync galaxy index:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

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

// --- INTEL HUB STATS ---
router.get('/intel/summary', requireAuth, (req, res) => {
    try {
        const systems = db.prepare(`SELECT COUNT(*) as count FROM systems`).get().count;
        const planets = db.prepare(`SELECT COUNT(*) as count FROM planets`).get().count;
        const players = db.prepare(`SELECT COUNT(*) as count FROM players`).get().count;
        const alliances = db.prepare(`SELECT COUNT(*) as count FROM alliances`).get().count;
        const fleets = db.prepare(`SELECT COUNT(*) as count FROM fleets`).get().count; // <-- Added fleets
        
        res.json({ success: true, systems, planets, players, alliances, fleets });
    } catch (err) {
        console.error("[DB Error] Failed to fetch intel summary:", err);
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
});

// --- GET ALL SYSTEMS FOR MASS SCAN ---
router.get('/systems', requireAuth, (req, res) => {
    try {
        const systems = db.prepare(`SELECT id FROM systems ORDER BY id ASC`).all();
        res.json({ success: true, systems: systems.map(s => s.id) });
    } catch (err) {
        console.error("[DB Error] Failed to fetch system list:", err);
        res.status(500).json({ error: 'Failed to fetch systems' });
    }
});

// --- GET ALL PLAYERS FOR MASS SCAN ---
router.get('/players', requireAuth, (req, res) => {
    try {
        // We only scan players we actually know about from system/alliance mapping
        const playersList = db.prepare(`SELECT id FROM players ORDER BY id ASC`).all();
        res.json({ success: true, players: playersList.map(p => p.id) });
    } catch (err) {
        console.error("[DB Error] Failed to fetch player list:", err);
        res.status(500).json({ error: 'Failed to fetch players' });
    }
});

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
        db.prepare(`
            INSERT INTO planet_plans (system_id, planet_index, author_id, note) 
            VALUES (?, ?, ?, ?)
            ON CONFLICT(system_id, planet_index) DO UPDATE SET 
                note=excluded.note, 
                author_id=excluded.author_id, 
                updated_at=CURRENT_TIMESTAMP
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

// --- GET FULL SYSTEM INTEL (Planets, Fleets, History, Plans) ---
router.get('/intel/system/:id', requireAuth, (req, res) => {
    try {
        const sysId = req.params.id;

        // 1. Get Planets & Owners
        const planets = db.prepare(`
            SELECT p.planet_index, p.population, p.starbase, p.has_fleet, p.is_sieged, 
                   u.name as owner_name, a.tag as alliance_tag
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE p.system_id = ?
            ORDER BY p.planet_index ASC
        `).all(sysId);

        // 2. Get Fleets
        const fleets = db.prepare(`
            SELECT f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships,
                   u.name as owner_name, a.tag as alliance_tag
            FROM fleets f
            LEFT JOIN players u ON f.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE f.system_id = ?
        `).all(sysId);

        // 3. Get History (Last 10 events) - FIXED: Removed event_types table dependency
        const history = db.prepare(`
            SELECT e.planet_index, e.event_type_id, e.timestamp,
                   o1.name as old_owner, o2.name as new_owner
            FROM planet_events e
            LEFT JOIN players o1 ON e.old_value = o1.id AND e.event_type_id = 1
            LEFT JOIN players o2 ON e.new_value = o2.id AND e.event_type_id = 1
            WHERE e.system_id = ?
            ORDER BY e.timestamp DESC
            LIMIT 10
        `).all(sysId);

        // 4. Get Plans
        const plans = db.prepare(`
            SELECT p.planet_index, p.note, u.game_name as author 
            FROM planet_plans p 
            LEFT JOIN app_users u ON p.author_id = u.id 
            WHERE p.system_id = ?
        `).all(sysId);

        res.json({ success: true, planets, fleets, history, plans });
    } catch (err) {
        console.error("[DB Error] Failed to fetch system intel:", err);
        res.status(500).json({ error: 'Failed to fetch intel' });
    }
});

// --- DATABASE SEARCH ENDPOINTS ---

// Search Players by Name or ID
router.get('/search/player', requireAuth, (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ success: true, results: [] });
    
    try {
        const isNum = !isNaN(q);
        const query = isNum 
            ? db.prepare(`SELECT p.id, p.name, a.tag as alliance_tag FROM players p LEFT JOIN alliances a ON p.alliance_id = a.id WHERE p.id = ? OR p.name LIKE ? LIMIT 20`)
            : db.prepare(`SELECT p.id, p.name, a.tag as alliance_tag FROM players p LEFT JOIN alliances a ON p.alliance_id = a.id WHERE p.name LIKE ? LIMIT 20`);
        
        const results = isNum ? query.all(parseInt(q, 10), `%${q}%`) : query.all(`%${q}%`);
        res.json({ success: true, results });
    } catch (err) {
        console.error("[DB Error] Player search failed:", err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Search Systems by Name or ID
router.get('/search/system', requireAuth, (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ success: true, results: [] });
    
    try {
        const isNum = !isNaN(q);
        const query = isNum
            ? db.prepare(`SELECT id, name, x, y FROM systems WHERE id = ? OR name LIKE ? LIMIT 20`)
            : db.prepare(`SELECT id, name, x, y FROM systems WHERE name LIKE ? LIMIT 20`);
        
        const results = isNum ? query.all(parseInt(q, 10), `%${q}%`) : query.all(`%${q}%`);
        res.json({ success: true, results });
    } catch (err) {
        console.error("[DB Error] System search failed:", err);
        res.status(500).json({ error: 'Search failed' });
    }
});

module.exports = router;