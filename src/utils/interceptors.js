// Shared defender / interceptor analysis used by both the external incoming webhook
// and the News-page "announce" button. Given an attack (target system + planet +
// optional arrival time) it returns the allied fleets/builds that could reach the
// target, split into on-time and late.
const db = require('../database');
const { calcTravelSeconds, formatTime } = require('./travel-calc');

const ONTIME_LIMIT = 10;
const LATE_LIMIT = 3;

function cleanInt(str) {
    if (str == null) return 0;
    return parseInt(String(str).replace(/[,.\s]/g, ''), 10) || 0;
}

const cvOf = (f) => (f.destroyers || 0) * 3 + (f.cruisers || 0) * 24 + (f.battleships || 0) * 60;

// Cost per CV in production points at a given economy level: destroyer = 3 CV for
// round(30 * 0.99^eco) PP  ->  cost_per_CV = 10 * 0.99^eco.
const costPerCv = (economy) => 10 * Math.pow(0.99, economy || 0);

function getPpPrice() {
    try {
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`).get();
        const v = row ? parseFloat(row.value) : NaN;
        return (!isNaN(v) && v > 0) ? v : 0.91; // sensible default until /Game/Trade is scraped
    } catch (err) {
        return 0.91;
    }
}

// attack: { systemId, planetIndex, defenderName, arrivalUnix }
function computeInterceptors(attack, nowUnix) {
    const target = db.prepare(`SELECT x, y FROM systems WHERE id = ?`).get(attack.systemId);
    if (!target || target.x == null || target.y == null) return null;

    const defender = attack.defenderName
        ? db.prepare(`SELECT alliance_id FROM players WHERE name = ? COLLATE NOCASE`).get(attack.defenderName)
        : null;
    const allianceId = defender && defender.alliance_id ? defender.alliance_id : null;

    const whereClause = allianceId
        ? `p.alliance_id = @aid`
        : `LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1)`;

    const fleets = db.prepare(`
        SELECT f.planet_index, f.destroyers, f.cruisers, f.battleships, f.arrival_at,
               p.name AS owner_name, p.energy, p.race_speed,
               s.x AS sx, s.y AS sy
        FROM fleets f
        JOIN players p ON f.owner_id = p.id
        JOIN systems s ON f.system_id = s.id
        WHERE ${whereClause} AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(allianceId ? { aid: allianceId } : {});

    const ppPrice = getPpPrice();

    const homes = db.prepare(`
        SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
               COALESCE(p.home_planet_index, 1) AS launch_planet,
               ams.production_points, ams.astro_dollars,
               s.x AS sx, s.y AS sy
        FROM players p
        JOIN alliance_member_stats ams ON ams.player_id = p.id
        JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
        WHERE ${whereClause} AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(allianceId ? { aid: allianceId } : {});

    const timeUntilImpact = attack.arrivalUnix > 0 ? attack.arrivalUnix - nowUnix : null;

    const byPlayer = new Map();
    const consider = (name, cv, eta, source, note) => {
        if (cv <= 0 || eta == null || isNaN(eta)) return;
        const key = name.toLowerCase();
        const existing = byPlayer.get(key);
        if (!existing || eta < existing.eta) {
            byPlayer.set(key, { name, cv, eta, source, note: note || '' });
        }
    };

    for (const f of fleets) {
        const cv = cvOf(f);
        const travel = calcTravelSeconds(f.sx, f.sy, f.planet_index, target.x, target.y, attack.planetIndex, f.energy, f.race_speed, true);
        const landUnix = f.arrival_at ? Math.floor(Date.parse(f.arrival_at) / 1000) : 0;
        const landDelay = (landUnix && landUnix > nowUnix) ? (landUnix - nowUnix) : 0;
        if (landDelay > 0) {
            consider(f.owner_name, cv, landDelay + travel, 'flight', `lands in ${formatTime(landDelay)}`);
        } else {
            consider(f.owner_name, cv, travel, 'orbit', '');
        }
    }

    for (const h of homes) {
        const pp = cleanInt(h.production_points);
        const ad = cleanInt(h.astro_dollars);
        const totalPp = pp + (ppPrice > 0 ? ad / ppPrice : 0);
        const cv = Math.floor(totalPp / costPerCv(h.economy));
        if (cv <= 0) continue;
        const travel = calcTravelSeconds(h.sx, h.sy, h.launch_planet, target.x, target.y, attack.planetIndex, h.energy, h.race_speed, true);
        consider(h.owner_name, cv, travel, 'build', 'build & launch');
    }

    // Attach a real Discord mention where we know the player's numeric id (matched
    // game_name -> app_users.discord_id). Renders as their Discord name AND pings them.
    const mentionFor = db.prepare(`
        SELECT discord_id FROM app_users WHERE LOWER(game_name) = ? AND discord_id IS NOT NULL
    `);
    for (const a of byPlayer.values()) {
        try {
            const row = mentionFor.get(a.name.toLowerCase());
            a.mention = row && row.discord_id ? `<@${row.discord_id}>` : null;
        } catch (e) { a.mention = null; }
    }

    const all = Array.from(byPlayer.values());
    if (timeUntilImpact == null) {
        all.sort((a, b) => a.eta - b.eta);
        return { unknownTiming: true, onTime: all.slice(0, ONTIME_LIMIT), late: [] };
    }

    all.forEach(a => { a.delta = timeUntilImpact - a.eta; });
    const onTime = all.filter(a => a.delta >= 0).sort((a, b) => a.eta - b.eta);
    const late = all.filter(a => a.delta < 0).sort((a, b) => b.delta - a.delta);

    return { unknownTiming: false, timeUntilImpact, onTime, late };
}

const SOURCE_TAG = { orbit: '🛰️', flight: '✈️', build: '🏗️' };

module.exports = {
    ONTIME_LIMIT, LATE_LIMIT, SOURCE_TAG,
    cleanInt, cvOf, costPerCv, getPpPrice, computeInterceptors
};
