const express = require('express');
const db = require('../database');
const { calcTravelSeconds, formatTime } = require('../utils/travel-calc');
const { sendIncomingAlert } = require('../discord_bot');
const router = express.Router();

// Maximum number of "late" responders to list after the on-time ones.
const LATE_LIMIT = 3;
// Maximum number of on-time responders to list.
const ONTIME_LIMIT = 10;

function cleanInt(str) {
    if (str == null) return 0;
    return parseInt(String(str).replace(/[,.\s]/g, ''), 10) || 0;
}

// Parse the forwarded game-notification text into structured attack data.
function parseIncoming(text) {
    const clean = text.replace(/\*\*/g, '').replace(/\*/g, '');

    // Incoming: <name> [<tag>] (<cv>CV, <tr>TR) attacking <defender> on [<sysId>] <sysName> #<planet>.
    const m = clean.match(/Incoming:\s+(.*?)\s+\[(.*?)\]\s+\(([\d,]+)\s*CV,\s*([\d,]+)\s*TR\)\s+attacking\s+(.*?)\s+on\s+\[(\d+)\]\s+(.*?)\s+#(\d+)/i);
    if (!m) return null;

    const data = {
        attackerName: m[1].trim(),
        attackerTag: m[2].trim(),
        cv: cleanInt(m[3]),
        tr: cleanInt(m[4]),
        defenderName: m[5].trim(),
        systemId: parseInt(m[6], 10),
        systemName: m[7].trim(),
        planetIndex: parseInt(m[8], 10),
        destroyers: 0,
        cruisers: 0,
        battleships: 0,
        arrivalUnix: 0
    };

    const ds = clean.match(/([\d,]+)\s+Destroyers?/i);
    if (ds) data.destroyers = cleanInt(ds[1]);
    const cr = clean.match(/([\d,]+)\s+Cruisers?/i);
    if (cr) data.cruisers = cleanInt(cr[1]);
    const bs = clean.match(/([\d,]+)\s+Battleships?/i);
    if (bs) data.battleships = cleanInt(bs[1]);

    // Arrival time: prefer a Discord <t:unix> token, fall back to a parseable date string.
    const t = clean.match(/<t:(\d+)/i);
    if (t) {
        data.arrivalUnix = parseInt(t[1], 10);
    } else {
        const dm = clean.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d+,\s+\d+\s+\d+:\d+/i);
        if (dm) {
            const parsed = Math.floor(new Date(dm[0] + ' UTC').getTime() / 1000);
            if (!isNaN(parsed)) data.arrivalUnix = parsed;
        }
    }

    return data;
}

const cvOf = (f) => (f.destroyers || 0) * 3 + (f.cruisers || 0) * 24 + (f.battleships || 0) * 60;

// Cost per CV in production points at a given economy level: destroyer = 3 CV for
// round(30 * 0.99^eco) PP  →  cost_per_CV = 10 * 0.99^eco.
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

// Build the list of allied defenders that could reach the target, split into on-time and late.
// Sources: fleets in orbit, fleets in flight (land then relaunch), and home-build potential.
function computeInterceptors(attack, nowUnix) {
    const target = db.prepare(`SELECT x, y FROM systems WHERE id = ?`).get(attack.systemId);
    if (!target || target.x == null || target.y == null) return null;

    const defender = db.prepare(`SELECT alliance_id FROM players WHERE name = ? COLLATE NOCASE`).get(attack.defenderName);
    const allianceId = defender && defender.alliance_id ? defender.alliance_id : null;

    // --- Candidate fleets (orbit + in flight) ---
    const fleetWhere = allianceId
        ? `p.alliance_id = @aid`
        : `LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1)`;

    const fleets = db.prepare(`
        SELECT f.planet_index, f.destroyers, f.cruisers, f.battleships, f.arrival_at,
               p.name AS owner_name, p.energy, p.race_speed,
               s.x AS sx, s.y AS sy
        FROM fleets f
        JOIN players p ON f.owner_id = p.id
        JOIN systems s ON f.system_id = s.id
        WHERE ${fleetWhere} AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(allianceId ? { aid: allianceId } : {});

    const ppPrice = getPpPrice();

    // --- Candidate home-build launches ---
    const homeWhere = allianceId
        ? `p.alliance_id = @aid`
        : `LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1)`;

    const homes = db.prepare(`
        SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
               COALESCE(p.home_planet_index, 1) AS launch_planet,
               ams.production_points, ams.astro_dollars,
               s.x AS sx, s.y AS sy
        FROM players p
        JOIN alliance_member_stats ams ON ams.player_id = p.id
        JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
        WHERE ${homeWhere} AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(allianceId ? { aid: allianceId } : {});

    const timeUntilImpact = attack.arrivalUnix > 0 ? attack.arrivalUnix - nowUnix : null;

    // Collect every candidate option, then keep each player's single best (lowest ETA).
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
        // Alliance defence travel runs at 50% (isAlliance = true).
        const travel = calcTravelSeconds(f.sx, f.sy, f.planet_index, target.x, target.y, attack.planetIndex, f.energy, f.race_speed, true);

        // In-flight: must land first, then relaunch from the landing spot.
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

    const all = Array.from(byPlayer.values());
    if (timeUntilImpact == null) {
        all.sort((a, b) => a.eta - b.eta);
        return { unknownTiming: true, onTime: all.slice(0, ONTIME_LIMIT), late: [] };
    }

    all.forEach(a => { a.delta = timeUntilImpact - a.eta; });
    const onTime = all.filter(a => a.delta >= 0).sort((a, b) => a.eta - b.eta);
    const late = all.filter(a => a.delta < 0).sort((a, b) => b.delta - a.delta); // least-late first

    return { unknownTiming: false, timeUntilImpact, onTime, late };
}

