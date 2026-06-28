const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { sendOrEditIncoming, replyToIncoming } = require('../discord_bot');
const { formatTime } = require('../utils/travel-calc');
const { ONTIME_LIMIT, LATE_LIMIT, SOURCE_TAG, computeInterceptors } = require('../utils/interceptors');
const { winChance, resolveStats } = require('../utils/battle');
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

function buildAnnounce(data, stats, result) {
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

    appendDefenders(L, result, data.target);

    const now = Math.floor(Date.now() / 1000);
    L.push(`_updated <t:${now}:R>_`);
    return L.join('\n');
}

// Run the interceptor analysis for an announce payload. Returns the computeInterceptors
// result (or null if the target system isn't mapped / has no coords).
function computeDefenders(data) {
    if (!data.target || data.target.systemId == null || data.target.planetIndex == null) return null;

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

    const arr = parseInt(data.arrivalUnix, 10);
    const result = computeInterceptors({
        systemId: data.target.systemId,
        planetIndex: data.target.planetIndex,
        defenderName,
        arrivalUnix: Number.isInteger(arr) && arr > 0 ? arr : 0
    }, Math.floor(Date.now() / 1000));

    if (result) {
        attachWinChances(result, data);
        // Only surface defenders with a real shot (≥25%) — anything less is a gamble.
        // Keep entries whose win couldn't be computed (null) so they aren't silently lost.
        const worthIt = d => d.win == null || d.win >= 0.25;
        result.onTime = result.onTime.filter(worthIt);
        if (result.late) result.late = result.late.filter(worthIt);
    }
    return result;
}

const STAT_COLS = `race_attack, race_defense, physics, mathematics, science_level, level, has_intel, intel_updated_at`;

// Attach each defender's chance to beat the incoming fleet (defender fleet vs attacker
// fleet). Attacker race/sciences fall back to assumptions when unknown/stale.
function attachWinChances(result, data) {
    try {
        const s = data.ships || {};
        const enemyFleet = [s.destroyers || 0, s.cruisers || 0, s.battleships || 0];
        let enemyRow = null;
        if (data.attacker && data.attacker.id) {
            enemyRow = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE id = ?`).get(data.attacker.id);
        }
        if (!enemyRow && data.attacker && data.attacker.name) {
            enemyRow = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ?`).get(data.attacker.name.toLowerCase());
        }
        const enemyStats = resolveStats(enemyRow);

        const statStmt = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ?`);
        const all = [...result.onTime, ...(result.late || [])];
        for (const d of all) {
            const allyFleet = d.ships || [Math.floor(d.cv / 3), 0, 0];
            const allyRow = statStmt.get(d.name.toLowerCase());
            d.win = winChance(allyFleet, resolveStats(allyRow), enemyFleet, enemyStats);
            d.winUnknown = enemyStats.unknown; // attacker race not scouted
        }
    } catch (e) {
        console.error('[Incoming] win-chance calc failed:', e.message);
    }
}

// Game launch deep-link for an existing fleet -> the attack target. Only works for the
// fleet's owner when logged in, and only when we know the fleet's id + the proxy domain.
function launchUrl(a, target) {
    if (!a.fleetId || !process.env.PROXY_DOMAIN || !target || target.systemId == null || target.planetIndex == null) return null;
    return `https://${process.env.PROXY_DOMAIN}/Game/Fleets/Launch/${a.fleetId}?systemId=${target.systemId}&planetIndex=${target.planetIndex}`;
}

function winTag(a) {
    if (a.win == null) return '';
    return ` · 🎲 ${Math.round(a.win * 100)}%${a.winUnknown ? '?' : ''}`;
}

function defenderLine(a, extra, target) {
    let s = `${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)}${winTag(a)}${extra || ''}`;
    const url = launchUrl(a, target);
    // Masked links ([text](url)) only render in embeds; this is a plain message (needed
    // so @mentions ping), so use a bare <url> — clickable, with the preview suppressed.
    if (url) s += ` · 🚀 <${url}>`;
    return s;
}

// Append the "who can defend in time" section to the main alert.
function appendDefenders(L, result, target) {
    if (!result) {
        L.push('\n⚠️ *Target system not mapped — cannot compute defenders.*');
        return;
    }

    if (result.unknownTiming) {
        L.push('\n🛡️ **Closest defenders** *(arrival time unknown):*');
        if (!result.onTime.length) { L.push('❌ No allied defenders found.'); return; }
        result.onTime.forEach(a => L.push('• ' + defenderLine(a, a.note ? ` *(${a.note})*` : '', target)));
        return;
    }

    L.push('\n🛡️ **Can defend in time:**');
    if (!result.onTime.length) {
        L.push('❌ No allied defender can intercept in time.');
    } else {
        result.onTime.slice(0, ONTIME_LIMIT).forEach(a =>
            L.push('🟢 ' + defenderLine(a, ` *(spare ${formatTime(a.delta)}${a.note ? `, ${a.note}` : ''})*`, target)));
        if (result.onTime.length > ONTIME_LIMIT) L.push(`*...and ${result.onTime.length - ONTIME_LIMIT} more in time.*`);
    }

    if (result.late.length) {
        L.push('\n🟡 **Just missing it:**');
        result.late.slice(0, LATE_LIMIT).forEach(a =>
            L.push('🟡 ' + defenderLine(a, ` *(late by ${formatTime(Math.abs(a.delta))}${a.note ? `, ${a.note}` : ''})*`, target)));
    }

    L.push('\n_🛰️ orbit · ✈️ in flight · 🏗️ build & launch_');
}

// The names that count as "able to arrive in time" right now (for change detection).
function onTimeNames(result) {
    if (!result) return [];
    return result.onTime.map(a => a.name.toLowerCase()).sort();
}

