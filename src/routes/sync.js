const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { announceSystemChanges } = require('../discord_bot');
const router = express.Router();

// --- MAP SCRAPER DATA RECEIVER ---
router.post('/sync/system', requireAuth, (req, res) => {
    const { system_id, planets, fleets, scan_mode } = req.body; // <-- Added fleets, scan_mode

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

    // A planet's game_planet_id is globally UNIQUE, but it can show up at a new
    // (system_id, planet_index) slot when a planet is re-slotted/relocated. The upsert
    // above only resolves the (system_id, planet_index) conflict, so without this the
    // INSERT path would trip the game_planet_id UNIQUE constraint and abort the whole
    // system's transaction (losing all of that system's updates). Clear the stale row
    // at the old location first.
    const clearMovedPlanet = db.prepare(`
        DELETE FROM planets WHERE game_planet_id = ? AND (system_id != ? OR planet_index != ?)
    `);

    // Prepared statement for the new fleets
    const insertFleet = db.prepare(`
        INSERT INTO fleets (game_fleet_id, owner_id, system_id, planet_index, transports, colony_ships, destroyers, cruisers, battleships, arrival_time, arrival_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // --- NEW: History Logging Prep ---
    const getOldPlanet = db.prepare(`SELECT owner_id, population FROM planets WHERE system_id = ? AND planet_index = ?`);
    const getPlayerName = db.prepare(`
        SELECT p.name, a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id = ?
    `);
    const logEvent = db.prepare(`
        INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value)
        VALUES (?, ?, ?, ?, ?)
    `);

    // Collect human-readable events for the Discord announcer (only used during a galaxy scan)
    const announceEvents = [];
    const nameOf = (id) => {
        if (!id) return null;
        const row = getPlayerName.get(id);
        if (!row) return `#${id}`;
        return row.alliance_tag ? `[${row.alliance_tag}] ${row.name}` : row.name;
    };

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
                    announceEvents.push({
                        planet_index: p.planet_index,
                        type: 'OWNER_CHANGE',
                        old_owner: nameOf(oldP.owner_id),
                        new_owner: p.owner
                            ? (p.owner.alliance_tag ? `[${p.owner.alliance_tag}] ${p.owner.name}` : p.owner.name)
                            : nameOf(finalOwnerId)
                    });
                }
                // Significant Population Drop: Skip history generation entirely if it's an unverified/unknown scan
                if (!p.is_unknown && oldP.population > 0 && finalPopulation < oldP.population - 5) {
                    logEvent.run(system_id, p.planet_index, 2, oldP.population, finalPopulation); // 2 = POP_DROP
                    announceEvents.push({
                        planet_index: p.planet_index,
                        type: 'POP_DROP',
                        old_pop: oldP.population,
                        new_pop: finalPopulation
                    });
                }
            }

            // Standard Upsert (Skip structural updates for players/alliances if we can't see them clearly)
            if (p.owner && !p.is_unknown) {
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag, p.owner.alliance_tag);
                upsertPlayer.run(p.owner.id, p.owner.name, p.owner.alliance_id || null);
            }

            // Pass the calculated final parameters securely down to the table updater.
            // Re-home the planet if its id currently lives at another slot (avoids the
            // game_planet_id UNIQUE collision that would otherwise roll back the system).
            if (p.game_planet_id != null) {
                clearMovedPlanet.run(p.game_planet_id, system_id, p.planet_index);
            }
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
                insertFleet.run(f.game_fleet_id, f.owner_id, system_id, f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships, f.arrival_time || null, f.arrival_at || null);
            }
        }
    });

    try {
        syncTransaction(planets, fleets || []);

        // Announce detected planet events to Discord — both during a full galaxy scan
        // and during normal map browsing.
        if (announceEvents.length > 0) {
            const sys = db.prepare(`SELECT id, name, x, y FROM systems WHERE id = ?`).get(system_id) || { id: system_id };
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

    const oldPlayer = db.prepare('SELECT logins, points, origin_system FROM players WHERE id = ?').get(p.id);

    const syncTransaction = db.transaction((player) => {
        const loginsDropped = oldPlayer && player.logins > 0 && player.logins < oldPlayer.logins;
        const originChanged = oldPlayer && oldPlayer.origin_system !== null && player.origin_system !== oldPlayer.origin_system;
        const pointsNuked = oldPlayer && oldPlayer.points > 2000 && player.points < 100;

        if (loginsDropped || originChanged || pointsNuked) {
            console.log(`[SYSTEM] Verified Player ${player.id} restarted or moved origin! Purging ghost assets.`);

            db.prepare(`UPDATE planets SET owner_id = NULL, population = 0, starbase = 0, has_fleet = 0, is_sieged = 0 WHERE owner_id = ?`).run(player.id);
            db.prepare(`DELETE FROM fleets WHERE owner_id = ?`).run(player.id);
            db.prepare(`
                UPDATE players SET
                    level=0, points=0, ranking=NULL, science_level=0, culture_level=0,
                    biology=0, economy=0, energy=0, mathematics=0, physics=0, social=0,
                    trade_revenue=0, artefact=NULL, eco_bonus=0,
                    race_growth=0, race_science=0, race_culture=0, race_production=0, race_speed=0, race_attack=0, race_defense=0,
                    race_trader=0, race_sul=0, origin_system=NULL, has_intel=0, intel_updated_at=NULL,
                    home_planet_id=NULL, home_system_id=NULL, home_planet_index=NULL, possible_homes='[]',
                    total_planets=0, total_population=0, total_farms=0, total_factories=0, total_labs=0, total_cybernetics=0, cv_used=0, cv_limit=0
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
                race_trader, race_sul, joined, logins, has_intel, intel_updated_at,
                home_planet_id, home_system_id, home_planet_index, possible_homes,
                total_planets, total_population, total_farms, total_factories, total_labs, total_cybernetics, cv_used, cv_limit
            ) VALUES (
                @id, @name, @alliance_id, @country, @local_time, @idle_time, @origin_system,
                @level, @ranking, @points, @science_level, @culture_level,
                @biology, @economy, @energy, @mathematics, @physics, @social,
                @trade_revenue, @artefact, @eco_bonus,
                @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack, @race_defense,
                @race_trader, @race_sul, @joined, @logins, @has_intel,
                CASE WHEN @has_intel = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
                @home_planet_id, @home_system_id, @home_planet_index, @possible_homes,
                @total_planets, @total_population, @total_farms, @total_factories, @total_labs, @total_cybernetics, @cv_used, @cv_limit
            ) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, alliance_id=excluded.alliance_id, country=excluded.country,
                local_time=excluded.local_time, idle_time=excluded.idle_time, origin_system=excluded.origin_system,
                level=excluded.level, ranking=excluded.ranking, points=excluded.points,
                science_level=excluded.science_level, culture_level=excluded.culture_level,
                joined=excluded.joined, logins=excluded.logins,
                home_planet_id=excluded.home_planet_id, home_system_id=excluded.home_system_id, home_planet_index=excluded.home_planet_index,
                possible_homes=excluded.possible_homes, total_planets=excluded.total_planets, total_population=excluded.total_population,
                total_farms=excluded.total_farms, total_factories=excluded.total_factories, total_labs=excluded.total_labs,
                total_cybernetics=excluded.total_cybernetics, cv_used=excluded.cv_used, cv_limit=excluded.cv_limit,
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

// --- ALLIANCE STATS RECEIVER & SYNC ---
router.post('/sync/alliance-stats', requireAuth, (req, res) => {
    const s = req.body;
    if (!s || !s.player_id) return res.status(400).json({ error: 'Missing Player ID' });

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
