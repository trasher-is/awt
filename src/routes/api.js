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
        INSERT INTO fleets (game_fleet_id, owner_id, system_id, planet_index, transports, colony_ships, destroyers, cruisers, battleships, arrival_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                insertFleet.run(f.game_fleet_id, f.owner_id, system_id, f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships, f.arrival_time || null);
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

    // Bulletproof sanitization: Ensure no properties are 'undefined'
    const safePlayer = {
        id: p.id,
        name: p.name || null,
        alliance_id: p.alliance_id || null,
        alliance_tag: p.alliance_tag || null,
        country: p.country || null,
        local_time: p.local_time || null,
        idle_time: p.idle_time || null,
        origin_system: p.origin_system || null,
        level: p.level || 0,
        ranking: p.ranking || null,
        points: p.points || 0,
        science_level: p.science_level || 0,
        culture_level: p.culture_level || 0,
        biology: p.biology || 0,
        economy: p.economy || 0,
        energy: p.energy || 0,
        mathematics: p.mathematics || 0,
        physics: p.physics || 0,
        social: p.social || 0,
        trade_revenue: p.trade_revenue || 0,
        artefact: p.artefact || null,
        eco_bonus: p.eco_bonus || 0,
        joined: p.joined || null,
        logins: p.logins || 0,
        race_growth: p.race_growth || 0,
        race_science: p.race_science || 0,
        race_culture: p.race_culture || 0,
        race_production: p.race_production || 0,
        race_speed: p.race_speed || 0,
        race_attack: p.race_attack || 0,
        race_defense: p.race_defense || 0
    };

    const oldPlayer = db.prepare('SELECT logins, points FROM players WHERE id = ?').get(p.id);

    const syncTransaction = db.transaction((player) => {
        // 1. Rejoin / Account Reset check
        // Check if oldPlayer exists FIRST, then use 'player' instead of 'incomingPlayer'
        if (oldPlayer && player.logins < oldPlayer.logins) {
            console.log(`[SYSTEM] Player ${player.id} restarted!`);
            
            // Strip ownership of old planets
            db.prepare(`
                UPDATE planets 
                SET owner_id = NULL, population = 0, starbase = 0, has_fleet = 0, is_sieged = 0 
                WHERE owner_id = ?
            `).run(player.id);
            
            // Delete old fleets
            db.prepare(`DELETE FROM fleets WHERE owner_id = ?`).run(player.id);
        }

        // 2. Alliance mapping
        if (player.alliance_id) {
            db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag`).run(player.alliance_id, player.alliance_tag, player.alliance_tag);
        }

        // 3. Upsert Player Profile
        db.prepare(`
            INSERT INTO players (
                id, name, alliance_id, country, local_time, idle_time, origin_system, 
                level, ranking, points, science_level, culture_level, 
                biology, economy, energy, mathematics, physics, social, 
                trade_revenue, artefact, eco_bonus,
                race_growth, race_science, race_culture, race_production, race_speed, race_attack, race_defense,
                joined, logins
            ) VALUES (
                @id, @name, @alliance_id, @country, @local_time, @idle_time, @origin_system, 
                @level, @ranking, @points, @science_level, @culture_level, 
                @biology, @economy, @energy, @mathematics, @physics, @social, 
                @trade_revenue, @artefact, @eco_bonus,
                @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack, @race_defense,
                @joined, @logins
            ) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, alliance_id=excluded.alliance_id, country=excluded.country, 
                local_time=excluded.local_time, idle_time=excluded.idle_time, origin_system=excluded.origin_system,
                level=excluded.level, ranking=excluded.ranking, points=excluded.points, 
                science_level=excluded.science_level, culture_level=excluded.culture_level,
                biology=excluded.biology, economy=excluded.economy, energy=excluded.energy, 
                mathematics=excluded.mathematics, physics=excluded.physics, social=excluded.social,
                trade_revenue=excluded.trade_revenue, artefact=excluded.artefact, eco_bonus=excluded.eco_bonus,
                race_growth=excluded.race_growth, race_science=excluded.race_science, race_culture=excluded.race_culture,
                race_production=excluded.race_production, race_speed=excluded.race_speed, race_attack=excluded.race_attack, race_defense=excluded.race_defense,
                joined=excluded.joined, logins=excluded.logins,
                updated_at=CURRENT_TIMESTAMP
        `).run(player);

        // 4. Logins Timeseries Tracker
        if (!oldPlayer || oldPlayer.logins !== player.logins) {
            db.prepare(`INSERT INTO player_logins (player_id, total_logins) VALUES (?, ?)`).run(player.id, player.logins);
        }
    });

    try {
        syncTransaction(safePlayer);
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

// --- FULL DATABASE ENDPOINTS ---
router.get('/intel/players', requireAuth, (req, res) => {
    try {
        // Fetch every player, join their alliance tag, and count how many planets they own in our DB
        const players = db.prepare(`
            SELECT p.*, a.tag as alliance_tag, 
                   (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as planet_count
            FROM players p 
            LEFT JOIN alliances a ON p.alliance_id = a.id
        `).all();
        
        res.json({ success: true, players });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full player DB:", err);
        res.status(500).json({ error: 'Failed to fetch players' });
    }
});

// Get Full Systems Database
router.get('/intel/systems_db', requireAuth, (req, res) => {
    try {
        const systems = db.prepare(`
            SELECT s.*, 
                   (SELECT COUNT(*) FROM planets WHERE system_id = s.id) as planet_count,
                   (SELECT COUNT(*) FROM fleets WHERE system_id = s.id) as fleet_count
            FROM systems s
        `).all();
        
        res.json({ success: true, systems });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full system DB:", err);
        res.status(500).json({ error: 'Failed to fetch systems' });
    }
});

// Get Full Planets Database
router.get('/intel/planets_db', requireAuth, (req, res) => {
    try {
        const planets = db.prepare(`
            SELECT p.system_id, p.planet_index, p.population, p.starbase, p.is_sieged, p.updated_at,
                   s.name as system_name, s.x, s.y,
                   u.name as owner_name, a.tag as alliance_tag
            FROM planets p
            LEFT JOIN systems s ON p.system_id = s.id
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
        `).all();
        
        res.json({ success: true, planets });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full planet DB:", err);
        res.status(500).json({ error: 'Failed to fetch planets' });
    }
});

// Get Full Fleets Database
router.get('/intel/fleets_db', requireAuth, (req, res) => {
    try {
        const fleets = db.prepare(`
            SELECT f.*, 
                   s.name as system_name, s.x, s.y,
                   u.name as owner_name, a.tag as alliance_tag
            FROM fleets f
            LEFT JOIN systems s ON f.system_id = s.id
            LEFT JOIN players u ON f.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
        `).all();
        
        res.json({ success: true, fleets });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full fleet DB:", err);
        res.status(500).json({ error: 'Failed to fetch fleets' });
    }
});

// --- GET ACTIVE ALLIANCE MEMBERS (From app_users) ---
router.get('/intel/members', requireAuth, (req, res) => {
    try {
        const members = db.prepare(`SELECT game_name FROM app_users WHERE is_active = 1`).all();
        res.json({ success: true, members: members.map(m => m.game_name) });
    } catch (err) {
        console.error("[DB Error] Failed to fetch members:", err);
        res.status(500).json({ error: 'Failed to fetch members' });
    }
});

router.get('/intel/player/:id', (req, res) => {
    try {
        const playerId = req.params.id;

        const playerInfo = db.prepare(`
            SELECT p.*, 
                   a.tag as alliance_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = ?) as planet_count
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.id = ?
        `).get(playerId, playerId);

        if (!playerInfo) {
            return res.json({ success: false, error: 'Player not found in database.' });
        }

        // 1. Fetch historical logins for the Line Chart
        let formattedActivity = [];
        try {
            const history = db.prepare(`
                SELECT timestamp, total_logins 
                FROM player_logins 
                WHERE player_id = ? 
                ORDER BY timestamp ASC 
                LIMIT 30
            `).all(playerId);

            formattedActivity = history.map(row => ({
                date: new Date(row.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                points: row.total_logins 
            }));
            
            if (formattedActivity.length === 0) {
                 formattedActivity = [{
                    date: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                    points: playerInfo.logins || 0
                }];
            }
        } catch (historyErr) {
            formattedActivity = [{
                date: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                points: playerInfo.logins || 0
            }];
        }

        // 2. Fetch the Online Probability Heatmap (Grouped by Hour)
        let heatmap = Array(24).fill(0); // Initialize 24 hours with 0
        try {
            const heatmapData = db.prepare(`
                SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
                FROM player_logins
                WHERE player_id = ?
                GROUP BY hour
            `).all(playerId);

            heatmapData.forEach(row => {
                if (row.hour !== null) {
                    heatmap[parseInt(row.hour, 10)] = row.count;
                }
            });
        } catch (err) {}

        res.json({
            success: true,
            player: playerInfo,
            activity: formattedActivity,
            heatmap: heatmap // <--- New data payload
        });

    } catch (error) {
        console.error('[API] Error fetching player intel:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

module.exports = router;