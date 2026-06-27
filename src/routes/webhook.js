const express = require('express');
const { formatTime } = require('../utils/travel-calc');
const { sendIncomingAlert } = require('../discord_bot');
const {
    ONTIME_LIMIT, LATE_LIMIT, SOURCE_TAG,
    cleanInt, computeInterceptors
} = require('../utils/interceptors');
const router = express.Router();

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
            lines.push(`• ${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)}${a.note ? ` *(${a.note})*` : ''}`);
        });
        return lines.join('\n');
    }

    lines.push('\n🛡️ **Can defend in time:**');
    if (result.onTime.length === 0) {
        lines.push('❌ No allied defender can intercept in time.');
    } else {
        result.onTime.slice(0, ONTIME_LIMIT).forEach(a => {
            lines.push(`🟢 ${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)} *(spare ${formatTime(a.delta)}${a.note ? `, ${a.note}` : ''})*`);
        });
        if (result.onTime.length > ONTIME_LIMIT) {
            lines.push(`*...and ${result.onTime.length - ONTIME_LIMIT} more in time.*`);
        }
    }

    if (result.late.length > 0) {
        lines.push('\n🟡 **Just missing it:**');
        result.late.slice(0, LATE_LIMIT).forEach(a => {
            lines.push(`🟡 ${SOURCE_TAG[a.source] || ''} **${a.name}**${a.mention ? ' ' + a.mention : ''} \`[${a.cv.toLocaleString()} CV]\` ➔ ETA ${formatTime(a.eta)} *(late by ${formatTime(Math.abs(a.delta))}${a.note ? `, ${a.note}` : ''})*`);
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
