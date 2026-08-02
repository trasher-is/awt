const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { parseLocaleInt } = require('../../public/js/utils/parse-number.js');
const { previousNames, findByFormerName } = require('../utils/round-archive');
const router = express.Router();

// --- WHO USED TO BE CALLED THIS ---
// The reverse lookup. Searching for a name that no longer exists should find the account
// that used it, because "who was Elfenlied" is a question people actually ask and the
// answer — Chewie, id 39 — is the whole reason the archive exists.
router.get('/intel/former-names', requireAuth, (req, res) => {
    try {
        res.json({ success: true, results: findByFormerName(db, req.query.q) });
    } catch (err) {
        console.error('[DB Error] Former-name lookup failed:', err);
        res.status(500).json({ error: 'Former-name lookup failed' });
    }
});

// --- GET ENEMY DATA MATRIX FOR CHOSEN ALLIANCE ---
router.get('/intel/war-room/players', requireAuth, (req, res) => {
    const { alliance_id } = req.query;
    if (!alliance_id) return res.status(400).json({ error: 'Missing Alliance Identifier selection' });

    try {
        const players = db.prepare(`
            SELECT p.id, p.name, p.economy, p.social, p.physics, p.mathematics, p.energy, p.biology, p.idle_time,
                   p.race_attack, p.race_defense, p.race_speed, p.race_production, p.race_science,
                   p.updated_at as player_scan_time, p.intel_updated_at,
                   p.total_population, p.total_factories, p.total_farms, p.total_cybernetics, p.total_labs,
                   p.trade_revenue, p.artefact,
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
            SELECT e.id, e.planet_index, e.event_type_id, e.timestamp, e.old_value, e.new_value,
                   o1.name as old_owner, o2.name as new_owner
            FROM planet_events e
            LEFT JOIN players o1 ON e.old_value = o1.id AND e.event_type_id = 1
            LEFT JOIN players o2 ON e.new_value = o2.id AND e.event_type_id = 1
            WHERE e.system_id = ?
            ORDER BY e.timestamp DESC, e.id DESC
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

// --- GALAXY ARCHIVE MAP ---
// Everything the map panel draws, in one request.
//
// It is deliberately NOT the planets database with a canvas on top. planets_db returns
// every planet row in the archive and the map needs one summary per system, so building
// it here keeps a galaxy's worth of rows on this side of the wire instead of shipping
// megabytes to a browser that would immediately reduce them.
//
// ─── WHAT THIS MAP IS, AND WHAT IT IS NOT ─────────────────────────────────────
// The game already draws a live map, and public/js/core/spy.js already annotates it. This
// one exists for what that map cannot show: the whole galaxy at once, systems currently
// out of vision, and ownership as of the last time anybody looked — with the age of that
// answer visible rather than implied.
//
// The two halves of the data have very different coverage, and the panel has to say so:
//   • coordinates are COMPLETE. galaxy-parser.js reads them from the travel calculator's
//     system dropdown, which lists every system in the galaxy whether or not it has ever
//     been scanned.
//   • contents are whatever has been scanned. A system with no planet rows is not an
//     empty system, it is an unvisited one, and drawing those two the same way would
//     turn a gap in our intel into a claim about the galaxy.
router.get('/intel/galaxy-map', requireAuth, (req, res) => {
    try {
        const systems = db.prepare(`
            SELECT s.id, s.name, s.x, s.y, s.updated_at
            FROM systems s
            WHERE s.x IS NOT NULL AND s.y IS NOT NULL
        `).all();

        // One row per (system, owning alliance). owner_id is NULL for a planet seen to be
        // unowned, and also for one whose owner has never been scraped — those are counted
        // separately as `free` and `unknown` rather than merged into "nobody".
        const ownership = db.prepare(`
            SELECT p.system_id,
                   a.id  AS alliance_id,
                   a.tag AS alliance_tag,
                   COUNT(*) AS planets,
                   SUM(CASE WHEN p.owner_id IS NULL OR p.owner_id = 0 THEN 1 ELSE 0 END) AS free_planets,
                   SUM(CASE WHEN p.is_sieged = 1 THEN 1 ELSE 0 END) AS sieged_planets,
                   MAX(p.updated_at) AS last_seen
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            GROUP BY p.system_id, a.id
        `).all();

        // The alliance this hub belongs to: the members whose stats have been collected.
        // alliance_member_stats is what the existing alliance-vision overlay treats as
        // "us", so the map agrees with it rather than inventing a second definition.
        const memberIds = db.prepare(`SELECT player_id FROM alliance_member_stats`).all().map(r => r.player_id);
        const ownTag = memberIds.length
            ? (db.prepare(`
                SELECT a.tag, COUNT(*) AS n
                FROM players p JOIN alliances a ON p.alliance_id = a.id
                WHERE p.id IN (${memberIds.map(() => '?').join(',')})
                GROUP BY a.tag ORDER BY n DESC LIMIT 1
              `).get(...memberIds) || {}).tag || null
            : null;

        // Observers for the vision layer. Radius is NOT computed here — the rule lives in
        // public/js/utils/vision-model.js and is applied once, on the client, so the map
        // and Discord cannot drift apart again.
        const observers = memberIds.length
            ? db.prepare(`
                SELECT p.id AS playerId, p.name, p.biology, p.science_level,
                       s.id AS originSystemId, s.x, s.y
                FROM players p
                JOIN systems s ON p.origin_system = s.id
                WHERE p.id IN (${memberIds.map(() => '?').join(',')})
                  AND p.origin_system IS NOT NULL AND p.origin_system > 0
                  AND s.x IS NOT NULL AND s.y IS NOT NULL
              `).all(...memberIds)
            : [];

        const bySystem = new Map();
        for (const row of ownership) {
            let entry = bySystem.get(row.system_id);
            if (!entry) {
                entry = { known: 0, free: 0, unaligned: 0, sieged: 0, owners: [], lastSeen: null };
                bySystem.set(row.system_id, entry);
            }
            entry.known += row.planets;
            entry.free += row.free_planets;
            entry.sieged += row.sieged_planets;
            if (row.last_seen && (!entry.lastSeen || row.last_seen > entry.lastSeen)) entry.lastSeen = row.last_seen;

            if (row.alliance_id != null) {
                entry.owners.push({ allianceId: row.alliance_id, tag: row.alliance_tag, planets: row.planets });
            } else {
                // No alliance joined: either genuinely unowned, or an owner we have never
                // scraped. free_planets separates the two.
                entry.unaligned += row.planets - row.free_planets;
            }
        }

        const out = systems.map(s => {
            const agg = bySystem.get(s.id) || { known: 0, free: 0, unaligned: 0, sieged: 0, owners: [], lastSeen: null };
            const owners = agg.owners.slice().sort((a, b) => b.planets - a.planets);
            return {
                id: s.id,
                name: s.name,
                x: s.x,
                y: s.y,
                known: agg.known,
                free: agg.free,
                unaligned: agg.unaligned,
                sieged: agg.sieged,
                owners,
                // Whoever holds the most planets we know about. Ties break on tag so the
                // colour of a contested system does not flicker between reloads.
                top: owners.length
                    ? owners.filter(o => o.planets === owners[0].planets).sort((a, b) => String(a.tag).localeCompare(String(b.tag)))[0].tag
                    : null,
                lastSeen: agg.lastSeen,
            };
        });

        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            ownTag,
            systems: out,
            observers,
            // Said out loud so the panel can label itself honestly instead of the reader
            // having to infer it.
            coverage: {
                systemsKnown: out.length,
                systemsScanned: out.filter(s => s.known > 0).length,
                observersPlaced: observers.length,
                membersTracked: memberIds.length,
            },
        });
    } catch (err) {
        console.error('[DB Error] Failed to build the galaxy map:', err);
        res.status(500).json({ error: 'Failed to build the galaxy map' });
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
        } catch (err) {
            // The heatmap is optional decoration on the profile, so a failure here must
            // not fail the whole response - but it should still be visible in the log
            // rather than leaving the caller with a silently empty chart.
            console.error('[DB Error] Login heatmap unavailable:', err.message);
        }

        // Names this id went by in earlier rounds. A player id survives a round wipe;
        // the name does not, and people rename. Empty for anyone who has not renamed, so
        // the panel shows nothing rather than the player's own name repeated back.
        let formerNames = [];
        try {
            formerNames = previousNames(db, playerId, { currentName: playerInfo.name });
        } catch (err) {
            console.error('[DB Error] Name history unavailable:', err.message);
        }

        res.json({
            success: true,
            player: playerInfo,
            activity: formattedActivity,
            heatmap: heatmap,
            systems: systems, // <-- Injected payload
            formerNames
        });

    } catch (error) {
        console.error('[API] Error fetching player intel:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// --- TRADE AGREEMENT SCHEDULER DATA ---
// Returns alliance members with parsed economic numbers + the live PP market price,
// for the client-side Trade Agreement scheduler.
router.get('/intel/trade-analysis', requireAuth, (req, res) => {
    try {
        // This inline toInt stripped every non-digit, so "1,5" read as 15 and a decimal
        // rate silently became ten times itself. Same shared parser as everywhere else.
        const toInt = parseLocaleInt;

        const rows = db.prepare(`
            SELECT p.name,
                   ams.production_rate,
                   ams.astro_dollars,
                   ams.production_points,
                   p.trade_partners
            FROM alliance_member_stats ams
            JOIN players p ON p.id = ams.player_id
        `).all();

        const players = rows.map(r => {
            let partners = [];
            if (r.trade_partners) {
                try {
                    const parsed = JSON.parse(r.trade_partners);
                    if (Array.isArray(parsed)) partners = parsed.map(x => String(x).toLowerCase());
                } catch (e) { /* not JSON / empty */ }
            }
            return {
                name: r.name,
                production_rate: toInt(r.production_rate),
                astro_dollars: toInt(r.astro_dollars),
                production_points: toInt(r.production_points),
                trade_partners: partners
            };
        });

        const ppRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`).get();
        const pp_price = ppRow ? (parseFloat(ppRow.value) || 0) : 0;

        res.json({ success: true, players, pp_price });
    } catch (err) {
        console.error('[DB Error] Failed trade analysis:', err);
        res.status(500).json({ error: 'Failed to build trade analysis' });
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
// NOTE ON ACCESS: this board is intentionally communal - any logged-in member can
// reassign any planet, the same way the redzone planner is a shared scratchpad. It is
// a war-room whiteboard, not per-user data, so it is not restricted to the person named
// in assigned_name. What is fixed here is the reporting: failures used to be returned as
// an opaque message and never logged.
router.post('/intel/takeover', requireAuth, (req, res) => {
    const { system_id, planet_index, assigned_name, pipeline_status, target_arrival_time } = req.body;
    if (!Number.isInteger(Number(system_id)) || !Number.isInteger(Number(planet_index))) {
        return res.status(400).json({ error: 'system_id and planet_index must be integers' });
    }

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
        console.error('[DB Error] Failed to update takeover node:', err);
        res.status(500).json({ error: 'Failed to update the takeover board' });
    }
});

module.exports = router;
