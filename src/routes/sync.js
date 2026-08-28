const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { announceSystemChanges } = require('../discord_bot');
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const playersRepo = require('../repositories/players');
const { mapApiReport, upsertReports, formatBattleEmbed } = require('../utils/battle-reports');
const { postEmbed, defuseMentions, settingValue } = require('../utils/discord-post');
const router = express.Router();

// --- MAP SCRAPER DATA RECEIVER ---
router.post('/sync/system', requireAuth, (req, res) => {
    const { system_id, planets, fleets, scan_mode } = req.body; // <-- Added fleets, scan_mode

    if (!system_id || !Array.isArray(planets)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    systemsRepo.upsertSystemStub(system_id);

    const upsertAlliance = db.prepare(`
        INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, updated_at=CURRENT_TIMESTAMP
    `);

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

            // CRITICAL FOG OF WAR GUARD: If scan reports "Unknown", protect historical stats from being nuked
            if (p.is_unknown && oldP) {
                finalOwnerId = oldP.owner_id;
                finalPopulation = oldP.population;
                finalStarbase = oldP.starbase;
                finalHasFleet = oldP.has_fleet;
                finalIsSieged = oldP.is_sieged;
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
                    if (oldP.owner_id != null) {
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
                        announceEvents.push({
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
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                playersRepo.upsertPlayerBasic(p.owner.id, p.owner.name, p.owner.alliance_id || null);
            }

            // Pass the calculated final parameters securely down to the table updater.
            // Re-home the planet if its id currently lives at another slot (avoids the
            // game_planet_id UNIQUE collision that would otherwise roll back the system).
            if (p.game_planet_id != null) {
                systemsRepo.clearMovedPlanet(p.game_planet_id, system_id, p.planet_index);
            }
            systemsRepo.upsertPlanet(p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation, finalStarbase, finalHasFleet, finalIsSieged);
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
            db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag`)
                .run(player.alliance_id, player.alliance_tag ?? null, player.alliance_tag ?? '');
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
        if (Array.isArray(a.members)) {
            for (const member of a.members) {
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
            systemsRepo.upsertSystemFull(s.id, typeof s.name === 'string' ? s.name : null, x, y);
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
        const placeholders = ids.map(() => '?').join(',');
        const info = db.prepare(
            `DELETE FROM alliance_member_stats WHERE player_id NOT IN (${placeholders})`
        ).run(...ids);
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
            const pending = db.prepare(
                `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`).all();
            if (pending.length > 0) {
                const markAnnounced = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
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
                const flip = db.transaction((ids) => { for (const id of ids) markAnnounced.run(id); });
                flip(pending.map(r => r.id));
            }
        }

        // newest_started_at is the dashboard scheduler's contract: the next pull uses it
        // as BattleDateFrom so the search window only ever moves forward.
        const newest = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`).get().newest || null;

        res.json({ success: true, inserted: inserted.length, skipped, newest_started_at: newest });
    } catch (err) {
        console.error('[DB Error] Battle report sync failed:', err);
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

    const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);

    try {
        if (pp_price != null && !isNaN(pp_price)) upsert.run('pp_price', String(pp_price));
        if (su_price != null && !isNaN(su_price)) upsert.run('su_price', String(su_price));
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to store trade prices:', err);
        res.status(500).json({ error: 'Failed to store trade prices' });
    }
});

module.exports = router;
