const express = require('express');
const db = require('../database');
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const plansRepo = require('../repositories/plans');
const playersRepo = require('../repositories/players');
const alliancesRepo = require('../repositories/alliances');
const battleReportsRepo = require('../repositories/battleReports');
const usersRepo = require('../repositories/users');
const { requireAuth } = require('./_middleware');
const { parseLocaleInt } = require('../../public/js/utils/parse-number.js');
const { previousNames, findByFormerName } = require('../utils/round-archive');
const settingsRepo = require('../repositories/settings');
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
        const players = playersRepo.getWarRoomPlayers(alliance_id);

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
        const rows = playersRepo.getAllianceIntelPlayerIds(allianceId);

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
        const systems = systemsRepo.countSystems();
        const planets = systemsRepo.countPlanets();
        const players = playersRepo.countPlayers();
        const alliances = alliancesRepo.countAlliances();
        const fleets = fleetsRepo.countFleets();

        res.json({ success: true, systems, planets, players, alliances, fleets });
    } catch (err) {
        console.error("[DB Error] Failed to fetch intel summary:", err);
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
});

// --- GET ALL SYSTEMS FOR MASS SCAN ---
router.get('/systems', requireAuth, (req, res) => {
    try {
        const systems = systemsRepo.listSystemIds();
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
        const playersList = playersRepo.listPlayerIds();
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

        // 0. Get the system's own name/coords — used by the sidebar header ("System Data
        // - #4 Meboula") and the out-of-vision synthetic page's heading. null when the
        // system has never been indexed at all, which callers must handle gracefully.
        const system = systemsRepo.getFullSystem(sysId) || null;

        // 1. Get Planets & Owners (Updated to grab joined Guarded Ranking values)
        const planets = systemsRepo.getSystemPlanetsWithIntel(sysId);

        // 2. Get Fleets
        const fleets = fleetsRepo.getFleetsForSystem(sysId);

        // 3. Get History (Last 10 events) - FIXED: Removed event_types table dependency
        const history = systemsRepo.getPlanetHistory(sysId);

        // 4. Get Plans
        const plans = plansRepo.getPlansForSystem(sysId);

        res.json({ success: true, system, planets, fleets, history, plans });
    } catch (err) {
        console.error("[DB Error] Failed to fetch system intel:", err);
        res.status(500).json({ error: 'Failed to fetch intel' });
    }
});

// --- FULL DATABASE ENDPOINTS ---
router.get('/intel/players', requireAuth, (req, res) => {
    try {
        // Fetch every player, join their alliance tag, and count how many planets they own in our DB
        const players = playersRepo.getFullPlayersDb();

        res.json({ success: true, players });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full player DB:", err);
        res.status(500).json({ error: 'Failed to fetch players' });
    }
});

// Get Full Systems Database
router.get('/intel/systems_db', requireAuth, (req, res) => {
    try {
        const systems = systemsRepo.getSystemsDbSummary();

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
        const systems = systemsRepo.getGalaxyMapSystems();

        // One row per (system, owning alliance). owner_id is NULL for a planet seen to be
        // unowned, and also for one whose owner has never been scraped — those are counted
        // separately as `free` and `unknown` rather than merged into "nobody".
        const ownership = systemsRepo.getGalaxyMapOwnership();

        // The alliance this hub belongs to: the members whose stats have been collected.
        // alliance_member_stats is what the existing alliance-vision overlay treats as
        // "us", so the map agrees with it rather than inventing a second definition.
        const memberIds = alliancesRepo.getAllianceMemberStatIds().map(r => r.player_id);
        const ownTag = (playersRepo.getAllianceTagForMembers(memberIds) || {}).tag || null;

        // Observers for the vision layer. Radius is NOT computed here — the rule lives in
        // public/js/utils/vision-model.js and is applied once, on the client, so the map
        // and Discord cannot drift apart again.
        const observers = playersRepo.getVisionObservers(memberIds);

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
        const planets = systemsRepo.getPlanetsFullDb();

        res.json({ success: true, planets });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full planet DB:", err);
        res.status(500).json({ error: 'Failed to fetch planets' });
    }
});

// Get Full Fleets Database
router.get('/intel/fleets_db', requireAuth, (req, res) => {
    try {
        const fleets = fleetsRepo.getFleetsFullDb();

        res.json({ success: true, fleets });
    } catch (err) {
        console.error("[DB Error] Failed to fetch full fleet DB:", err);
        res.status(500).json({ error: 'Failed to fetch fleets' });
    }
});

// --- GET ACTIVE ALLIANCE MEMBERS (From app_users) ---
router.get('/intel/members', requireAuth, (req, res) => {
    try {
        const members = usersRepo.getActiveMemberNames();
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

        const playerInfo = playersRepo.getPlayerWithPlanetCount(playerId);

        if (!playerInfo) {
            return res.json({ success: false, error: 'Player not found in database.' });
        }

        // NEW: Fetch all distinct coordinates where this player owns assets
        const systems = systemsRepo.getDistinctSystemsForPlayer(playerId);

        // --- Fetch historical logins for the Line Chart ---
        let formattedActivity = [];
        try {
            const history = playersRepo.getPlayerLoginHistory(playerId);

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
            const heatmapData = playersRepo.getPlayerLoginHeatmap(playerId);

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

        const rows = alliancesRepo.getTradeAnalysisRows();

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

        const ppRow = settingsRepo.getPpPrice();
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
        const stats = alliancesRepo.getAllianceStatsForArchive();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve alliance metrics' });
    }
});

// --- BATTLE REPORTS PAGE FEED ---
// One chronological list: real battle_reports rows (always linked to their own game
// report) merged with population-drop events that have no matching report (shown
// unlinked) — see getBattleReportsFeed's own comment for the matching rules.
router.get('/intel/battle-reports-feed', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const feed = battleReportsRepo.getBattleReportsFeed(limit);
        res.json({ success: true, feed });
    } catch (err) {
        console.error('[DB Error] Failed to fetch battle reports feed:', err);
        res.status(500).json({ error: 'Failed to retrieve battle reports feed' });
    }
});

// --- GET ALL ACTIVE SCANNED ALLIANCES FOR SELECTION FILTER BUTTONS ---
router.get('/intel/war-room/alliances', requireAuth, (req, res) => {
    try {
        // Explicitly group by all selected non-aggregate elements to avoid engine resolution errors
        const alliances = alliancesRepo.getWarRoomAlliances();
        res.json({ success: true, alliances });
    } catch (err) {
        console.error("[DB Error] Failed to fetch active alliances for War Room:", err);
        res.status(500).json({ error: 'Failed to retrieve filter metrics' });
    }
});

// --- UNIFIED OPERATIONS TIMELINE ---
router.get('/intel/timeline', requireAuth, (req, res) => {
    try {
        const timeline = fleetsRepo.getFleetsForTimeline();

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
        const board = systemsRepo.getTakeoverBoard(sysId);

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
        systemsRepo.upsertTakeover(system_id, planet_index, assigned_name || null, pipeline_status || null, target_arrival_time || null);

        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to update takeover node:', err);
        res.status(500).json({ error: 'Failed to update the takeover board' });
    }
});

module.exports = router;
