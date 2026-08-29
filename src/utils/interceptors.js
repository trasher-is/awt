// Shared defender / interceptor analysis used by both the external incoming webhook
// and the News-page "announce" button. Given an attack (target system + planet +
// optional arrival time) it returns the allied fleets/builds that could reach the
// target, split into on-time and late.
const db = require('../database');
const { calcTravelSeconds, formatTime } = require('./travel-calc');
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const playersRepo = require('../repositories/players');
const usersRepo = require('../repositories/users');

const ONTIME_LIMIT = 10;
const LATE_LIMIT = 10;
const LATE_WINDOW = 15 * 60; // only show "late" defenders missing it by < 15 min

// cleanInt used to strip '.' and ',' unconditionally, so "1.5" read as 15 and
// "1,5" read as 15 — while trade.js parsed the same columns correctly. One parser now,
// shared with the browser. The export name stays so webhook.js keeps working.
const { parseLocaleInt } = require('../../public/js/utils/parse-number.js');
const cleanInt = parseLocaleInt;

// CV comes from the shared battle model — it used to be a fourth hand-written copy of
// D*3 + C*24 + B*60.
const { cvOf, SHIPS } = require('./battle');

// Cost per CV in production points at a given economy level. A destroyer is 3 CV and costs
// max(1, 30 - floor(eco * 0.3)) PP, so cost_per_CV is that over three.
//
// This was `10 * 0.99^eco` — an exponential curve that happens to agree near economy 0 and
// then diverges badly: it matched only 6 of the 30 rows of the game's own economy table
// (docs/game-rules.md), overcharging by 124% at economy 80 and 1000% at 97. Because this
// number decides how much a defender can build, it was hiding more than half their
// buildable CV in the incoming alerts. The linear form below matches all 30 rows exactly.
//
// The clamp matters: the table ends at economy 97 = 1 PP, and 98-100 stay there rather than
// reaching 0. Without it, economy 100 divides by zero.
const destroyerCost = (economy) => Math.max(1, 30 - Math.floor((economy || 0) * 0.3));
const costPerCv = (economy) => destroyerCost(economy) / 3;

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
    const target = systemsRepo.getSystemCoords(attack.systemId);
    if (!target || target.x == null || target.y == null) return null;

    const defender = attack.defenderName
        ? playersRepo.getPlayerAllianceIdByName(attack.defenderName)
        : null;
    const allianceId = defender && defender.alliance_id ? defender.alliance_id : null;

    const fleets = allianceId
        ? fleetsRepo.getInterceptFleetsByAlliance(allianceId)
        : fleetsRepo.getInterceptFleetsByActiveUsers();

    const ppPrice = getPpPrice();

    const homes = allianceId
        ? playersRepo.getInterceptHomesByAlliance(allianceId)
        : playersRepo.getInterceptHomesByActiveUsers();

    const timeUntilImpact = attack.arrivalUnix > 0 ? attack.arrivalUnix - nowUnix : null;

    const byPlayer = new Map();
    const consider = (name, cv, eta, source, note, origin) => {
        if (cv <= 0 || eta == null || isNaN(eta)) return;
        const key = name.toLowerCase();
        const existing = byPlayer.get(key);
        if (!existing || eta < existing.eta) {
            byPlayer.set(key, {
                name, cv, eta, source, note: note || '',
                // Origin of an existing fleet, for building Game/Fleets/Launch links.
                ownerId: origin ? origin.ownerId : null,
                originSys: origin ? origin.originSys : null,
                originIdx: origin ? origin.originIdx : null,
                fleetId: origin ? origin.fleetId : null,
                // Ship composition [D, C, B], for win-chance estimates.
                ships: origin ? origin.ships : [Math.floor(cv / 3), 0, 0]
            });
        }
    };

    for (const f of fleets) {
        const cv = cvOf(f);
        const travel = calcTravelSeconds(f.sx, f.sy, f.planet_index, target.x, target.y, attack.planetIndex, f.energy, f.race_speed, true);
        const landUnix = f.arrival_at ? Math.floor(Date.parse(f.arrival_at) / 1000) : 0;
        const landDelay = (landUnix && landUnix > nowUnix) ? (landUnix - nowUnix) : 0;
        const origin = {
            ownerId: f.owner_id, originSys: f.origin_sys, originIdx: f.planet_index, fleetId: f.game_fleet_id || null,
            ships: [f.destroyers || 0, f.cruisers || 0, f.battleships || 0]
        };
        if (landDelay > 0) {
            consider(f.owner_name, cv, landDelay + travel, 'flight', `lands in ${formatTime(landDelay)}`, origin);
        } else {
            consider(f.owner_name, cv, travel, 'orbit', '', origin);
        }
    }

    for (const h of homes) {
        const pp = cleanInt(h.production_points);
        const ad = cleanInt(h.astro_dollars);
        const totalPp = pp + (ppPrice > 0 ? ad / ppPrice : 0);
        // Affordable CV from PP + A$ (A$ valued in PP), given ship costs at this Eco.
        const totalCv = Math.floor(totalPp / costPerCv(h.economy));
        if (totalCv <= 0) continue;
        // Suggest a full D/C/B fleet: 1 Cruiser (24 CV) + 1 Battleship (60 CV) + the max
        // Destroyers (3 CV each) affordable from what's left. 1C+1B is the minimum for a
        // "full" fleet so the defender's player level counts in the win-chance formula.
        // Can't afford the 1C+1B core? Fall back to all-destroyers.
        let ships, cv, note;
        const D_CV = SHIPS[0].cv;
        const CORE_CV = cvOf([0, 1, 1]);
        if (totalCv >= CORE_CV) {
            const nD = Math.floor((totalCv - CORE_CV) / D_CV);
            ships = [nD, 1, 1];
            note = `build & launch: ${nD}D 1C 1B`;
        } else {
            const nD = Math.floor(totalCv / D_CV);
            if (nD <= 0) continue;
            ships = [nD, 0, 0];
            note = `build & launch: ${nD}D`;
        }
        cv = cvOf(ships);
        const travel = calcTravelSeconds(h.sx, h.sy, h.launch_planet, target.x, target.y, attack.planetIndex, h.energy, h.race_speed, true);
        consider(h.owner_name, cv, travel, 'build', note, { ships });
    }

    // Attach a real Discord mention where we know the player's numeric id (matched
    // game_name -> app_users.discord_id). Renders as their Discord name AND pings them.
    for (const a of byPlayer.values()) {
        try {
            const row = usersRepo.getUserMentionByGameName(a.name.toLowerCase());
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
    // Only surface "late" defenders who are *barely* missing it (< 15 min) — anyone
    // further out is noise.
    const late = all.filter(a => a.delta < 0 && a.delta > -LATE_WINDOW).sort((a, b) => b.delta - a.delta);

    return { unknownTiming: false, timeUntilImpact, onTime, late };
}

const SOURCE_TAG = { orbit: '🛰️', flight: '✈️', build: '🏗️' };

module.exports = {
    ONTIME_LIMIT, LATE_LIMIT, SOURCE_TAG,
    cleanInt, cvOf, costPerCv, getPpPrice, computeInterceptors
};
