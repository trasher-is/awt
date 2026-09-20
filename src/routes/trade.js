const express = require('express');
const db = require('../database');
const { requireAuth, requireAdmin } = require('./_middleware');
const playersRepo = require('../repositories/players');
const alliancesRepo = require('../repositories/alliances');
const tradeRepo = require('../repositories/trade');
const settingsRepo = require('../repositories/settings');
const router = express.Router();

const MAX_TAS = 5;

const pairKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|');

// A player is a trader only if their race carries the trader trait
// (race_trader > 0), and only when we have intel to know that. The old
// manual ta_traders list mis-tagged people whose race isn't actually trader.
function getTraders() {
    const rows = alliancesRepo.getTraders();
    return rows.map(r => r.name.toLowerCase());
}

// This file's parseLocaleNumber was the only correct one of the three the project had;
// it now lives in the shared module so interceptors.js and intel.js use it too, along
// with every browser scraper.
const { parseLocaleNumber } = require('../../public/js/utils/parse-number.js');

// Current alliance members (those we have stats for), with trader flag and wealth.
//   hoarded_au — A$ value of artifacts + supply units held (from /Game/Trade scrape)
//   visible_au — openly-visible liquidity: Astro Dollars + Production Points × PP price
function getMembers() {
    const ppRow = settingsRepo.getPpPrice();
    const ppPrice = ppRow ? parseFloat(ppRow.value) || 0 : 0;

    const rows = alliancesRepo.getMembersWithStats();

    return rows.map(r => {
        const visible = parseLocaleNumber(r.astro_dollars) + parseLocaleNumber(r.production_points) * ppPrice;
        // A$/hour income: Production Points produced per hour valued at the live PP price.
        const auPerH = parseLocaleNumber(r.production_rate) * ppPrice;
        return {
            name: r.name,
            isTrader: r.has_intel === 1 && r.race_trader > 0,
            hoarded_au: Math.round(r.hoarded_au || 0),
            visible_au: Math.round(visible),
            au_per_h: Math.round(auPerH)
        };
    });
}

// How many active agreements (proposed/confirmed/done) a player is involved in.
function countFor(nameLower) {
    const rows = tradeRepo.getActivePairKeys();
    return rows.filter(r => r.pair_key.split('|').includes(nameLower)).length;
}

// --- LIST EVERYTHING NEEDED TO RENDER THE BOARD ---
router.get('/trade-agreements', requireAuth, (req, res) => {
    try {
        const agreements = tradeRepo.getActiveAgreements();
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

    const existing = tradeRepo.getAgreementStatusByPairKey(pairKey(aName, bName));
    if (existing && existing.status !== 'cancelled') return 'This pairing already exists.';

    if (countFor(aName.toLowerCase()) >= MAX_TAS) return `${aName} already has ${MAX_TAS} agreements.`;
    if (countFor(bName.toLowerCase()) >= MAX_TAS) return `${bName} already has ${MAX_TAS} agreements.`;

    return null;
}

// Resolve a member's canonical display name (case-correct) from the roster.
function canonicalName(name) {
    const row = alliancesRepo.getCanonicalNameFromStats(name);
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
        tradeRepo.proposeAgreement(pairKey(me, partner), a, b, me);
        res.json({ success: true });
    } catch (e) {
        console.error('[DB Error] propose:', e);
        res.status(500).json({ error: 'Failed to propose agreement' });
    }
});

// --- CONFIRM: the counterpart accepts a proposed TA ---
router.post('/trade-agreements/:id/confirm', requireAuth, (req, res) => {
    const ta = tradeRepo.getAgreementById(req.params.id);
    if (!ta) return res.status(404).json({ error: 'Agreement not found' });
    if (ta.status !== 'proposed') return res.status(400).json({ error: 'Only proposed agreements can be confirmed.' });

    const me = (req.session.gameName || '').toLowerCase();
    const isAdmin = req.session.role === 'admin';
    const involved = ta.pair_key.split('|');
    // The confirmer must be the OTHER party (not the proposer), or an admin.
    if (!isAdmin && (!involved.includes(me) || me === (ta.initiator || '').toLowerCase())) {
        return res.status(403).json({ error: 'Only the other player (or an admin) can confirm this.' });
    }

    tradeRepo.confirmAgreement(ta.id);
    res.json({ success: true });
});

