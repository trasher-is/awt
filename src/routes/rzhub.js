// Backend for the redzone (rz.*) system planner — a shared, communal per-planet planning
// note that everyone with the shared password can see and edit. Deliberately separate
// from the awt login/session (rz is its own open proxy): a single shared password unlocks
// a long-lived cookie, and that cookie gates read/write of the rz_plans table.
//
// Mounted at /rzhub on the rz subdomain (same-origin with the proxied game pages, so the
// cookie is first-party and reliable on mobile). See server.js host routing.
const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const router = express.Router();

// Shared password + the opaque token stored in the cookie once you've entered it. Low
// security stakes (it's game planning notes behind a password everyone on the team knows);
// the token just needs to be non-obvious so it can't be trivially forged by hand.
//
// Both now come from the environment. The literals below are kept only as defaults so
// this change does not invalidate anyone's existing unlock cookie — but they are public
// (they were committed to git), so set RZ_PASSWORD in .env to actually rotate. Once it
// is set the token is derived from it, meaning a password change also invalidates every
// cookie handed out under the old one.
const RZ_PASSWORD = process.env.RZ_PASSWORD || 'BigBadaNap';
const RZ_TOKEN = process.env.RZ_PASSWORD
    ? 'rzp_' + crypto.createHmac('sha256', process.env.RZ_PASSWORD).update('rzplans').digest('hex').slice(0, 32)
    : 'rzp_1f4c9a7e6b2d48f0a3c15e9d7b60community';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // ~1 year — "log in once"

// Constant-time compare so neither the password nor the cookie token can be recovered
// byte-by-byte from response timing.
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)rzplans=([^;]+)/);
    return !!m && safeEqual(m[1], RZ_TOKEN);
}

// POST /rzhub/login  { password } -> sets the unlock cookie
router.post('/login', (req, res) => {
    const pw = (req.body && req.body.password) || '';
    if (!safeEqual(pw, RZ_PASSWORD)) return res.status(403).json({ success: false, error: 'Wrong password' });
    res.setHeader('Set-Cookie', `rzplans=${RZ_TOKEN}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax; HttpOnly`);
    res.json({ success: true });
});

// GET /rzhub/plans?planetIds=8683,8685  -> { plans: { <planetId>: text, ... } }
// Returns only the requested planets (the page knows its own ids); all plans if none given.
router.get('/plans', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ success: false, error: 'Locked' });
    try {
        const ids = String(req.query.planetIds || '')
            .split(',').map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0);
        let rows;
        if (ids.length) {
            const ph = ids.map(() => '?').join(',');
            rows = db.prepare(`SELECT planet_id, text FROM rz_plans WHERE planet_id IN (${ph})`).all(...ids);
        } else {
            rows = db.prepare(`SELECT planet_id, text FROM rz_plans`).all();
        }
        const plans = {};
        rows.forEach(r => { plans[r.planet_id] = r.text; });
        res.json({ success: true, plans });
    } catch (err) {
        console.error('[rzhub] plans read failed:', err.message);
        res.status(500).json({ success: false, error: 'Read failed' });
    }
});

// POST /rzhub/plans  { planetId, text }  -> upsert (empty text deletes the note)
router.post('/plans', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ success: false, error: 'Locked' });
    try {
        const planetId = parseInt(req.body && req.body.planetId, 10);
        if (!Number.isInteger(planetId) || planetId <= 0) return res.status(400).json({ success: false, error: 'Bad planetId' });
        const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
        if (text) {
            db.prepare(`
                INSERT INTO rz_plans (planet_id, text) VALUES (?, ?)
                ON CONFLICT(planet_id) DO UPDATE SET text = excluded.text, updated_at = CURRENT_TIMESTAMP
            `).run(planetId, text);
        } else {
            db.prepare(`DELETE FROM rz_plans WHERE planet_id = ?`).run(planetId);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[rzhub] plan save failed:', err.message);
        res.status(500).json({ success: false, error: 'Save failed' });
    }
});

// --- SHARED TRADE-AGREEMENT MATRIX (redzone /ta page) ---
// Whole thing is one small JSON blob (an alliance is ~10-20 people) in app_settings,
// loaded and saved as a unit. Open (no password) — low-value planning data on an
// already-open proxy; can be moved behind isAuthed later if it ever gets griefed.
//   { players: [{ name, production }], done: ["a|b", ...] }  (done keys are sorted names)
router.get('/ta', (req, res) => {
    try {
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'rz_ta'`).get();
        const data = row && row.value ? JSON.parse(row.value) : { players: [], done: [] };
        res.json({ success: true, data });
    } catch (err) {
        console.error('[rzhub] TA load failed:', err.message);
        res.status(500).json({ success: false, error: 'Load failed' });
    }
});

router.post('/ta', (req, res) => {
    try {
        const data = req.body && req.body.data;
        if (!data || !Array.isArray(data.players)) {
            return res.status(400).json({ success: false, error: 'Bad payload' });
        }
        // Trades are stored as { "a|b": 'assigned' | 'done' }. Accept the legacy done[]
        // array too (folded in as 'done') so older saved blobs / clients still work.
        const trades = {};
        if (Array.isArray(data.done)) {
            data.done.forEach(k => { const key = String(k).slice(0, 90); if (key) trades[key] = 'done'; });
        }
        if (data.trades && typeof data.trades === 'object') {
            let n = 0;
            for (const [k, v] of Object.entries(data.trades)) {
                if (n++ > 20000) break;
                if (v === 'assigned' || v === 'done') { const key = String(k).slice(0, 90); if (key) trades[key] = v; }
            }
        }
        const clean = {
            players: data.players.slice(0, 100).map(p => ({
                name: String(p.name || '').trim().slice(0, 40),
                production: Math.max(0, parseInt(p.production, 10) || 0)
            })).filter(p => p.name),
            trades
        };
        db.prepare(`
            INSERT INTO app_settings (key, value, updated_at) VALUES ('rz_ta', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(JSON.stringify(clean));
        res.json({ success: true });
    } catch (err) {
        console.error('[rzhub] TA save failed:', err.message);
        res.status(500).json({ success: false, error: 'Save failed' });
    }
});

module.exports = router;
