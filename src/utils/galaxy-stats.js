// Galaxy dashboard numbers (GET /hub-api/intel/galaxy-stats): one read-only pass over what
// the hub already has on disk, so opening the dashboard costs zero game requests.
//
// Two sourcing choices that are easy to get backwards:
//
// - Planet ownership is counted from the `planets` table, not players.total_planets. The
//   planets table is rewritten by every system scan and is the same source the
//   OWNER_CHANGE history below is diffed from, so "planets held" and "gained/lost" agree.
//   players.total_planets comes from a per-player API scan that can lag by a day, and on
//   2026-09-23 the two disagreed by ~120 planets galaxy-wide.
// - Strongest fleet is read from the LATEST snapshot only. strongest_fleet is player-keyed
//   and keeps a player's last row after they drop out of the top 50, so ranking across all
//   rows would put a fleet that has since been shot down above today's real #1.
//
// Gains and losses are attributed to each player's CURRENT alliance, since planet_events
// stores owner ids, not tags. A player who switched alliance mid-week moves their history
// with them. Battles, by contrast, carry the tag as it was at the time.

const HOUR = 3600 * 1000;
const NO_ALLIANCE = 'none';

const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// last_activity_at is the game's own ISO string with a zone offset and 7-digit fractions.
function parseActivity(value) {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function computeGalaxyStats(db, { now = Date.now(), days = 14 } = {}) {
    const since24h = sqlTime(now - 24 * HOUR);
    const since7d = sqlTime(now - 7 * 24 * HOUR);
    const sinceChart = now - days * 24 * HOUR;

    const players = db.prepare(`
        SELECT p.id, p.name, p.alliance_id, p.level, p.total_xp, p.last_activity_at, p.resigned_at,
               a.tag
        FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
    `).all();
    const playerById = new Map(players.map(p => [p.id, p]));
    const allianceKeyOf = id => {
        const p = playerById.get(id);
        return p && p.alliance_id != null ? String(p.alliance_id) : NO_ALLIANCE;
    };

    // --- per-alliance rows, keyed by alliance id (or 'none') ---
    const alliances = new Map();
    const row = key => {
        if (!alliances.has(key)) {
            alliances.set(key, {
                key, id: key === NO_ALLIANCE ? null : Number(key), tag: null, name: null, ranking: null, points: null,
                members: 0, active24h: 0, levelSum: 0, planets: 0, population: 0,
                gained24h: 0, lost24h: 0, gained7d: 0, lost7d: 0,
                battles7d: 0, won7d: 0, lost7dBattles: 0, conquests7d: 0,
            });
        }
        return alliances.get(key);
    };
    for (const a of db.prepare(`SELECT id, tag, name, ranking, points_current FROM alliances`).all()) {
        Object.assign(row(String(a.id)), { tag: a.tag, name: a.name, ranking: a.ranking, points: a.points_current });
    }
    const keyByTag = new Map([...alliances.values()].filter(a => a.tag).map(a => [a.tag.toUpperCase(), a.key]));

    let active1h = 0, active24h = 0, livePlayers = 0;
    for (const p of players) {
        if (p.resigned_at) continue;
        livePlayers++;
        const r = row(allianceKeyOf(p.id));
        r.members++;
        r.levelSum += p.level || 0;
        const seen = parseActivity(p.last_activity_at);
        if (seen !== null && now - seen <= HOUR) active1h++;
        if (seen !== null && now - seen <= 24 * HOUR) { active24h++; r.active24h++; }
    }

    // --- planets ---
    const planetTotals = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(owner_id IS NOT NULL) AS owned,
               SUM(COALESCE(is_sieged, 0) != 0) AS sieged,
               COUNT(DISTINCT CASE WHEN owner_id IS NOT NULL THEN system_id END) AS occupiedSystems,
               MIN(updated_at) AS oldestScan
        FROM planets
    `).get();
    const systemsTotal = db.prepare(`SELECT COUNT(*) AS n FROM systems`).get().n;

    const byOwner = db.prepare(`
        SELECT owner_id, COUNT(*) AS planets, SUM(COALESCE(population, 0)) AS population
        FROM planets WHERE owner_id IS NOT NULL GROUP BY owner_id
    `).all();
    for (const o of byOwner) {
        const r = row(allianceKeyOf(o.owner_id));
        r.planets += o.planets;
        r.population += o.population;
    }

    // --- ownership changes ---
    const ownerChanges = db.prepare(`
        SELECT pe.old_value, pe.new_value, pe.timestamp
        FROM planet_events pe JOIN event_types et ON et.id = pe.event_type_id
        WHERE et.name = 'OWNER_CHANGE' AND pe.timestamp >= ?
    `).all(since7d);
    let ownerChanges24h = 0;
    for (const ev of ownerChanges) {
        const recent = ev.timestamp >= since24h;
        if (recent) ownerChanges24h++;
        const from = ev.old_value != null ? allianceKeyOf(Number(ev.old_value)) : null;
        const to = ev.new_value != null ? allianceKeyOf(Number(ev.new_value)) : null;
        if (from === to) continue; // moved inside one alliance: nobody's map changed
        if (to !== null) { const r = row(to); r.gained7d++; if (recent) r.gained24h++; }
        if (from !== null) { const r = row(from); r.lost7d++; if (recent) r.lost24h++; }
    }

    // --- battles ---
    const battles = db.prepare(`
        SELECT started_at, conquered_planet, att_alliance_tag, att_has_won, def_alliance_tag, def_has_won
        FROM battle_reports
        WHERE julianday(started_at) >= julianday(?)
    `).all(sqlTime(sinceChart));
    // Battle reports arrive through a separate sync that can lag the rest by hours; the
    // panel prints this so a stalled sync does not read as a quiet day.
    const latestBattleAt = db.prepare(`SELECT started_at FROM battle_reports ORDER BY julianday(started_at) DESC LIMIT 1`).get()?.started_at || null;
    const hourly = new Map();
    let battles24h = 0, conquests24h = 0;
    for (const b of battles) {
        const t = Date.parse(b.started_at);
        if (!Number.isFinite(t)) continue;
        const conquered = !!b.conquered_planet;
        const hour = Math.floor(t / HOUR) * HOUR;
        const bucket = hourly.get(hour) || { t: hour, battles: 0, conquests: 0 };
        bucket.battles++;
        if (conquered) bucket.conquests++;
        hourly.set(hour, bucket);
        if (now - t <= 24 * HOUR) { battles24h++; if (conquered) conquests24h++; }
        if (now - t > 7 * 24 * HOUR) continue;
        for (const [tag, won, attacker] of [[b.att_alliance_tag, b.att_has_won, true], [b.def_alliance_tag, b.def_has_won, false]]) {
            const key = tag ? keyByTag.get(String(tag).toUpperCase()) : null;
            if (!key) continue;
            const r = row(key);
            r.battles7d++;
            if (won) r.won7d++; else r.lost7dBattles++;
            if (attacker && won && conquered) r.conquests7d++;
        }
    }

    const ownedPlanets = planetTotals.owned || 0;
    const allianceRows = [...alliances.values()]
        .filter(a => a.members || a.planets || a.battles7d)
        .map(a => ({
            id: a.id, tag: a.key === NO_ALLIANCE ? null : a.tag, name: a.key === NO_ALLIANCE ? 'No alliance' : a.name,
            ranking: a.ranking, points: a.points,
            members: a.members, active24h: a.active24h,
            avgLevel: a.members ? Math.round((a.levelSum / a.members) * 10) / 10 : null,
            planets: a.planets, population: a.population,
            share: ownedPlanets ? Math.round((a.planets / ownedPlanets) * 1000) / 10 : 0,
            gained24h: a.gained24h, lost24h: a.lost24h, gained7d: a.gained7d, lost7d: a.lost7d,
            battles7d: a.battles7d, won7d: a.won7d, lostBattles7d: a.lost7dBattles, conquests7d: a.conquests7d,
        }))
        .sort((x, y) => (x.ranking ?? 1e9) - (y.ranking ?? 1e9) || y.planets - x.planets);

    // --- top players ---
    const latestFleet = db.prepare(`SELECT MAX(updated_at) AS at FROM strongest_fleet`).get().at;
    const topFleet = latestFleet ? db.prepare(`
        SELECT sf.player_id AS id, sf.rank, sf.cv, sf.destroyers, sf.cruisers, sf.battleships,
               p.name, a.tag
        FROM strongest_fleet sf
        LEFT JOIN players p ON p.id = sf.player_id
        LEFT JOIN alliances a ON a.id = p.alliance_id
        WHERE sf.updated_at = ?
        ORDER BY sf.rank, sf.cv DESC LIMIT 10
    `).all(latestFleet) : [];

    const topLevel = db.prepare(`
        SELECT p.id, p.name, a.tag, p.level, p.total_xp AS xp
        FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
        WHERE p.resigned_at IS NULL AND p.level IS NOT NULL
        ORDER BY p.level DESC, COALESCE(p.total_xp, 0) DESC LIMIT 10
    `).all();

    const topPopulation = db.prepare(`
        SELECT pl.owner_id AS id, p.name, a.tag, COUNT(*) AS planets, SUM(COALESCE(pl.population, 0)) AS population
        FROM planets pl
        LEFT JOIN players p ON p.id = pl.owner_id
        LEFT JOIN alliances a ON a.id = p.alliance_id
        WHERE pl.owner_id IS NOT NULL
        GROUP BY pl.owner_id
        ORDER BY population DESC, planets DESC LIMIT 10
    `).all();

    return {
        generatedAt: now,
        headline: {
            planets: planetTotals.total || 0,
            ownedPlanets,
            freePlanets: (planetTotals.total || 0) - ownedPlanets,
            siegedPlanets: planetTotals.sieged || 0,
            systems: systemsTotal,
            occupiedSystems: planetTotals.occupiedSystems || 0,
            players: livePlayers,
            active1h,
            active24h,
            alliances: allianceRows.filter(a => a.id !== null && a.members > 0).length,
            battles24h,
            conquests24h,
            ownerChanges24h,
            latestBattleAt: latestBattleAt ? Date.parse(latestBattleAt) : null,
            oldestPlanetScan: planetTotals.oldestScan || null,
        },
        alliances: allianceRows,
        battlesHourly: [...hourly.values()].sort((a, b) => a.t - b.t),
        chartDays: days,
        top: { fleet: topFleet, fleetAsOf: latestFleet || null, level: topLevel, population: topPopulation },
    };
}

module.exports = { computeGalaxyStats };
