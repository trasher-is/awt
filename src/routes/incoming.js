const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { sendOrEditIncoming } = require('../discord_bot');
const { formatTime } = require('../utils/travel-calc');
const { ONTIME_LIMIT, LATE_LIMIT, SOURCE_TAG, computeInterceptors } = require('../utils/interceptors');
const router = express.Router();

// Build the compact attacker stat line shown both inline on the News page and in the
// Discord alert, e.g. "+4/+4/-4 p15 m12 e20 pl7".
//   race speed / attack / defence   physics  math  energy   player-level
// Race + science values are only meaningful when we hold an intel report on the player;
// player level is public, so we always show it.
function statLine(s) {
    if (!s) return '';
    const sign = (n) => (n > 0 ? '+' : '') + (n || 0);
    const lvl = s.level ? ` pl${s.level}` : '';
    if (!s.has_intel) return `(no intel)${lvl}`;
    return `${sign(s.race_speed)}/${sign(s.race_attack)}/${sign(s.race_defense)} p${s.physics || 0} m${s.mathematics || 0} e${s.energy || 0}${lvl}`;
}

function getStatsByIds(ids) {
    const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (clean.length === 0) return {};
    const placeholders = clean.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT p.id, p.name, p.level, p.has_intel,
               p.race_speed, p.race_attack, p.race_defense,
               p.physics, p.mathematics, p.energy,
               a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id IN (${placeholders})
    `).all(...clean);

    const out = {};
    for (const r of rows) {
        out[r.id] = { ...r, statLine: statLine(r) };
    }
    return out;
}

// --- CACHED ATTACKER STATS (for inline News-page display) ---
// GET /hub-api/incoming/stats?ids=67,170
router.get('/incoming/stats', requireAuth, (req, res) => {
    try {
        const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
        res.json({ success: true, stats: getStatsByIds(ids) });
    } catch (err) {
        console.error('[Incoming] stats lookup failed:', err.message);
        res.status(500).json({ success: false, error: 'Stats lookup failed' });
    }
});

function buildAnnounce(data, stats) {
    const L = [];
    const planet = data.target.planetName || 'Planet';
    L.push(`🚨 **Incoming Attack** — ${planet} \`[${data.target.systemId}] #${data.target.planetIndex}\``);

    let atk = `⚔️ **${data.attacker.name}**`;
    if (data.attacker.tag) atk += ` [${data.attacker.tag}]`;
    L.push(atk);

    const sline = statLine(stats);
    if (sline) L.push(`🧬 \`${sline}\``);

    const ships = [];
    const s = data.ships || {};
    if (s.transports) ships.push(`${s.transports} TR`);
    if (s.colony) ships.push(`${s.colony} CO`);
    if (s.destroyers) ships.push(`${s.destroyers} DS`);
    if (s.cruisers) ships.push(`${s.cruisers} CR`);
    if (s.battleships) ships.push(`${s.battleships} BS`);
    L.push(`🛰️ **${(data.cv || 0).toLocaleString()} CV**${ships.length ? ' — ' + ships.join(', ') : ''}`);

    const arr = parseInt(data.arrivalUnix, 10);
    if (Number.isInteger(arr) && arr > 0) L.push(`🕐 ~ <t:${arr}:f>`);

    appendDefenders(L, data, arr);

    const now = Math.floor(Date.now() / 1000);
    L.push(`_updated <t:${now}:R>_`);
    return L.join('\n');
}

// Append the "who can defend in time" section, computed from the latest alliance fleet
// positions (refreshed by the alliance scan before announcing).
function appendDefenders(L, data, arrivalUnix) {
    if (!data.target || data.target.systemId == null || data.target.planetIndex == null) return;

    // Defender = the targeted planet's current owner (an alliance member), so the
    // interceptor search is scoped to our alliance.
    let defenderName = null;
    try {
        const row = db.prepare(`
            SELECT pl.name FROM planets pn
            JOIN players pl ON pn.owner_id = pl.id
            WHERE pn.system_id = ? AND pn.planet_index = ?
        `).get(data.target.systemId, data.target.planetIndex);
        if (row) defenderName = row.name;
    } catch (e) { /* fall back to active-users scope */ }

    const nowUnix = Math.floor(Date.now() / 1000);
    const result = computeInterceptors({
        systemId: data.target.systemId,
        planetIndex: data.target.planetIndex,
        defenderName,
        arrivalUnix: Number.isInteger(arrivalUnix) && arrivalUnix > 0 ? arrivalUnix : 0
    }, nowUnix);

    if (!result) {
        L.push('\n⚠️ *Target system not mapped — cannot compute defenders.*');
        return;
    }

    const line = (a, extra) =>
        `${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)}${extra || ''}`;

    if (result.unknownTiming) {
        L.push('\n🛡️ **Closest defenders** *(arrival time unknown):*');
        if (!result.onTime.length) { L.push('❌ No allied defenders found.'); return; }
        result.onTime.forEach(a => L.push('• ' + line(a, a.note ? ` *(${a.note})*` : '')));
        return;
    }

    L.push('\n🛡️ **Can defend in time:**');
    if (!result.onTime.length) {
        L.push('❌ No allied defender can intercept in time.');
    } else {
        result.onTime.slice(0, ONTIME_LIMIT).forEach(a =>
            L.push('🟢 ' + line(a, ` *(spare ${formatTime(a.delta)}${a.note ? `, ${a.note}` : ''})*`)));
        if (result.onTime.length > ONTIME_LIMIT) L.push(`*...and ${result.onTime.length - ONTIME_LIMIT} more in time.*`);
    }

    if (result.late.length) {
        L.push('\n🟡 **Just missing it:**');
        result.late.slice(0, LATE_LIMIT).forEach(a =>
            L.push('🟡 ' + line(a, ` *(late by ${formatTime(Math.abs(a.delta))}${a.note ? `, ${a.note}` : ''})*`)));
    }

    L.push('\n_🛰️ orbit · ✈️ in flight · 🏗️ build & launch_');
}

// --- ANNOUNCE / UPDATE AN INCOMING ON DISCORD ---
// POST /hub-api/incoming/announce
// Body: { fleetId, attacker:{id,name,tag}, target:{planetId,systemId,planetIndex,planetName}, cv, ships:{...}, arrivalText }
router.post('/incoming/announce', requireAuth, async (req, res) => {
    const data = req.body || {};
    const fleetId = parseInt(data.fleetId, 10);

    if (!Number.isInteger(fleetId) || fleetId <= 0) {
        return res.status(400).json({ success: false, error: 'Missing/invalid fleetId' });
    }
    if (!data.attacker || !data.attacker.name || !data.target) {
        return res.status(400).json({ success: false, error: 'Missing attacker/target' });
    }

    try {
        const stats = data.attacker.id ? getStatsByIds([data.attacker.id])[data.attacker.id] : null;
        const message = buildAnnounce(data, stats);
        const result = await sendOrEditIncoming(fleetId, message);
        if (!result.ok) return res.status(502).json({ success: false, error: result.error });
        res.json({ success: true, edited: !!result.edited });
    } catch (err) {
        console.error('[Incoming] announce failed:', err.message);
        res.status(500).json({ success: false, error: 'Announce failed' });
    }
});

module.exports = router;
