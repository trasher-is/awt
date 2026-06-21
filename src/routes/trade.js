const express = require('express');
const db = require('../database');
const { requireAuth, requireAdmin } = require('./_middleware');
const router = express.Router();

const MAX_TAS = 5;

const pairKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|');

// A player is a trader only if their race carries the trader trait
// (race_trader > 0), and only when we have intel to know that. The old
// manual ta_traders list mis-tagged people whose race isn't actually trader.
function getTraders() {
    const rows = db.prepare(`
        SELECT p.name
        FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        WHERE p.has_intel = 1 AND p.race_trader > 0
    `).all();
    return rows.map(r => r.name.toLowerCase());
}

// Locale-agnostic: handles both "1 234,56" (comma decimal) and "1,234.56" (dot
// decimal), plus space/NBSP thousands. Both separators present -> the later one
// is the decimal; a single separator with exactly 3 trailing digits is thousands.
function parseLocaleNumber(str) {
    if (str == null) return 0;
    let s = String(str).replace(/[^\d.,\-]/g, '');
    if (!s) return 0;
    const nComma = (s.match(/,/g) || []).length;
    const nDot = (s.match(/\./g) || []).length;
    let dec = null;
    if (nComma && nDot) {
        dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    } else if (nComma === 1 || nDot === 1) {
        const sep = nComma ? ',' : '.';
        if (s.length - s.lastIndexOf(sep) - 1 !== 3) dec = sep;
    }
    if (dec) s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
    else s = s.replace(/[.,]/g, '');
    const v = parseFloat(s);
    return isNaN(v) ? 0 : v;
}

// Current alliance members (those we have stats for), with trader flag and wealth.
//   hoarded_au — A$ value of artifacts + supply units held (from /Game/Trade scrape)
//   visible_au — openly-visible liquidity: Astro Dollars + Production Points × PP price
function getMembers() {
    const ppRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`).get();
    const ppPrice = ppRow ? parseFloat(ppRow.value) || 0 : 0;

    const rows = db.prepare(`
        SELECT p.name, p.has_intel, p.race_trader,
               ams.hoarded_au, ams.astro_dollars, ams.production_points
        FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        ORDER BY p.name COLLATE NOCASE ASC
    `).all();

    return rows.map(r => {
        const visible = parseLocaleNumber(r.astro_dollars) + parseLocaleNumber(r.production_points) * ppPrice;
        return {
            name: r.name,
            isTrader: r.has_intel === 1 && r.race_trader > 0,
            hoarded_au: Math.round(r.hoarded_au || 0),
            visible_au: Math.round(visible)
        };
    });
}

// How many active agreements (proposed/confirmed/done) a player is involved in.
function countFor(nameLower) {
    const rows = db.prepare(`
        SELECT pair_key FROM trade_agreements
        WHERE status IN ('proposed','confirmed','done')
    `).all();
    return rows.filter(r => r.pair_key.split('|').includes(nameLower)).length;
}

// --- LIST EVERYTHING NEEDED TO RENDER THE BOARD ---
router.get('/trade-agreements', requireAuth, (req, res) => {
    try {
        const agreements = db.prepare(`SELECT * FROM trade_agreements WHERE status != 'cancelled' ORDER BY id ASC`).all();
        res.json({
            success: true,
            me: req.session.gameName,
            isAdmin: req.session.role === 'admin',
            maxTas: MAX_TAS,
            traders: getTraders(),
            members: getMembers(),
            agreements
        });
    } catch (err) {
        console.error('[DB Error] trade-agreements list:', err);
        res.status(500).json({ error: 'Failed to load trade agreements' });
    }
});

// Shared validation for forming a new pair.
function validatePair(aName, bName) {
    if (!aName || !bName) return 'Both players are required.';
    if (aName.toLowerCase() === bName.toLowerCase()) return 'A player cannot trade with themselves.';

    const traders = new Set(getTraders());
    if (traders.has(aName.toLowerCase()) && traders.has(bName.toLowerCase())) {
        return 'Two traders cannot trade with each other.';
    }

    const existing = db.prepare(`SELECT status FROM trade_agreements WHERE pair_key = ?`).get(pairKey(aName, bName));
    if (existing && existing.status !== 'cancelled') return 'This pairing already exists.';

    if (countFor(aName.toLowerCase()) >= MAX_TAS) return `${aName} already has ${MAX_TAS} agreements.`;
    if (countFor(bName.toLowerCase()) >= MAX_TAS) return `${bName} already has ${MAX_TAS} agreements.`;

    return null;
}

// Resolve a member's canonical display name (case-correct) from the roster.
function canonicalName(name) {
    const row = db.prepare(`
        SELECT p.name FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        WHERE p.name = ? COLLATE NOCASE LIMIT 1
    `).get(name);
    return row ? row.name : name;
}

// --- PROPOSE: current user offers a TA to a partner (awaits their confirmation) ---
router.post('/trade-agreements/propose', requireAuth, (req, res) => {
    const me = req.session.gameName;
    const partner = canonicalName((req.body.partner || '').trim());

    const err = validatePair(me, partner);
    if (err) return res.status(400).json({ error: err });

    try {
        const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
        db.prepare(`
            INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
            VALUES (?, ?, ?, 'proposed', ?, 0)
            ON CONFLICT(pair_key) DO UPDATE SET status='proposed', initiator=excluded.initiator, updated_at=CURRENT_TIMESTAMP
                WHERE trade_agreements.status='cancelled'
        `).run(pairKey(me, partner), a, b, me);
        res.json({ success: true });
    } catch (e) {
        console.error('[DB Error] propose:', e);
        res.status(500).json({ error: 'Failed to propose agreement' });
    }
});

// --- CONFIRM: the counterpart accepts a proposed TA ---
router.post('/trade-agreements/:id/confirm', requireAuth, (req, res) => {
    const ta = db.prepare(`SELECT * FROM trade_agreements WHERE id = ?`).get(req.params.id);
    if (!ta) return res.status(404).json({ error: 'Agreement not found' });
    if (ta.status !== 'proposed') return res.status(400).json({ error: 'Only proposed agreements can be confirmed.' });

    const me = (req.session.gameName || '').toLowerCase();
    const isAdmin = req.session.role === 'admin';
    const involved = ta.pair_key.split('|');
    // The confirmer must be the OTHER party (not the proposer), or an admin.
    if (!isAdmin && (!involved.includes(me) || me === (ta.initiator || '').toLowerCase())) {
        return res.status(403).json({ error: 'Only the other player (or an admin) can confirm this.' });
    }

    db.prepare(`UPDATE trade_agreements SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(ta.id);
    res.json({ success: true });
});