const SOURCE_TAG = { orbit: '🛰️', flight: '✈️', build: '🏗️' };

function buildMessage(attack, result) {
    const lines = [];
    lines.push('🚨 **Incoming Attack**');
    lines.push(`⚔️ **Attacker:** ${attack.attackerName} [${attack.attackerTag}] — ${attack.cv.toLocaleString()} CV, ${attack.tr.toLocaleString()} TR`);

    const ships = [];
    if (attack.destroyers) ships.push(`${attack.destroyers.toLocaleString()} DS`);
    if (attack.cruisers) ships.push(`${attack.cruisers.toLocaleString()} CR`);
    if (attack.battleships) ships.push(`${attack.battleships.toLocaleString()} BS`);
    if (ships.length) lines.push(`🛰️ **Fleet:** ${ships.join(', ')}`);

    lines.push(`🎯 **Target:** ${attack.defenderName} — ${attack.systemName} #${attack.planetIndex} [${attack.systemId}]`);
    if (attack.arrivalUnix > 0) lines.push(`🕐 **Arrival:** <t:${attack.arrivalUnix}:R>`);

    if (!result) {
        lines.push('\n⚠️ *Target system not in database — cannot compute interceptors.*');
        return lines.join('\n');
    }

    if (result.unknownTiming) {
        lines.push('\n🛡️ **Closest defenders** *(arrival time unknown):*');
        if (result.onTime.length === 0) lines.push('❌ No allied defenders found.');
        result.onTime.forEach(a => {
            lines.push(`• ${SOURCE_TAG[a.source] || ''} **${a.name}** \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)}${a.note ? ` *(${a.note})*` : ''}`);
        });
        return lines.join('\n');
    }

    lines.push('\n🛡️ **Can defend in time:**');
    if (result.onTime.length === 0) {
        lines.push('❌ No allied defender can intercept in time.');
    } else {
        result.onTime.slice(0, ONTIME_LIMIT).forEach(a => {
            lines.push(`🟢 ${SOURCE_TAG[a.source] || ''} **${a.name}** \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)} *(spare ${formatTime(a.delta)}${a.note ? `, ${a.note}` : ''})*`);
        });
        if (result.onTime.length > ONTIME_LIMIT) {
            lines.push(`*...and ${result.onTime.length - ONTIME_LIMIT} more in time.*`);
        }
    }

    if (result.late.length > 0) {
        lines.push('\n🟡 **Just missing it:**');
        result.late.slice(0, LATE_LIMIT).forEach(a => {
            lines.push(`🟡 ${SOURCE_TAG[a.source] || ''} **${a.name}** \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)} *(late by ${formatTime(Math.abs(a.delta))}${a.note ? `, ${a.note}` : ''})*`);
        });
    }

    lines.push('\n_🛰️ orbit · ✈️ in flight · 🏗️ build & launch_');
    return lines.join('\n');
}

function extractRaw(payload) {
    let raw = payload.content || '';
    if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
        raw += ' ' + (payload.embeds[0].description || '');
    }
    return raw;
}

// --- INCOMING ATTACK WEBHOOK (external; no session auth) ---
// Pass ?preview=1 (or { "preview": true }) to get the assembled message back in the
// HTTP response WITHOUT posting to Discord — handy for testing parsing + interceptors.
router.post('/game-notifications', (req, res) => {
    const payload = req.body || {};
    const preview = req.query.preview === '1' || req.query.preview === 'true' || payload.preview === true;

    let attack = null, message = null, result = null;
    try {
        const raw = extractRaw(payload);
        if (raw.trim()) {
            attack = parseIncoming(raw);
            if (attack) {
                const nowUnix = Math.floor(Date.now() / 1000);
                result = computeInterceptors(attack, nowUnix);
                message = buildMessage(attack, result);
            }
        }
    } catch (err) {
        console.error('[Webhook] Error processing game notification:', err);
        if (preview) return res.status(500).json({ ok: false, error: err.message });
        return res.status(200).send('OK');
    }

    if (preview) {
        return res.json({
            ok: true,
            parsed: attack,
            matched: !!attack,
            interceptors: result,
            message: message
        });
    }

    // Normal mode: acknowledge immediately, then dispatch to Discord.
    res.status(200).send('OK');
    if (message) {
        sendIncomingAlert(message).catch(err =>
            console.error('[Webhook] Failed to dispatch incoming alert:', err.message)
        );
    }
});

module.exports = router;