// --- CANCEL/REMOVE: either participant or an admin ---
router.post('/trade-agreements/:id/cancel', requireAuth, (req, res) => {
    const ta = tradeRepo.getAgreementById(req.params.id);
    if (!ta) return res.status(404).json({ error: 'Agreement not found' });

    const me = (req.session.gameName || '').toLowerCase();
    const isAdmin = req.session.role === 'admin';
    if (!isAdmin && !ta.pair_key.split('|').includes(me)) {
        return res.status(403).json({ error: 'You are not part of this agreement.' });
    }

    tradeRepo.cancelAgreement(ta.id);
    res.json({ success: true });
});

// --- ADMIN: force-set a pairing (created already confirmed) ---
router.post('/admin/trade-agreements', requireAdmin, (req, res) => {
    const a = canonicalName((req.body.player_a || '').trim());
    const b = canonicalName((req.body.player_b || '').trim());

    const err = validatePair(a, b);
    if (err) return res.status(400).json({ error: err });

    const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    tradeRepo.forceSetAgreement(pairKey(a, b), pa, pb);
    res.json({ success: true });
});

// --- COMPLETION SYNC: scraped from a member's /Game/Trade/Agreements page ---
// Body: { partners: ["NameA","NameB", ...] } — every partner listed on the logged-in
// member's own Existing Agreements table right now, regardless of that row's Status text
// (sent/received/establishing/established all mean at least one side has already sent
// money, which is this alliance's own bar for "done" — see trade-agreements-parser.js).
//
// This is also a complete, current snapshot of that member's real agreements, so it
// doubles as the reconciliation signal: any 'done' pair of mine whose partner is NOT in
// this list was declined before completing, or that partner has resigned, and the Board
// must stop showing it as done (see getDoneAgreementsForPlayer's own comment).
router.post('/sync/trade-agreements', requireAuth, (req, res) => {
    const me = req.session.gameName;
    const partners = Array.isArray(req.body.partners) ? req.body.partners : [];
    if (!me) return res.status(400).json({ error: 'No session identity' });

    const tx = db.transaction((list) => {
        const seen = new Set();
        for (const raw of list) {
            const partner = canonicalName(String(raw).trim());
            if (!partner || partner.toLowerCase() === me.toLowerCase()) continue;
            seen.add(partner.toLowerCase());
            const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            tradeRepo.markAgreementDoneByInitiator(pairKey(me, partner), a, b, me);
        }

        const stale = tradeRepo.getDoneAgreementsForPlayer(me).filter((row) => {
            const other = row.player_a.toLowerCase() === me.toLowerCase() ? row.player_b : row.player_a;
            return !seen.has(other.toLowerCase());
        });
        if (stale.length) tradeRepo.cancelAgreementsByIds(stale.map((row) => row.id));
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

    const tx = db.transaction((list) => {
        let n = 0;
        for (const pair of list) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const a = canonicalName(String(pair[0]).trim());
            const b = canonicalName(String(pair[1]).trim());
            if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
            const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            tradeRepo.markAgreementDoneByScan(pairKey(a, b), pa, pb);
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

// --- HOARD + ASTRO DOLLARS SYNC: both read off the logged-in member's /Game/Trade page ---
// Body: { hoarded_au: <number>, astro_dollars: <number> }. astro_dollars overwrites the
// same column the Alliance member-sheet scrape used to own — deliberately: this alliance
// wants that figure sourced from Trade (exact) rather than Alliance (coarser, and gated on
// someone opening a page nobody visits). See upsertTradeSync's own comment.
router.post('/sync/trade-inventory', requireAuth, (req, res) => {
    const me = req.session.gameName;
    if (!me) return res.status(400).json({ error: 'No session identity' });

    const n = parseInt(req.body.hoarded_au, 10);
    const hoardedAu = isNaN(n) ? 0 : Math.max(0, n);
    // astro_dollars is optional so an old tab's cached bundle (still POSTing the
    // pre-2026-09-20 { hoarded_au } shape right after a deploy, before it reloads itself —
    // see version-watch.js) updates the hoard without zeroing out a real astro_dollars
    // balance it never sent.
    const hasAstroDollars = req.body.astro_dollars !== undefined;
    const a = parseFloat(req.body.astro_dollars);
    const astroDollars = isNaN(a) ? 0 : Math.max(0, a);

    try {
        const row = playersRepo.getPlayerIdByName(me);
        if (!row) return res.json({ success: true, stored: false });
        if (hasAstroDollars) alliancesRepo.upsertTradeSync(row.id, hoardedAu, astroDollars);
        else alliancesRepo.upsertHoardedAu(row.id, hoardedAu);
        res.json({ success: true, stored: true });
    } catch (e) {
        console.error('[DB Error] sync trade-inventory:', e);
        res.status(500).json({ error: 'Failed to sync inventory' });
    }
});

module.exports = router;