// Reply body: only the defenders who can make it, with @mentions so they get pinged.
// Returns null if there's no one to notify.
function buildReply(result, planetLabel, target) {
    if (!result || !result.onTime.length) return null;
    const L = [`🟢 **Reinforcements available** for ${planetLabel} — can arrive in time:`];
    result.onTime.slice(0, ONTIME_LIMIT).forEach(a => {
        const spare = (!result.unknownTiming && a.delta != null) ? ` *(spare ${formatTime(a.delta)})*` : '';
        L.push(defenderLine(a, spare, target));
    });
    return L.join('\n');
}

// Stable identity for an incoming, shared by the webhook auto-post and the News announce
// so both edit the same Discord message: "system:planet:attacker" (attacker lowercased).
function alertKeyFor(data) {
    const t = data.target || {};
    const name = (data.attacker && data.attacker.name ? data.attacker.name : '').toLowerCase().trim();
    return `${t.systemId}:${t.planetIndex}:${name}`;
}

// --- ANNOUNCE / UPDATE AN INCOMING ON DISCORD ---
// Body: { attacker:{id,name,tag}, target:{systemId,planetIndex,planetName}, cv, ships:{...}, arrivalUnix }
// Core announce/update logic, shared by the webhook auto-post, the News "announce" button,
// and the dev test harness. Edits (or sends) the main alert keyed by the attack identity,
// then posts a pinging reply when the on-time roster gains someone. Returns { ok, edited, replied }.
async function announceIncoming(data) {
    if (!data.attacker || !data.attacker.name || !data.target ||
        data.target.systemId == null || data.target.planetIndex == null) {
        return { ok: false, error: 'Missing attacker/target' };
    }
    const alertKey = alertKeyFor(data);

    let stats = data.attacker.id ? getStatsByIds([data.attacker.id])[data.attacker.id] : null;
    if (!stats) {
        // Webhook only knows the attacker's name — resolve stats by name.
        const row = db.prepare(`
            SELECT p.id, p.name, p.level, p.has_intel, p.race_speed, p.race_attack, p.race_defense,
                   p.physics, p.mathematics, p.energy, a.tag AS alliance_tag
            FROM players p LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE LOWER(p.name) = ?
        `).get(data.attacker.name.toLowerCase());
        if (row) stats = { ...row, statLine: statLine(row) };
    }

    const defenders = computeDefenders(data);
    const message = buildAnnounce(data, stats, defenders);

    const sent = await sendOrEditIncoming(alertKey, message);
    if (!sent.ok) return { ok: false, error: sent.error };

    // Editing the main alert never pings anyone, so when the on-time roster GAINS someone
    // (fleet built / TT recalc) we post a reply that mentions the full current list. On a
    // brand-new alert (not an edit) the main message already pinged, so just record state.
    let replied = false;
    const current = onTimeNames(defenders);
    try {
        const prevRow = db.prepare(`SELECT last_ontime FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
        const prev = prevRow && prevRow.last_ontime ? prevRow.last_ontime.split(',').filter(Boolean) : [];
        const prevSet = new Set(prev);
        const newcomers = current.filter(n => !prevSet.has(n));

        if (sent.edited && newcomers.length > 0) {
            const planetLabel = `${data.target.planetName || 'Planet'} [${data.target.systemId}] #${data.target.planetIndex}`;
            const reply = buildReply(defenders, planetLabel, data.target);
            if (reply) replied = await replyToIncoming(sent.channelId, sent.messageId, reply);
        }
        db.prepare(`UPDATE incoming_msgs SET last_ontime = ? WHERE alert_key = ?`).run(current.join(','), alertKey);
    } catch (e) {
        console.error('[Incoming] reply bookkeeping failed:', e.message);
    }

    return { ok: true, edited: !!sent.edited, replied };
}

// --- ANNOUNCE / UPDATE AN INCOMING ON DISCORD ---
// POST /hub-api/incoming/announce
// Body: { fleetId, attacker:{id,name,tag}, target:{planetId,systemId,planetIndex,planetName}, cv, ships:{...}, arrivalUnix }
router.post('/incoming/announce', requireAuth, async (req, res) => {
    try {
        const r = await announceIncoming(req.body || {});
        if (!r.ok) return res.status(r.error && r.error.startsWith('Missing') ? 400 : 502).json({ success: false, error: r.error });
        res.json({ success: true, edited: r.edited, replied: r.replied });
    } catch (err) {
        console.error('[Incoming] announce failed:', err.message);
        res.status(500).json({ success: false, error: 'Announce failed' });
    }
});

// --- DEFENDER ANALYSIS (for inline display on the News page) ---
// POST /hub-api/incoming/defenders  Body: { target:{systemId,planetIndex}, arrivalUnix }
// Returns the on-time / late interceptor lists (no Discord mentions — page display only).
router.post('/incoming/defenders', requireAuth, (req, res) => {
    try {
        const data = req.body || {};
        const result = computeDefenders(data);
        if (!result) return res.json({ success: true, mapped: false });
        const slim = (a) => ({
            name: a.name, cv: a.cv, eta: a.eta, delta: a.delta, source: a.source, note: a.note,
            ownerId: a.ownerId, originSys: a.originSys, originIdx: a.originIdx, fleetId: a.fleetId,
            win: a.win, winUnknown: a.winUnknown
        });
        res.json({
            success: true,
            mapped: true,
            unknownTiming: !!result.unknownTiming,
            onTime: result.onTime.map(slim),
            late: (result.late || []).map(slim)
        });
    } catch (err) {
        console.error('[Incoming] defenders lookup failed:', err.message);
        res.status(500).json({ success: false, error: 'Defender lookup failed' });
    }
});

module.exports = router;
module.exports.announceIncoming = announceIncoming;
