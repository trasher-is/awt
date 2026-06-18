const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- GET ENEMY DATA MATRIX FOR CHOSEN ALLIANCE ---
router.get('/intel/war-room/players', requireAuth, (req, res) => {
    const { alliance_id } = req.query;
    if (!alliance_id) return res.status(400).json({ error: 'Missing Alliance Identifier selection' });

    try {
        const players = db.prepare(`
            SELECT p.id, p.name, p.economy, p.social, p.physics, p.mathematics, p.energy, p.idle_time,
                   p.race_attack, p.race_defense, p.race_speed, p.updated_at as player_scan_time,
                   p.total_population, p.total_factories, p.total_farms, p.total_cybernetics, p.total_labs,
                   p.level, p.culture_level, p.has_intel,
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
        // Explicitly group by all selected non-aggregate elements to avoid engine resolution errors
        const alliances = db.prepare(`
            SELECT a.id, a.tag, a.name, COUNT(p.id) as active_members_count, MAX(p.updated_at) as last_scan_time
            FROM alliances a
            JOIN players p ON p.alliance_id = a.id
            GROUP BY a.id, a.tag, a.name
            HAVING COUNT(p.id) >= 1
            ORDER BY COUNT(p.id) DESC, a.tag ASC
        `).all();
        res.json({ success: true, alliances });
    } catch (err) {
        console.error("[DB Error] Failed to fetch active alliances for War Room:", err);
        res.status(500).json({ error: 'Failed to retrieve filter metrics' });
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
