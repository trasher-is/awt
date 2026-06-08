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
        ON CONFLICT(id) DO UPDATE SET 
            name = excluded.name, 
            alliance_id = CASE WHEN excluded.alliance_id IS NOT NULL THEN excluded.alliance_id ELSE players.alliance_id END, 
            updated_at = CURRENT_TIMESTAMP
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
            
            let finalOwnerId = p.owner ? p.owner.id : null;
            let finalPopulation = p.population;
            let finalStarbase = p.starbase;
            let finalHasFleet = p.has_fleet;

            // CRITICAL FOG OF WAR GUARD: If scan reports "Unknown", protect historical stats from being nuked
            if (p.is_unknown && oldP) {
                finalOwnerId = oldP.owner_id;
                finalPopulation = oldP.population;
                finalStarbase = oldP.starbase;
                finalHasFleet = oldP.has_fleet;
            }

            if (oldP) {
                // Owner Change: Skip event creation if this is an obscured shadow scan
                if (!p.is_unknown && oldP.owner_id !== finalOwnerId) {
                    logEvent.run(system_id, p.planet_index, 1, oldP.owner_id, finalOwnerId); // 1 = OWNER_CHANGE
                }
                // Significant Population Drop: Skip history generation entirely if it's an unverified/unknown scan
                if (!p.is_unknown && oldP.population > 0 && finalPopulation < oldP.population - 5) {
                    logEvent.run(system_id, p.planet_index, 2, oldP.population, finalPopulation); // 2 = POP_DROP
                }
            }

            // Standard Upsert (Skip structural updates for players/alliances if we can't see them clearly)
            if (p.owner && !p.is_unknown) {
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag, p.owner.alliance_tag); 
                upsertPlayer.run(p.owner.id, p.owner.name, p.owner.alliance_id || null);
            }
            
            // Pass the calculated final parameters securely down to the table updater
            upsertPlanet.run(p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation, finalStarbase, finalHasFleet);

            // Target fleet records cleanly: Only drop fleets on planets we have concrete vision over
            if (!p.is_unknown) {
                db.prepare(`DELETE FROM fleets WHERE system_id = ? AND planet_index = ?`).run(system_id, p.planet_index);
            }
        }

        // 2. Safely Process Fleets without wiping hidden tactical data
        if (Array.isArray(fleetsData)) {
            for (const f of fleetsData) {
                const matchingPlanet = planetsData.find(p => p.planet_index === f.planet_index);
                
                // If a fleet is reported on an obscured planet row, skip updating it (keeps historical fleet intact)
                if (matchingPlanet && matchingPlanet.is_unknown) {
                    continue;
                }

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
    
    if (!p || !p.id || !p.name) {
        return res.status(400).json({ error: 'Invalid player payload: Missing ID or Name' });
    }
    
    console.log(`\n[API] Incoming profile sync for Player ID: ${p.id} (${p.name}) [Has Intel: ${p.has_intel || 0}]`);

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
        race_defense: p.race_defense || 0,
        race_trader: p.race_trader || 0,
        race_sul: p.race_sul || 0,
        has_intel: p.has_intel || 0,
        
        // Dynamic additions mapping extracted array strings
        home_planet_id: p.home_planet_id || null,
        home_system_id: p.home_system_id || null,
        home_planet_index: p.home_planet_index || null,
        possible_homes: p.possible_homes ? JSON.stringify(p.possible_homes) : '[]'
    };

    const oldPlayer = db.prepare('SELECT logins, points, origin_system FROM players WHERE id = ?').get(p.id);

    const syncTransaction = db.transaction((player) => {
        const loginsDropped = oldPlayer && player.logins > 0 && player.logins < oldPlayer.logins;
        const originChanged = oldPlayer && oldPlayer.origin_system !== null && player.origin_system !== oldPlayer.origin_system;
        const pointsNuked = oldPlayer && oldPlayer.points > 2000 && player.points < 100;

        if (loginsDropped || originChanged || pointsNuked) {
            console.log(`[SYSTEM] Verified Player ${player.id} restarted or moved origin! Purging ghost assets.`);
            
            db.prepare(`
                UPDATE planets 
                SET owner_id = NULL, population = 0, starbase = 0, has_fleet = 0, is_sieged = 0 
                WHERE owner_id = ?
            `).run(player.id);
            
            db.prepare(`DELETE FROM fleets WHERE owner_id = ?`).run(player.id);

            db.prepare(`
                UPDATE players SET 
                    level=0, points=0, ranking=NULL, science_level=0, culture_level=0,
                    biology=0, economy=0, energy=0, mathematics=0, physics=0, social=0,
                    trade_revenue=0, artefact=NULL, eco_bonus=0,
                    race_growth=0, race_science=0, race_culture=0, race_production=0, race_speed=0, race_attack=0, race_defense=0,
                    race_trader=0, race_sul=0, origin_system=NULL, has_intel=0, intel_updated_at=NULL,
                    home_planet_id=NULL, home_system_id=NULL, home_planet_index=NULL, possible_homes='[]'
                WHERE id = ?
            `).run(player.id);
        }

        if (player.alliance_id) {
            db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag`).run(player.alliance_id, player.alliance_tag, player.alliance_tag);
        }

        db.prepare(`
            INSERT INTO players (
                id, name, alliance_id, country, local_time, idle_time, origin_system, 
                level, ranking, points, science_level, culture_level, 
                biology, economy, energy, mathematics, physics, social, 
                trade_revenue, artefact, eco_bonus,
                race_growth, race_science, race_culture, race_production, race_speed, race_attack, race_defense,
                race_trader, race_sul,
                joined, logins, has_intel, intel_updated_at,
                home_planet_id, home_system_id, home_planet_index, possible_homes
            ) VALUES (
                @id, @name, @alliance_id, @country, @local_time, @idle_time, @origin_system, 
                @level, @ranking, @points, @science_level, @culture_level, 
                @biology, @economy, @energy, @mathematics, @physics, @social, 
                @trade_revenue, @artefact, @eco_bonus,
                @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack, @race_defense,
                @race_trader, @race_sul,
                @joined, @logins, @has_intel,
                CASE WHEN @has_intel = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
                @home_planet_id, @home_system_id, @home_planet_index, @possible_homes
            ) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, alliance_id=excluded.alliance_id, country=excluded.country, 
                local_time=excluded.local_time, idle_time=excluded.idle_time, origin_system=excluded.origin_system,
                level=excluded.level, ranking=excluded.ranking, points=excluded.points, 
                science_level=excluded.science_level, culture_level=excluded.culture_level,
                joined=excluded.joined, logins=excluded.logins,
                home_planet_id=excluded.home_planet_id,
                home_system_id=excluded.home_system_id,
                home_planet_index=excluded.home_planet_index,
                possible_homes=excluded.possible_homes,
                updated_at=CURRENT_TIMESTAMP,
                
                biology = CASE WHEN excluded.has_intel = 1 THEN excluded.biology ELSE players.biology END,
                economy = CASE WHEN excluded.has_intel = 1 THEN excluded.economy ELSE players.economy END,
                energy = CASE WHEN excluded.has_intel = 1 THEN excluded.energy ELSE players.energy END,
                mathematics = CASE WHEN excluded.has_intel = 1 THEN excluded.mathematics ELSE players.mathematics END,
                physics = CASE WHEN excluded.has_intel = 1 THEN excluded.physics ELSE players.physics END,
                social = CASE WHEN excluded.has_intel = 1 THEN excluded.social ELSE players.social END,
                trade_revenue = CASE WHEN excluded.has_intel = 1 THEN excluded.trade_revenue ELSE players.trade_revenue END,
                artefact = CASE WHEN excluded.has_intel = 1 THEN excluded.artefact ELSE players.artefact END,
                eco_bonus = CASE WHEN excluded.has_intel = 1 THEN excluded.eco_bonus ELSE players.eco_bonus END,
                
                race_growth = CASE WHEN excluded.has_intel = 1 THEN excluded.race_growth ELSE players.race_growth END,
                race_science = CASE WHEN excluded.has_intel = 1 THEN excluded.race_science ELSE players.race_science END,
                race_culture = CASE WHEN excluded.has_intel = 1 THEN excluded.race_culture ELSE players.race_culture END,
                race_production = CASE WHEN excluded.has_intel = 1 THEN excluded.race_production ELSE players.race_production END,
                race_speed = CASE WHEN excluded.has_intel = 1 THEN excluded.race_speed ELSE players.race_speed END,
                race_attack = CASE WHEN excluded.has_intel = 1 THEN excluded.race_attack ELSE players.race_attack END,
                race_defense = CASE WHEN excluded.has_intel = 1 THEN excluded.race_defense ELSE players.race_defense END,
                race_trader = CASE WHEN excluded.has_intel = 1 THEN excluded.race_trader ELSE players.race_trader END,
                race_sul = CASE WHEN excluded.has_intel = 1 THEN excluded.race_sul ELSE players.race_sul END,
                
                intel_updated_at = CASE WHEN excluded.has_intel = 1 THEN CURRENT_TIMESTAMP ELSE players.intel_updated_at END,
                has_intel = CASE WHEN excluded.has_intel = 1 THEN 1 ELSE players.has_intel END
        `).run(player);

        if (player.logins > 0 && (!oldPlayer || oldPlayer.logins !== player.logins)) {
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

// --- GET PLAYER INTEL STATUS FOR ALLIANCE PROFILE INJECTION ---
router.get('/alliance-intel/:allianceId', requireAuth, (req, res) => {
    try {
        const allianceId = req.params.allianceId;
        const rows = db.prepare(`
            SELECT id FROM players 
            WHERE alliance_id = ? AND has_intel = 1
        `).all(allianceId);

        const intelIds = rows.map(row => row.id);
        res.json(intelIds);
    } catch (err) {
        console.error('Failed to fetch alliance intel flags:', err);
        res.status(500).json({ error: 'Database error' });
    }
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

// --- GET FULL SYSTEM INTEL (Planets, Fleets, History, Plans) ---
router.get('/intel/system/:id', requireAuth, (req, res) => {
    try {
        const sysId = req.params.id;

        // 1. Get Planets & Owners (Updated to grab joined Guarded Ranking values)
        const planets = db.prepare(`
            SELECT p.planet_index, p.population, p.starbase, p.has_fleet, p.is_sieged, p.game_planet_id,
                   u.name as owner_name, u.home_system_id, u.home_planet_index, u.possible_homes, 
                   a.tag as alliance_tag,
                   bg.cv as guard_cv
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            LEFT JOIN best_guarded bg ON p.game_planet_id = bg.game_planet_id
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

// --- RANKING: BEST GUARDED DATA INGESTION SYNC LAYER ---
router.post('/sync/best-guarded', requireAuth, (req, res) => {
    const { last_update, entries } = req.body;
    if (!last_update || !Array.isArray(entries)) {
        return res.status(400).json({ error: 'Invalid rank tracking payload payload data structures' });
    }

    // Daily lock guard check against the exact server tick date signature
    const existingCheck = db.prepare("SELECT COUNT(*) as count FROM best_guarded WHERE updated_at = ?").get(last_update);
    if (existingCheck.count > 0) {
        return res.json({ success: true, skipped: true, message: 'Rankings already updated for today.' });
    }

    console.log(`[API] Processing fresh Best Guarded ranking sync batch updated at: ${last_update}`);

    const syncTx = db.transaction((rows) => {
        db.prepare("DELETE FROM best_guarded").run(); // Clear stale indices safely
        
        const insertStmt = db.prepare(`
            INSERT INTO best_guarded (game_planet_id, cv, updated_at) 
            VALUES (?, ?, ?)
        `);
        
        for (const row of rows) {
            insertStmt.run(row.planet_id, row.cv, last_update);
        }
    });

    try {
        syncTx(entries);
        res.json({ success: true, skipped: false });
    } catch (err) {
        console.error('[DB Error] Best Guarded sync process failure:', err);
        res.status(500).json({ error: 'Database ranking sync error event' });
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

// --- GET PLAYER DETAIL WITH INTEL MAP COORDINATES ---
router.get('/intel/player/:id', requireAuth, (req, res) => {
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

        // NEW: Fetch all distinct coordinates where this player owns assets
        const systems = db.prepare(`
            SELECT DISTINCT s.id, s.name, s.x, s.y
            FROM planets p
            JOIN systems s ON p.system_id = s.id
            WHERE p.owner_id = ?
        `).all(playerId);

        // --- Fetch historical logins for the Line Chart ---
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

        // --- Fetch the Online Probability Heatmap ---
        let heatmap = Array(24).fill(0);
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
            heatmap: heatmap,
            systems: systems // <-- Injected payload
        });

    } catch (error) {
        console.error('[API] Error fetching player intel:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// --- ALLIANCE STATS RECEIVER & SYNC ---
router.post('/sync/alliance-stats', requireAuth, (req, res) => {
    const s = req.body;
    if (!s.player_id) return res.status(400).json({ error: 'Missing Player ID' });

    let nextCultureAt = null;
    if (s.next_culture_seconds !== null && !isNaN(s.next_culture_seconds)) {
        nextCultureAt = new Date(Date.now() + s.next_culture_seconds * 1000).toISOString();
    }

    try {
        db.prepare(`
            INSERT INTO alliance_member_stats (
                player_id, planets_text, next_culture_at, science_rate, culture_rate, production_rate,
                astro_dollars, production_points, artefact, level_text, cv_limit_text,
                economy, energy, mathematics, physics, population, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET
                planets_text=excluded.planets_text,
                next_culture_at=excluded.next_culture_at,
                science_rate=excluded.science_rate,
                culture_rate=excluded.culture_rate,
                production_rate=excluded.production_rate,
                astro_dollars=excluded.astro_dollars,
                production_points=excluded.production_points,
                artefact=excluded.artefact,
                level_text=excluded.level_text,
                cv_limit_text=excluded.cv_limit_text,
                economy=excluded.economy,
                energy=excluded.energy,
                mathematics=excluded.mathematics,
                physics=excluded.physics,
                population=excluded.population,
                updated_at=CURRENT_TIMESTAMP
        `).run(
            s.player_id, s.planets_text, nextCultureAt, s.science_rate, s.culture_rate, s.production_rate,
            s.astro_dollars, s.production_points, s.artefact, s.level_text, s.cv_limit_text,
            s.economy, s.energy, s.mathematics, s.physics, s.population
        );

        db.prepare(`
            INSERT INTO players (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=CURRENT_TIMESTAMP
        `).run(s.player_id, s.name);

        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Alliance member stats sync failed:", err);
        res.status(500).json({ error: 'Database transaction failed' });
    }
});

// --- ALLIANCE STATS FETCH FOR THE ARCHIVE PANEL ---
router.get('/intel/alliance-stats', requireAuth, (req, res) => {
    try {
        const stats = db.prepare(`
            SELECT s.*, p.name as player_name
            FROM alliance_member_stats s
            LEFT JOIN players p ON s.player_id = p.id
            ORDER BY s.player_id ASC
        `).all();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve alliance metrics' });
    }
});

// --- GET ALL ACTIVE SCANNED ALLIANCES FOR SELECTION FILTER BUTTONS ---
router.get('/intel/war-room/alliances', requireAuth, (req, res) => {
    try {
        const alliances = db.prepare(`
            SELECT a.id, a.tag, a.name, COUNT(p.id) as active_members_count, MAX(p.updated_at) as last_scan_time
            FROM alliances a
            JOIN players p ON p.alliance_id = a.id
            GROUP BY a.id
            HAVING active_members_count >= 1
            ORDER BY active_members_count DESC, a.tag ASC
        `).all();
        res.json({ success: true, alliances });
    } catch (err) {
        console.error("[DB Error] Failed to fetch active alliances for War Room:", err);
        res.status(500).json({ error: 'Failed to retrieve filter metrics' });
    }
});

// --- GET ENEMY DATA MATRIX FOR CHOSEN ALLIANCE ---
router.get('/intel/war-room/players', requireAuth, (req, res) => {
    const { alliance_id } = req.query;
    if (!alliance_id) return res.status(400).json({ error: 'Missing Alliance Identifier selection' });

    try {
        const players = db.prepare(`
            SELECT p.id, p.name, p.economy, p.social, p.physics, p.mathematics, p.energy, p.idle_time,
                   p.race_attack, p.race_defense, p.race_speed, p.updated_at as player_scan_time,
                   p.total_population, p.total_factories, p.total_farms, p.total_cybernets, p.total_labs,
                   a.tag as alliance_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as total_planets
            FROM players p
            JOIN alliances a ON p.alliance_id = a.id
            WHERE p.alliance_id = ?
        `).all(alliance_id);

        res.json({ success: true, players });
    } catch (err) {
        console.error("[DB Error] Failed to execute query array for War Room Matrix:", err);
        res.status(500).json({ error: 'Failed to pull target metrics record dataset' });
    }
});

// --- UNIFIED OPERATIONS TIMELINE ---
router.get('/intel/timeline', requireAuth, (req, res) => {
    try {
        const timeline = db.prepare(`
            SELECT f.*, 
                   s.name as system_name, s.x, s.y,
                   p.name as owner_name, a.tag as alliance_tag,
                   pl.note as plan_note, u.game_name as plan_author
            FROM fleets f
            LEFT JOIN systems s ON f.system_id = s.id
            LEFT JOIN players p ON f.owner_id = p.id
            LEFT JOIN alliances a ON p.alliance_id = a.id
            -- Correlate tactical plan logs to matching destinations
            LEFT JOIN planet_plans pl ON f.system_id = pl.system_id AND f.planet_index = pl.planet_index
            LEFT JOIN app_users u ON pl.author_id = u.id
            WHERE f.arrival_time IS NOT NULL AND f.arrival_time != '-'
            ORDER BY f.arrival_time ASC
        `).all();

        res.json({ success: true, timeline });
    } catch (err) {
        console.error("[DB Error] Failed to generate timeline dataset:", err);
        res.status(500).json({ error: 'Failed to build timeline dataset' });
    }
});

// --- GET TAKEOVER PIPELINE STATE ---
router.get('/intel/takeover/:systemId', requireAuth, (req, res) => {
    try {
        const sysId = req.params.systemId;
        const board = db.prepare(`
            SELECT p.planet_index, p.population, p.starbase, p.has_fleet,
                   u.name as owner_name, a.tag as alliance_tag,
                   t.assigned_name, t.pipeline_status, t.target_arrival_time,
                   runner.energy as runner_energy, runner.race_speed as runner_speed,
                   sys_target.x as target_x, sys_target.y as target_y,
                   sys_origin.x as origin_x, sys_origin.y as origin_y
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            LEFT JOIN planet_takeovers t ON p.system_id = t.system_id AND p.planet_index = t.planet_index
            LEFT JOIN players runner ON LOWER(t.assigned_name) = LOWER(runner.name)
            LEFT JOIN systems sys_target ON p.system_id = sys_target.id
            LEFT JOIN systems sys_origin ON runner.origin_system = sys_origin.id
            WHERE p.system_id = ?
            ORDER BY p.planet_index ASC
        `).all(sysId);

        res.json({ success: true, board });
    } catch (err) {
        console.error("[DB Error] Failed to generate takeover context board:", err);
        res.status(500).json({ error: 'Failed to load pipeline datasets' });
    }
});

// --- UPDATE PLANET TAKEOVER NODE ---
router.post('/intel/takeover', requireAuth, (req, res) => {
    const { system_id, planet_index, assigned_name, pipeline_status, target_arrival_time } = req.body;
    if (!system_id || !planet_index) return res.status(400).json({ error: 'Missing parameters' });

    try {
        db.prepare(`
            INSERT INTO planet_takeovers (system_id, planet_index, assigned_name, pipeline_status, target_arrival_time, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(system_id, planet_index) DO UPDATE SET
                assigned_name = CASE WHEN excluded.assigned_name = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.assigned_name, assigned_name) END,
                pipeline_status = COALESCE(excluded.pipeline_status, pipeline_status),
                target_arrival_time = CASE WHEN excluded.target_arrival_time = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.target_arrival_time, target_arrival_time) END,
                updated_at = CURRENT_TIMESTAMP
        `).run(system_id, planet_index, assigned_name || null, pipeline_status || null, target_arrival_time || null);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to balance metrics adjustment sequence' });
    }
});

module.exports = router;