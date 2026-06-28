const express = require('express');
const { cleanInt } = require('../utils/interceptors');
const incoming = require('./incoming');
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

// Map the parsed webhook text into the shared announceIncoming payload.
function toAnnounceData(a) {
    return {
        attacker: { id: null, name: a.attackerName, tag: a.attackerTag },
        target: {
            systemId: a.systemId,
            planetIndex: a.planetIndex,
            planetName: `${a.systemName} #${a.planetIndex}`
        },
        cv: a.cv,
        ships: { transports: a.tr, destroyers: a.destroyers, cruisers: a.cruisers, battleships: a.battleships },
        arrivalUnix: a.arrivalUnix
    };
}

function extractRaw(payload) {
    let raw = payload.content || '';
    if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
        raw += ' ' + (payload.embeds[0].description || '');
    }
    return raw;
}

// --- INCOMING ATTACK WEBHOOK (external; no session auth) ---
// Auto-posts the incoming alert via the SAME path as the News "announce" button, so the
// News-page refresh edits this very message. Pass ?preview=1 to get the parsed data back
// without posting.
router.post('/game-notifications', async (req, res) => {
    const payload = req.body || {};
    const preview = req.query.preview === '1' || req.query.preview === 'true' || payload.preview === true;

    let attack = null;
    try {
        const raw = extractRaw(payload);
        if (raw.trim()) attack = parseIncoming(raw);
    } catch (err) {
        console.error('[Webhook] Error parsing game notification:', err);
        if (preview) return res.status(500).json({ ok: false, error: err.message });
        return res.status(200).send('OK');
    }

    if (preview) {
        return res.json({ ok: true, matched: !!attack, parsed: attack, data: attack ? toAnnounceData(attack) : null });
    }

    res.status(200).send('OK');
    if (attack) {
        incoming.announceIncoming(toAnnounceData(attack)).catch(err =>
            console.error('[Webhook] Failed to dispatch incoming alert:', err.message)
        );
    }
});

module.exports = router;
