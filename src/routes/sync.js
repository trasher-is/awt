const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { announceSystemChanges } = require('../discord_bot');
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const playersRepo = require('../repositories/players');
const alliancesRepo = require('../repositories/alliances');
const settingsRepo = require('../repositories/settings');
const { mapApiReport, upsertReports, formatBattleEmbed } = require('../utils/battle-reports');
const battleReportsRepo = require('../repositories/battleReports');
const newsEventsRepo = require('../repositories/newsEvents');
const { resolveBombardmentCredit } = require('../utils/news-battle-matching');
const battlePointsRepo = require('../repositories/battlePoints');
const { postEmbed, postBattleEmbed, defuseMentions, settingValue } = require('../utils/discord-post');
const router = express.Router();

// --- MAP SCRAPER DATA RECEIVER ---
router.post('/sync/system', requireAuth, (req, res) => {
    const { system_id, planets, fleets, scan_mode } = req.body; // <-- Added fleets, scan_mode
    // scan_mode: 'galaxy' (mass-scanner.js) is currently only informational and does not
    // change behavior here. 'silent' (bulk API seed via galaxy-map.js seedPlanetsFromSectors)
    // suppresses Discord announcements below — the DB writes and planet_events history log
    // happen exactly the same either way, only the announceEvents.push() calls are skipped,
    // so a full-map bulk seed doesn't flood the channel with hundreds of stale-looking
    // transitions.

    if (!system_id || !Array.isArray(planets)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    systemsRepo.upsertSystemStub(system_id);

    // Collect human-readable events for the Discord announcer (only used during a galaxy scan)
    const announceEvents = [];
    const nameOf = (id) => {
        if (!id) return null;
        const row = playersRepo.getPlayerNameWithTag(id);
        if (!row) return `#${id}`;
        return row.alliance_tag ? `[${row.alliance_tag}] ${row.name}` : row.name;
    };

    const syncTransaction = db.transaction((planetsData, fleetsData) => {

        // 1. Process Planets, Owners, and History
        for (const p of planetsData) {

            // Server-side guard: never store impossible planet ids / indices, no matter
            // what a (possibly mobile / hub-modified) client sends.
            if (p.game_planet_id != null && (!Number.isInteger(p.game_planet_id) || p.game_planet_id <= 0)) continue;
            if (!Number.isInteger(p.planet_index) || p.planet_index < 1 || p.planet_index > 99) continue;

            // Check for history events BEFORE upserting
            const oldP = systemsRepo.getOldPlanet(system_id, p.planet_index);

            let finalOwnerId = p.owner ? p.owner.id : null;
            let finalPopulation = p.population;
            let finalStarbase = p.starbase;
            // has_fleet: DOM scrapers send an explicit 0/1; the API-sourced payload cannot
            // see fleets at all and sends null. Absent means "this payload cannot see fleet
            // state", so keep the last observation rather than nulling out a scraped marker.
            let finalHasFleet = (p.has_fleet === undefined || p.has_fleet === null)
                ? (oldP ? oldP.has_fleet : null)
                : p.has_fleet;
            // is_sieged only arrives from the API-sourced sync path (the game's hasSiege
            // flag) — DOM scrapers never send it. Absent means "this payload cannot see
            // siege state", so keep whatever we knew rather than zeroing it out.
            let finalIsSieged = (p.is_sieged === undefined || p.is_sieged === null)
                ? (oldP ? oldP.is_sieged : 0)
                : (p.is_sieged ? 1 : 0);

            // CRITICAL FOG OF WAR GUARD: If scan reports "Unknown", protect historical stats
            // from being nuked. When there's no prior row (oldP is null — a never-seen-before
            // planet), there is nothing to fall back to, so fields fall back to their current
            // "no observation" defaults instead — crucially, ownership falls back to NULL
            // rather than trusting p.owner.id: an out-of-vision seed can report is_unknown:true
            // while still carrying owner from the API's cached snapshot, and that owner may be
            // a player the hub has never seen (no players row was created for them, since the
            // upsert below also skips creating one when is_unknown is true). Inserting a
            // planets row with owner_id pointing at a nonexistent player trips the
            // FOREIGN KEY(owner_id) REFERENCES players(id) constraint and rolls back the
            // WHOLE system's transaction, not just this one planet.
            // NOTE: updated_at below still stamps CURRENT_TIMESTAMP even when the guard
            // preserves stale values — it reflects "last synced", not "last confirmed fresh".
            // is_in_vision (systems table) is the actual freshness signal, not updated_at.
            if (p.is_unknown) {
                finalOwnerId = oldP ? oldP.owner_id : null;
                finalPopulation = oldP ? oldP.population : finalPopulation;
                finalStarbase = oldP ? oldP.starbase : finalStarbase;
                finalHasFleet = oldP ? oldP.has_fleet : finalHasFleet;
                finalIsSieged = oldP ? oldP.is_sieged : finalIsSieged;
            }

            // SOFT-UNKNOWN GUARD: a scan can fail to pick up the owner link while the
            // planet is clearly still inhabited (population > 0). Treat that like fog of
            // war — keep the last known owner instead of nulling it. Without this, the
            // owner gets wiped, the next scan re-detects it, and we log a bogus
            // "NULL → owner" event every cycle (destroying real history). Only let
            // ownership clear to NULL when the planet is genuinely empty (pop 0).
            if (!p.is_unknown && finalOwnerId == null && finalPopulation > 0 && oldP && oldP.owner_id != null) {
                finalOwnerId = oldP.owner_id;
            }

            if (oldP && !p.is_unknown) {
                // Skip all event creation on obscured shadow scans (guarded above).
                if (oldP.owner_id !== finalOwnerId) {
                    // OWNER CHANGE — takes precedence; a pop drop that comes with a new
                    // owner is really just the conquest, already captured here.
                    systemsRepo.logPlanetEvent(system_id, p.planet_index, 1, oldP.owner_id, finalOwnerId); // 1 = OWNER_CHANGE (history)
                    // Announce genuine transitions to Discord, but NOT "Empty -> owner":
                    // those are low-value new colonies, and while the planets table heals
                    // from the old null-purge corruption every re-detected owner would look
                    // like one and flood the channel. Conquests (X->Y) and losses (X->Empty)
                    // still announce; the history event above is recorded regardless.
                    if (oldP.owner_id != null && scan_mode !== 'silent') {
                        announceEvents.push({
                            planet_index: p.planet_index,
                            type: 'OWNER_CHANGE',
                            old_owner: nameOf(oldP.owner_id),
                            new_owner: p.owner
                                ? (p.owner.alliance_tag ? `[${p.owner.alliance_tag}] ${p.owner.name}` : p.owner.name)
                                : nameOf(finalOwnerId)
                        });
                    }
                } else if (finalOwnerId != null) {
                    // POP DROP — same owner, population fell (attack/siege). Any decrease
                    // counts (20→19, 5→1); only fired for an owned planet so empty slots
                    // don't generate noise.
                    const oldPop = Number(oldP.population);
                    const newPop = Number(finalPopulation);
                    if (Number.isFinite(oldPop) && Number.isFinite(newPop) && newPop < oldPop) {
                        systemsRepo.logPlanetEvent(system_id, p.planet_index, 2, oldPop, newPop); // 2 = POP_DROP
                        if (scan_mode !== 'silent') announceEvents.push({
                            planet_index: p.planet_index,
                            type: 'POP_DROP',
                            old_pop: oldPop,
                            new_pop: newPop
                        });
                    }
                }
            }

            // Standard Upsert (Skip structural updates for players/alliances if we can't see them clearly)
            if (p.owner && !p.is_unknown) {
                // A system scan only ever sees the tag, so it seeds `name` from the tag and
                // leaves name alone on conflict (the alliance-profile sync owns the real
                // name). `?? ''` because alliances.name is NOT NULL and a tag can be absent.
                if (p.owner.alliance_id) alliancesRepo.upsertAllianceBasic(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                playersRepo.recordNameChangeIfDifferent(p.owner.id, typeof p.owner.name === 'string' ? p.owner.name : null);
                playersRepo.upsertPlayerBasic(p.owner.id, p.owner.name, p.owner.alliance_id || null);
            }

            // Pass the calculated final parameters securely down to the table updater.
            // Re-home the planet if its id currently lives at another slot (avoids the
            // game_planet_id UNIQUE collision that would otherwise roll back the system).
            if (p.game_planet_id != null) {
                systemsRepo.clearMovedPlanet(p.game_planet_id, system_id, p.planet_index);
            }
            systemsRepo.upsertPlanet(
                p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation,
                finalStarbase, finalHasFleet, finalIsSieged,
                typeof p.name === 'string' ? p.name : null
            );
        }

        // NOTE: Fleet positions are no longer derived from system scans. They are now
        // sourced exclusively from the alliance scan (each member's own alliance page
        // lists their stationed fleets), which gives complete, self-cleaning coverage —
        // including offline members — instead of whatever happened to be visible in a
        // browsed system. See /sync/alliance-stats. `fleetsData` is intentionally ignored.
    });

    try {
        syncTransaction(planets, fleets || []);

        // Announce detected planet events to Discord — both during a full galaxy scan
        // and during normal map browsing.
        if (announceEvents.length > 0) {
            const sys = systemsRepo.getSystemCoords(system_id) || { id: system_id };
            announceSystemChanges(sys, announceEvents).catch(err =>
                console.error('[Discord] announce error:', err.message)
            );
        }

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

        home_planet_id: p.home_planet_id || null,
        home_system_id: p.home_system_id || null,
        home_planet_index: p.home_planet_index || null,
        possible_homes: p.possible_homes ? JSON.stringify(p.possible_homes) : '[]',

        // Infrastructure Trackers (Parsed from page elements but distinct from Intel state changes)
        total_planets: p.total_planets || 0,
        total_population: p.total_population || 0,
        total_farms: p.total_farms || 0,
        total_factories: p.total_factories || 0,
        total_labs: p.total_labs || 0,
        total_cybernetics: p.total_cybernetics || 0,
        cv_used: p.cv_used || 0,
        cv_limit: p.cv_limit || 0
    };

    const oldPlayer = playersRepo.getPlayerRestartCheck(p.id);

    playersRepo.recordNameChangeIfDifferent(p.id, safePlayer.name);

    const syncTransaction = db.transaction((player) => {
        // Restart detection. Planet ownership is NEVER touched here — that belongs to
        // system scans (authoritative, logged, fog-of-war guarded); nulling planets from a
        // profile heuristic was what corrupted 1200+ rows and spammed Discord. This block
        // only resets a genuinely-restarted player's own stale profile stats.
        //
        // Two signals mark a real restart, matching how the game actually behaves:
        //   • Origin moved between two VISIBLE coordinates. A restart relocates the home
        //     system, but a fog-of-war scan that just can't see Origin leaves it null — so
        //     require BOTH old and new origin to be real systems (>0) and different. Never
        //     N/A -> value or value -> N/A (those are visibility changes, not restarts).
        //   • Logins collapsed. The login counter only ever climbs, so a large drop (e.g.
        //     500 -> 2) can only be a fresh account. Require a big relative fall from a
        //     meaningful base, so ordinary parser jitter (500 -> 498) never counts.
        // Points are deliberately NOT a signal: players lose points normally when their
        // planets get pop-killed, so a points crash does not imply a restart.
        const originChanged = oldPlayer
            && Number.isInteger(player.origin_system) && player.origin_system > 0
            && Number.isInteger(oldPlayer.origin_system) && oldPlayer.origin_system > 0
            && player.origin_system !== oldPlayer.origin_system;
        const loginsReset = oldPlayer
            && oldPlayer.logins >= 10 && player.logins > 0
            && player.logins < oldPlayer.logins * 0.5;

        if (originChanged || loginsReset) {
            console.log(`[SYSTEM] Player ${player.id} restart detected (${originChanged ? 'origin moved' : 'logins reset'}); resetting stale profile stats.`);

            fleetsRepo.deleteFleetsByOwner(player.id);
            playersRepo.resetPlayerOnRestart(player.id);
        }

        if (player.alliance_id) {
            // As in the system scan above: seed name from the tag, `?? ''` because
            // alliances.name is NOT NULL and the tag may be missing.
            alliancesRepo.upsertAllianceTagOnly(player.alliance_id, player.alliance_tag ?? null, player.alliance_tag ?? '');
        }

        playersRepo.upsertPlayerFull(player);

        if (player.logins > 0 && (!oldPlayer || oldPlayer.logins !== player.logins)) {
            playersRepo.insertPlayerLogin(player.id, player.logins);
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

// --- PLAYER API-SCAN CLAIM ---
// Hands out the next batch of stale player ids for the background Player/{id} sweep. A
// "claim" here is just bumping last_api_scan_at now — an optimistic claim, not a locked
// reservation. If the caller's browser fails to actually scan them, they simply become
// stale again after one full sweep cycle and get offered to whoever asks next. See this
// plan's Global Constraints for why a full claims table wasn't built.
// POST, not GET: this mutates last_api_scan_at for up to 200 rows on every call, which
// would otherwise be a write reachable via a bare GET (accidental browser prefetch/retry),
// bypassing the guest-write gate that only inspects the verb (see _middleware.js).
router.post('/sync/player-scan-claim', requireAuth, (req, res) => {
    const rawLimit = (req.body && req.body.limit != null) ? req.body.limit : req.query.limit;
    const limit = Math.min(parseInt(rawLimit, 10) || 20, 200);
    const ids = playersRepo.getStalePlayerIdsForApiScan(limit);
    if (ids.length) playersRepo.markPlayersApiScanned(ids);
    res.json({ success: true, ids });
});

// --- PLAYER LIST RECEIVER (ListPlayer bulk sync) ---
router.post('/sync/player-list', requireAuth, (req, res) => {
    const { players } = req.body;
    if (!Array.isArray(players) || players.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let stored = 0;
    for (const p of players) {
        if (!Number.isInteger(p.id) || p.id <= 0) continue;
        const newName = typeof p.name === 'string' ? p.name : null;
        playersRepo.recordNameChangeIfDifferent(p.id, newName);
        playersRepo.upsertPlayerFromApiList(
            p.id, newName,
            Number.isInteger(p.alliance_id) ? p.alliance_id : null,
            Number.isInteger(p.level) ? p.level : null,
            Number.isInteger(p.points) ? p.points : null,
            Number.isInteger(p.rank) ? p.rank : null,
            typeof p.country === 'string' ? p.country : null,
            p.is_active_player ? 1 : 0,
            typeof p.joined === 'string' ? p.joined : null
        );
        stored++;
    }
    res.json({ success: true, count: stored });
});

// Every intel field a valid API IntelligenceReport is expected to carry when it's present
// at all. artefact is deliberately excluded from the "must be a finite number" check below
// (it's a nullable string column — legitimately null whenever the player has no active
// artefact, same as the scrape path's safePlayer treats it) — it's checked separately.
const INTEL_NUMERIC_FIELDS = [
    'biology', 'economy', 'energy', 'mathematics', 'physics', 'social', 'trade_revenue',
    'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed',
    'race_attack', 'race_defense', 'race_trader', 'race_sul',
];
const RACE_FIELDS = [
    'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed',
    'race_attack', 'race_defense', 'race_trader', 'race_sul',
];

// Guards against Finding 1's failure class (see issues #46/#48): the scrape path normalizes
// every field before binding (safePlayer above), so upsertPlayerFull's has_intel CASE guard
// is only ever fed a fully-formed row. The API detail path has no equivalent normalization
// upstream — player-api-sync.js maps each intel field independently from the API's
// IntelligenceReport, so a missing/misnamed sub-object (e.g. `race`) can silently produce a
// payload with has_intel:1 and every race_* field null. Trusting that signal would permanently
// null out a player's hard-won intel through the CASE guard. So: has_intel is only honored
// when EVERY numeric intel field actually arrived as a real number, and artefact is either a
// string or explicitly null.
function hasCompleteIntel(p) {
    if (!INTEL_NUMERIC_FIELDS.every(f => typeof p[f] === 'number' && Number.isFinite(p[f]))) return false;
    if (p.artefact !== null && typeof p.artefact !== 'string') return false;
    return true;
}

// --- PLAYER DETAIL RECEIVER (Player/{id} sync) ---
router.post('/sync/player-detail', requireAuth, (req, res) => {
    const p = req.body && req.body.player;
    if (!p || !Number.isInteger(p.id) || p.id <= 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const newName = typeof p.name === 'string' ? p.name : null;
    playersRepo.recordNameChangeIfDifferent(p.id, newName);

    // Normalize before touching SQL — see hasCompleteIntel above. Never trust the API
    // path's own has_intel flag directly; only honor it when every intel field it implies
    // actually arrived intact. A partial/malformed payload falls back to has_intel:0, so
    // the upsert's CASE guard preserves ALL existing intel columns together rather than
    // risking a partial (silently corrupting) overwrite.
    const detail = { ...p, name: newName, has_intel: (p.has_intel && hasCompleteIntel(p)) ? 1 : 0 };

    // Race is write-once per round: once a player has ANY race_* value on record, a later
    // detail sync must not be allowed to change it, even when has_intel validly resolves to
    // 1. Overwrite the incoming payload's race_* fields with whatever is already stored, so
    // the upsert's own CASE guard just re-writes the same values (a no-op in effect). A
    // player with no race on record yet still gets the API's values written normally.
    if (detail.has_intel === 1) {
        const existingRace = playersRepo.getPlayerRaceValues(p.id);
        // has_intel, not "is the column non-zero", is the real "race already on record"
        // signal — race_* columns default to 0 for every player row, so testing the raw
        // value would lock in zeros for every player on their very first detail sync.
        if (existingRace && existingRace.has_intel) {
            for (const f of RACE_FIELDS) detail[f] = existingRace[f];
        }
    }

    try {
        playersRepo.upsertPlayerFromApiDetail(detail);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync player detail ${p.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- ROUND AGE (for client-side cadence decisions, e.g. ListPlayer pull frequency) ---
router.get('/round-age', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT MAX(archived_at) as last_archived FROM rounds`).get();
    if (!row || !row.last_archived) return res.json({ success: true, days_since: null });
    const days = Math.floor((Date.now() - Date.parse(row.last_archived)) / (24 * 3600 * 1000));
    res.json({ success: true, days_since: days });
});

// --- ALLIANCE PROFILE SCRAPER RECEIVER ---
router.post('/sync/alliance', requireAuth, (req, res) => {
    const body = req.body;

    if (!body || !body.id) return res.status(400).json({ error: 'Invalid alliance payload' });

    // Normalise before touching SQL. Two reasons:
    //   • The game allows an alliance with NO name (only a tag) — e.g. ZiK, PUNX. The
    //     parser sends name:null for those, and alliances.name is NOT NULL, so the upsert
    //     died with "NOT NULL constraint failed: alliances.name" on every scan of them.
    //     Nameless alliances are stored as '' (which is what the existing rows use).
    //   • The row was passed straight to a named-parameter statement, so a payload missing
    //     any single field threw "Missing named parameter" instead of syncing.
    const ally = {
        id: body.id,
        name: body.name == null ? '' : String(body.name),
        tag: body.tag == null ? null : String(body.tag),
        leader_id: body.leader_id ?? null,
        ranking: body.ranking ?? null,
        points: body.points ?? null,
        members: body.members
    };

    console.log(`\n[API] Incoming profile sync for Alliance ID: ${ally.id} (${ally.tag})`);

    const syncTransaction = db.transaction((a) => {
        // 1. Upsert Alliance Data
        alliancesRepo.upsertAllianceFull(a);

        // 2. Map all members to this Alliance
        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                playersRepo.recordNameChangeIfDifferent(member.id, typeof member.name === 'string' ? member.name : null);
                playersRepo.upsertAllianceMemberBasic(member.id, member.name, a.id);
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

// --- ALLIANCE SEARCH RESULT RECEIVER ---
// API-search-sourced, distinct from /sync/alliance's scrape shape above (no leader_id,
// ranking, points, or members[] — Alliance/search doesn't return any of those). Batch:
// the member's browser can send everything Alliance/search returned in one call.
router.post('/sync/alliance-search', requireAuth, (req, res) => {
    const { alliances } = req.body;
    if (!Array.isArray(alliances) || alliances.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let stored = 0;
    const syncTransaction = db.transaction((list) => {
        for (const a of list) {
            if (!Number.isInteger(a.id) || a.id <= 0) continue;
            alliancesRepo.upsertAllianceFromApiSearch(
                a.id,
                a.name == null ? '' : String(a.name),
                a.tag == null ? null : String(a.tag),
                typeof a.full_name === 'string' ? a.full_name : null,
                Number.isInteger(a.member_count) ? a.member_count : null
            );
            stored++;
        }
    });

    try {
        syncTransaction(alliances);
        res.json({ success: true, count: stored });
    } catch (err) {
        console.error('[DB Error] Failed to sync alliance search results:', err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- FLEET ID BACKFILL ---
// Alliance scans give fleet positions but not game fleet ids (those only appear on the
// system map). The News refresh parses the relevant systems and posts the ids here so we
// can build Game/Fleets/Launch deep-links. Matches existing fleet rows by owner+location.
router.post('/sync/fleet-ids', requireAuth, (req, res) => {
    const list = Array.isArray(req.body.fleets) ? req.body.fleets : [];
    if (!list.length) return res.json({ success: true, updated: 0 });
    try {
        let updated = 0;
        const tx = db.transaction((rows) => {
            for (const f of rows) {
                if (!Number.isInteger(f.game_fleet_id) || !Number.isInteger(f.owner_id)) continue;
                if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                updated += fleetsRepo.updateFleetGameId(f.game_fleet_id, f.owner_id, f.system_id, f.planet_index).changes;
            }
        });
        tx(list);
        res.json({ success: true, updated });
    } catch (err) {
        console.error('[DB Error] fleet-id backfill failed:', err.message);
        res.status(500).json({ error: 'Fleet id sync failed' });
    }
});

// --- GALAXY MASTER INDEX RECEIVER ---
router.post('/sync/galaxy', requireAuth, (req, res) => {
    const { systems } = req.body;

    if (!Array.isArray(systems) || systems.length === 0) {
        return res.status(400).json({ error: 'Invalid galaxy payload' });
    }

    console.log(`\n[API] Incoming Galaxy Index sync (${systems.length} systems)`);

    // x/y land in INTEGER-affinity columns, but a bound non-numeric string is stored as
    // TEXT and later reaches the map UI, so coerce here at the trust boundary: a system id
    // must be a positive integer, and x/y become real numbers or the row is skipped. This
    // keeps a member-supplied string from ever persisting as coordinates (defence in depth
    // for the map's own esc(); one bad row is skipped, never aborts the batch).
    const coord = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    let stored = 0;
    const syncTransaction = db.transaction((sysList) => {
        for (const s of sysList) {
            if (!Number.isInteger(s.id) || s.id <= 0) continue;
            const x = coord(s.x);
            const y = coord(s.y);
            if (x === null || y === null) continue;
            systemsRepo.upsertSystemFull(
                s.id,
                typeof s.name === 'string' ? s.name : null,
                x, y,
                typeof s.full_name === 'string' ? s.full_name : null,
                typeof s.info === 'string' ? s.info : null,
                Number.isInteger(s.population_level) ? s.population_level : null
            );
            stored++;
        }
    });

    try {
        syncTransaction(systems);
        res.json({ success: true, count: stored });
    } catch (err) {
        console.error(`[DB Error] Failed to sync galaxy index:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- SYSTEM VISIBILITY FLAG RECEIVER ---
// Map/sectors reports isInVision per system: whether the returned planet data is live or
// the game's last-known cache for territory outside anyone's current vision. This is
// purely a staleness signal for later UI use — it does not affect the fog-of-war merge in
// /sync/system (the client marks affected planets is_unknown before calling that route);
// this route only records the flag itself for display.
router.post('/sync/system-in-vision', requireAuth, (req, res) => {
    const { systems } = req.body;
    if (!Array.isArray(systems) || systems.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let updated = 0;
    for (const s of systems) {
        if (!Number.isInteger(s.id) || s.id <= 0) continue;
        if (systemsRepo.setSystemInVision(s.id, !!s.is_in_vision) > 0) updated++;
    }
    res.json({ success: true, updated });
});

// --- RANKING: BEST GUARDED DATA INGESTION SYNC LAYER ---
router.post('/sync/best-guarded', requireAuth, (req, res) => {
    const { last_update, entries } = req.body;
    if (!last_update || !Array.isArray(entries)) {
        return res.status(400).json({ error: 'Invalid rank tracking payload payload data structures' });
    }

    // Daily lock guard check against the exact server tick date signature
    const existingCheck = { count: systemsRepo.countBestGuardedAt(last_update) };
    if (existingCheck.count > 0) {
        return res.json({ success: true, skipped: true, message: 'Rankings already updated for today.' });
    }

    console.log(`[API] Processing fresh Best Guarded ranking sync batch updated at: ${last_update}`);

    const syncTx = db.transaction((rows) => {
        systemsRepo.clearBestGuarded(); // Clear stale indices safely

        for (const row of rows) {
            systemsRepo.insertBestGuarded(row.planet_id, row.cv, last_update);
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

// --- ALLIANCE STATS RECEIVER & SYNC ---
router.post('/sync/alliance-stats', requireAuth, (req, res) => {
    const s = req.body;
    if (!s || !s.player_id) return res.status(400).json({ error: 'Missing Player ID' });

    let nextCultureAt = null;
    if (s.next_culture_seconds !== null && !isNaN(s.next_culture_seconds)) {
        nextCultureAt = new Date(Date.now() + s.next_culture_seconds * 1000).toISOString();
    }

    const fleets = Array.isArray(s.fleets) ? s.fleets : null;

    try {
        const tx = db.transaction(() => {
            alliancesRepo.upsertAllianceMemberStats(
                s.player_id, s.planets_text, nextCultureAt, s.science_rate, s.culture_rate, s.production_rate,
                s.astro_dollars, s.production_points, s.artefact, s.level_text, s.cv_limit_text,
                s.economy, s.energy, s.mathematics, s.physics, s.population
            );

            playersRepo.recordNameChangeIfDifferent(s.player_id, typeof s.name === 'string' ? s.name : null);
            playersRepo.upsertPlayerNameOnly(s.player_id, s.name);

            // Replace this member's stationed fleets so positions stay fresh and stale
            // ones are dropped. Only touch fleets when the scrape actually carried a
            // fleet array (avoids wiping data on a stats-only payload).
            if (fleets) {
                fleetsRepo.deleteFleetsByOwner(s.player_id);
                for (const f of fleets) {
                    if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                    fleetsRepo.insertFleetForAllianceStats(
                        s.player_id, f.system_id, f.planet_index,
                        f.transports || 0, f.colony_ships || 0, f.destroyers || 0, f.cruisers || 0, f.battleships || 0,
                        f.arrival_at || null
                    );
                }
            }
        });
        tx();

        res.json({ success: true });
    } catch (err) {
        console.error("[DB Error] Alliance member stats sync failed:", err);
        res.status(500).json({ error: 'Database transaction failed' });
    }
});

// --- ALLIANCE ROSTER RECONCILE ---
// Body: { member_ids: [..] } — the full set of player_ids currently in the alliance.
// Stats rows for anyone NOT in this set (i.e. resigned/left) are removed so they
// stop appearing in alliance stats and on the trade-agreements board.
router.post('/sync/alliance-roster', requireAuth, (req, res) => {
    const ids = Array.isArray(req.body.member_ids)
        ? req.body.member_ids.map(Number).filter(Number.isInteger)
        : [];
    // Guard against wiping everything if the roster scrape came back empty.
    if (ids.length === 0) return res.json({ success: true, removed: 0 });

    try {
        const info = alliancesRepo.deleteStaleAllianceMembers(ids);
        if (info.changes > 0) console.log(`[API] Alliance roster reconcile: removed ${info.changes} stale member(s).`);
        res.json({ success: true, removed: info.changes });
    } catch (err) {
        console.error("[DB Error] Alliance roster reconcile failed:", err);
        res.status(500).json({ error: 'Database transaction failed' });
    }
});

// --- BATTLE REPORT RECEIVER (game REST API) ---
// Body: { reports: [<raw /api/v1 battle-report objects>] }. Mapping/validation lives in
// src/utils/battle-reports.js: a malformed report is skipped, never aborts the batch,
// and INSERT OR IGNORE makes re-syncs idempotent (the game report id is the PK).
//
// Discord announcements are fired AFTER the commit, fire-and-forget, only for reports
// the hub had never seen (freshly inserted, announced=0), capped at 5 embeds per sync
// with the overflow summarized in one line. Names are player-controlled strings on
// their way to Discord, so they pass through defuseMentions first.
router.post('/sync/battle-reports', requireAuth, (req, res) => {
    const list = Array.isArray(req.body.reports) ? req.body.reports : null;
    if (!list) return res.status(400).json({ error: 'Invalid payload' });

    const rows = [];
    for (const r of list) {
        const row = mapApiReport(r);
        if (row) rows.push(row);
    }

    try {
        const { inserted, skipped } = upsertReports(db, rows);

        // Announce the ones the alliance has not seen yet. The pass is driven from the
        // table (WHERE announced = 0), not just this batch's freshly inserted rows, so a
        // report that was synced BEFORE the Discord channel was configured still gets
        // announced once the channel exists (INSERT OR IGNORE would otherwise send it to
        // `skipped` on a re-sync and it could never announce). announced=1 is flipped only
        // when a channel is actually configured — otherwise the rows stay a retry queue.
        if (settingValue('discord_battlereport_channel')) {
            const pending = battleReportsRepo.getPendingAnnouncements();
            if (pending.length > 0) {
                const toEmbed = pending.slice(0, 5);
                for (const row of toEmbed) {
                    const embed = formatBattleEmbed({
                        ...row,
                        att_player_name: row.att_player_name == null ? null : defuseMentions(row.att_player_name),
                        def_player_name: row.def_player_name == null ? null : defuseMentions(row.def_player_name),
                        att_alliance_tag: row.att_alliance_tag == null ? null : defuseMentions(row.att_alliance_tag),
                        def_alliance_tag: row.def_alliance_tag == null ? null : defuseMentions(row.def_alliance_tag),
                        winner: row.winner == null ? null : defuseMentions(row.winner),
                    });
                    postEmbed('discord_battlereport_channel', embed).catch(err =>
                        console.error('[Discord] battle-report announce error:', err.message));
                }
                if (pending.length > toEmbed.length) {
                    postEmbed('discord_battlereport_channel', {
                        title: 'More battle reports',
                        description: `…and ${pending.length - toEmbed.length} more new battle reports synced.`,
                        color: 0x99aab5,
                    }).catch(err => console.error('[Discord] battle-report announce error:', err.message));
                }
                // Fire-and-forget above: the flag is flipped for every pending row now, so a
                // Discord hiccup drops that one embed rather than replaying the whole backlog
                // on the next sync (matches how reminders/timers mark themselves sent).
                const flip = db.transaction((ids) => { for (const id of ids) battleReportsRepo.markAnnounced(id); });
                flip(pending.map(r => r.id));
            }
        }

        // --- BATTLE POINTS: automated twice-daily leaderboard post ---
        // This app has no server-side scheduler anywhere (every periodic-feeling behavior
        // here is actually driven by client sync traffic) — so this piggybacks on real
        // battle-report sync activity instead of adding a new timer. Any sync that
        // actually inserts new rows is treated as "fresh data just arrived"; if at least
        // 12 hours have passed since the last automated post, it fires again. In practice
        // this lands once after the first sync following local midnight (when yesterday's
        // reports become visible) and again roughly 12 hours later.
        if (inserted.length > 0 && settingValue('discord_battlepoints_channel')) {
            const lastPostRaw = settingValue('battle_points_last_auto_post_at');
            const lastPostMs = lastPostRaw ? Date.parse(lastPostRaw) : NaN;
            const hoursSince = Number.isFinite(lastPostMs) ? (Date.now() - lastPostMs) / (60 * 60 * 1000) : Infinity;
            if (hoursSince >= 12) {
                const { cv, pop } = battlePointsRepo.getLeaderboards(null, 10);
                const formatLines = (rows, unit) => rows.length
                    ? rows.map((r, i) => `**${i + 1}.** ${r.player_name || 'Unknown'} — ${r.points} pts (${r.raw.toLocaleString()} ${unit})`).join('\n')
                    : '_No battles recorded yet._';
                postBattleEmbed('discord_battlepoints_channel', {
                    title: '⚔️ Battle Challenge Update',
                    fields: [
                        { name: '💥 CV Killed', value: formatLines(cv, 'CV') },
                        { name: '☠️ Population Killed', value: formatLines(pop, 'pop') },
                    ],
                    color: 0xe11d48,
                }).catch(err => console.error('[Discord] battle-points auto-post error:', err.message));
                settingsRepo.setSetting('battle_points_last_auto_post_at', new Date().toISOString());
            }
        }

        // newest_started_at is the dashboard scheduler's contract: the next pull uses it
        // as BattleDateFrom so the search window only ever moves forward.
        const newest = battleReportsRepo.getNewestStartedAt();

        res.json({ success: true, inserted: inserted.length, skipped, newest_started_at: newest });
    } catch (err) {
        console.error('[DB Error] Battle report sync failed:', err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- BATTLE REPORT SHIP-DETAIL CLAIM ---
// Same optimistic-claim pattern as /sync/player-scan-claim (Plan 3): "claiming" is just
// bumping ship_detail_scraped_at now. A battle report's ship detail never changes once
// scraped (it's an immutable historical record), so unlike the player sweep this needs no
// staleness re-check — a report is either scraped or it isn't.
router.post('/sync/battle-report-ship-detail-claim', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 10, 50);
    const ids = battleReportsRepo.getReportsNeedingShipDetail(limit);
    if (ids.length) battleReportsRepo.markShipDetailScraped(ids);
    res.json({ success: true, ids });
});

// --- BATTLE REPORT LOCATION BACKFILL CLAIM ---
// One-time legacy pass for reports already marked ship_detail_scraped_at but with no
// system_id (scraped before planet capture shipped, or by a stale browser tab still
// running old JS — see getReportsNeedingLocationBackfill). The RECEIVER is the same
// /sync/battle-report-ship-detail route below — re-sending the ship-count/win_chance
// fields for an already-scraped report is a harmless idempotent overwrite with identical
// values; only system_id/planet_index are actually new for these rows.
router.post('/sync/battle-report-location-backfill-claim', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 10, 50);
    const ids = battleReportsRepo.getReportsNeedingLocationBackfill(limit);
    if (ids.length) battleReportsRepo.markLocationBackfillAttempted(ids);
    res.json({ success: true, ids });
});

// The 24 per-ship-type integer columns updateShipDetail writes (6 ship types x
// att/def x count/lost) — kept in one place so the coercion loop below and the schema
// can't silently drift apart.
const SHIP_DETAIL_INT_FIELDS = [
    'att_destroyers', 'att_destroyers_lost', 'def_destroyers', 'def_destroyers_lost',
    'att_cruisers', 'att_cruisers_lost', 'def_cruisers', 'def_cruisers_lost',
    'att_battleships', 'att_battleships_lost', 'def_battleships', 'def_battleships_lost',
    'att_transports', 'att_transports_lost', 'def_transports', 'def_transports_lost',
    'att_colony_ships', 'att_colony_ships_lost', 'def_colony_ships', 'def_colony_ships_lost',
    'att_starbases', 'att_starbases_lost', 'def_starbases', 'def_starbases_lost',
];

// --- BATTLE REPORT SHIP-DETAIL RECEIVER ---
router.post('/sync/battle-report-ship-detail', requireAuth, (req, res) => {
    const { id, ...detail } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    // Coerce every field before it reaches SQL — a string value could otherwise bind
    // straight into an INTEGER column. Matches the coercion discipline already used by
    // /sync/player-list and /sync/player-detail above.
    const normalized = {};
    for (const field of SHIP_DETAIL_INT_FIELDS) {
        normalized[field] = Number.isInteger(detail[field]) ? detail[field] : null;
    }
    normalized.win_chance = typeof detail.win_chance === 'number' && Number.isFinite(detail.win_chance)
        ? detail.win_chance
        : null;
    normalized.system_id = Number.isInteger(detail.system_id) ? detail.system_id : null;
    normalized.planet_index = Number.isInteger(detail.planet_index) ? detail.planet_index : null;
    try {
        battleReportsRepo.updateShipDetail(id, normalized);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync battle report ship detail ${id}:`, err.message);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

// --- STARBASE ORDER AUDIT RECEIVER ---
// One row per starbase-order geometry PUT the member's browser confirmed against the
// game API (the hub never sends that PUT itself). The actor comes from the session, not
// the payload — the payload only says what was sent, never who sent it.
router.post('/sync/starbase-audit', requireAuth, (req, res) => {
    const b = req.body;
    const orderId = Number(b.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order_id' });
    }

    const intOrNull = v => (Number.isInteger(v) ? v : null);
    const realOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    try {
        db.prepare(`
            INSERT INTO starbase_order_audit
                (order_id, system_id, planet_index, range, angle1, angle2, actor_user_id, actor_game_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            orderId,
            intOrNull(b.system_id), intOrNull(b.planet_index),
            realOrNull(b.range), realOrNull(b.angle1), realOrNull(b.angle2),
            req.session.userId, req.session.gameName || null
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Starbase order audit failed:', err);
        res.status(500).json({ error: 'Audit write failed' });
    }
});

// --- TRADE MARKET PRICE RECEIVER (Production Point / Supply Unit) ---
router.post('/sync/trade-prices', requireAuth, (req, res) => {
    const { pp_price, su_price } = req.body;

    try {
        if (pp_price != null && !isNaN(pp_price)) settingsRepo.setSetting('pp_price', String(pp_price));
        if (su_price != null && !isNaN(su_price)) settingsRepo.setSetting('su_price', String(su_price));
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to store trade prices:', err);
        res.status(500).json({ error: 'Failed to store trade prices' });
    }
});

// --- NEWS-PAGE WATERMARK (for the client's pagination-walk stop condition) ---
router.get('/sync/news-watermark', requireAuth, (req, res) => {
    const row = playersRepo.getPlayerIdByName(req.session.gameName || '');
    const playerId = row ? row.id : null;
    if (!playerId) return res.json({ watermark: null });
    res.json({ watermark: newsEventsRepo.getWatermark(playerId) });
});

// --- NEWS-PAGE EVENT RECEIVER ---
// Body: { entries: [{ message_type, occurred_at, game_planet_id, system_id,
// other_player_id, population_delta, direction }] }. Parsing lives entirely on the
// client (public/js/ui/news-battle-events.js reading the member's own /Game/News page);
// this route only resolves crediting/matching and stores the result. `direction`
// ('killed'|'lost') only matters for battle-bombarded rows.
router.post('/sync/news', requireAuth, (req, res) => {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: 'Invalid payload' });

    const row = playersRepo.getPlayerIdByName(req.session.gameName || '');
    const playerId = row ? row.id : null;
    if (!playerId) return res.status(400).json({ error: 'Session player not recognized' });

    let inserted = 0;
    let maxOccurredAt = null;

    try {
        for (const raw of entries) {
            if (!raw || !raw.message_type || !raw.occurred_at) continue;

            // A garbage/unparseable timestamp must never reach matching (new Date(NaN...)
            // throws RangeError) or the watermark (a string that string-compares as
            // "greater than" every real ISO-8601 value would push the watermark past all
            // real events, permanently halting this player's News pagination). Validate
            // BEFORE this entry touches anything else, so one bad entry never sinks the
            // good entries around it.
            if (isNaN(Date.parse(raw.occurred_at))) {
                console.warn(`[News Sync] player ${playerId}: skipping entry with unparseable occurred_at`, raw.occurred_at);
                continue;
            }

            if (maxOccurredAt === null || raw.occurred_at > maxOccurredAt) maxOccurredAt = raw.occurred_at;

            // A News row can name a player the hub has never scanned (no players row
            // exists for them yet) — other_player_id has a FOREIGN KEY to players(id), so
            // using it verbatim would throw on INSERT. Never fabricate a players row for
            // them; just drop the reference. For battle-bombarded rows this also nulls out
            // credited_player_id (via resolveBombardmentCredit's own "no other_player_id"
            // guard below) — population credit needs a valid, existing player to attribute
            // to.
            let otherPlayerId = raw.other_player_id || null;
            if (otherPlayerId && !playersRepo.playerExistsById(otherPlayerId)) {
                console.warn(`[News Sync] player ${playerId}: other_player_id ${otherPlayerId} has no players row, dropping reference`);
                otherPlayerId = null;
            }

            let credited_player_id = null;
            let matched_battle_report_id = null;

            if (raw.message_type === 'battle-bombarded') {
                // Don't gate this call on otherPlayerId: direction "killed" credits the
                // scraping player regardless of whether the opponent is known (see
                // resolveBombardmentCredit). Only the cross-reference lookup below needs
                // a known otherPlayerId.
                const credit = resolveBombardmentCredit({ ...raw, other_player_id: otherPlayerId }, playerId);
                if (credit) {
                    credited_player_id = credit.credited_player_id;
                    if (credit.otherPlayerId) {
                        matched_battle_report_id = battleReportsRepo.findByPlayerPairNear(
                            credit.credited_player_id, credit.otherPlayerId, raw.occurred_at, 15
                        );
                    }
                }
            }

            // Insert each entry independently — a constraint violation on one bad entry
            // (however it slipped past the guards above) must not abort the rest of the
            // batch. insertNewsEvent's own INSERT OR IGNORE dedup semantics are unchanged;
            // this only adds a safety net around it.
            try {
                const wasInserted = newsEventsRepo.insertNewsEvent({
                    player_id: playerId,
                    message_type: raw.message_type,
                    occurred_at: raw.occurred_at,
                    game_planet_id: raw.game_planet_id || null,
                    system_id: raw.system_id || null,
                    other_player_id: otherPlayerId,
                    population_delta: raw.population_delta || null,
                    credited_player_id,
                    matched_battle_report_id,
                });
                if (wasInserted) inserted++;
            } catch (entryErr) {
                console.warn(`[News Sync] player ${playerId}: skipping entry that failed to insert:`, entryErr.message);
            }
        }

        if (maxOccurredAt) newsEventsRepo.advanceWatermark(playerId, maxOccurredAt);

        res.json({ success: true, inserted });
    } catch (err) {
        console.error(`[DB Error] News sync failed for player ${playerId}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});

module.exports = router;