// --- CANCEL/REMOVE: either participant or an admin ---
router.post('/trade-agreements/:id/cancel', requireAuth, (req, res) => {
    const ta = db.prepare(`SELECT * FROM trade_agreements WHERE id = ?`).get(req.params.id);
    if (!ta) return res.status(404).json({ error: 'Agreement not found' });

    const me = (req.session.gameName || '').toLowerCase();
    const isAdmin = req.session.role === 'admin';
    if (!isAdmin && !ta.pair_key.split('|').includes(me)) {
        return res.status(403).json({ error: 'You are not part of this agreement.' });
    }

    db.prepare(`DELETE FROM trade_agreements WHERE id=?`).run(ta.id);
    res.json({ success: true });
});

// --- ADMIN: force-set a pairing (created already confirmed) ---
router.post('/admin/trade-agreements', requireAdmin, (req, res) => {
    const a = canonicalName((req.body.player_a || '').trim());
    const b = canonicalName((req.body.player_b || '').trim());

    const err = validatePair(a, b);
    if (err) return res.status(400).json({ error: err });

    const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    db.prepare(`
        INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
        VALUES (?, ?, ?, 'confirmed', 'admin', 1)
        ON CONFLICT(pair_key) DO UPDATE SET status='confirmed', is_admin_set=1, initiator='admin', updated_at=CURRENT_TIMESTAMP
    `).run(pairKey(a, b), pa, pb);
    res.json({ success: true });
});

// --- COMPLETION SYNC: scraped from a member's /Game/Trade/Agreements page ---
// Body: { partners: ["NameA","NameB", ...] } — partners the logged-in user already has TAs with.
router.post('/sync/trade-agreements', requireAuth, (req, res) => {
    const me = req.session.gameName;
    const partners = Array.isArray(req.body.partners) ? req.body.partners : [];
    if (!me) return res.status(400).json({ error: 'No session identity' });

    const markDone = db.prepare(`
        INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
        VALUES (?, ?, ?, 'done', ?, 0)
        ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
    `);

    const tx = db.transaction((list) => {
        for (const raw of list) {
            const partner = canonicalName(String(raw).trim());
            if (!partner || partner.toLowerCase() === me.toLowerCase()) continue;
            const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            markDone.run(pairKey(me, partner), a, b, me);
        }
    });

    try {
        tx(partners);
        res.json({ success: true, synced: partners.length });
    } catch (e) {
        console.error('[DB Error] sync trade-agreements:', e);
        res.status(500).json({ error: 'Failed to sync agreements' });
    }
});

// --- COMPLETION SYNC (alliance-wide): scraped from each member's "Trade Partners" table ---
// Body: { pairs: [["Owner","Partner"], ...] } — every owner↔partner pairing seen across
// the alliance scan. Each becomes a 'done' agreement. Symmetric pairs collapse via pair_key.
router.post('/sync/trade-partners', requireAuth, (req, res) => {
    const pairs = Array.isArray(req.body.pairs) ? req.body.pairs : [];

    const markDone = db.prepare(`
        INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
        VALUES (?, ?, ?, 'done', 'scan', 0)
        ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
    `);

    const tx = db.transaction((list) => {
        let n = 0;
        for (const pair of list) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const a = canonicalName(String(pair[0]).trim());
            const b = canonicalName(String(pair[1]).trim());
            if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
            const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            markDone.run(pairKey(a, b), pa, pb);
            n++;
        }
        return n;
    });

    try {
        const n = tx(pairs);
        res.json({ success: true, synced: n });
    } catch (e) {
        console.error('[DB Error] sync trade-partners:', e);
        res.status(500).json({ error: 'Failed to sync trade partners' });
    }
});

// --- HOARD SYNC: the logged-in member's A$ value of held artifacts + supply units ---
// Body: { hoarded_au: <number> } — scraped from their /Game/Trade inventory.
router.post('/sync/trade-inventory', requireAuth, (req, res) => {
    const me = req.session.gameName;
    if (!me) return res.status(400).json({ error: 'No session identity' });

    const n = parseInt(req.body.hoarded_au, 10);
    const value = isNaN(n) ? 0 : Math.max(0, n);

    try {
        const row = db.prepare(`SELECT id FROM players WHERE name = ? COLLATE NOCASE`).get(me);
        if (!row) return res.json({ success: true, stored: false });
        db.prepare(`
            INSERT INTO alliance_member_stats (player_id, hoarded_au, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET hoarded_au = excluded.hoarded_au, updated_at = CURRENT_TIMESTAMP
        `).run(row.id, value);
        res.json({ success: true, stored: true });
    } catch (e) {
        console.error('[DB Error] sync trade-inventory:', e);
        res.status(500).json({ error: 'Failed to sync inventory' });
    }
});

module.exports = router;
