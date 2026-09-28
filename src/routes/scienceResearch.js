const express = require('express');
const usersRepo = require('../repositories/users');
const scienceResearchRepo = require('../repositories/scienceResearch');
const { buildQueue, schedule, SCIENCES } = require('../../public/js/utils/research-queue.js');
const { requireAuth } = require('./_middleware');
const router = express.Router();

// --- RESEARCH TRACKER (2026-09-28) ---
// A member's browser reports the raw rows of their own /Game/Science page (on a visit, and
// every 15 minutes in the background — research-watch.js). The order and the finish times
// are built here, against the server's clock, so every member's times share one clock.
//
// A member can only ever report their OWN research: the player is resolved from the
// session, never taken from the body.

router.post('/sync/science-research', requireAuth, (req, res) => {
    const { sciences, science_rate: scienceRate } = req.body || {};
    if (!Array.isArray(sciences) || sciences.length === 0 || sciences.length > 20) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    try {
        const bridge = usersRepo.getUserAllianceIdBridge(req.session.userId);
        if (!bridge || !bridge.player_id) {
            return res.status(404).json({ error: 'No player on record for this account yet.' });
        }
        const rows = sciences
            .filter(s => s && SCIENCES.includes(s.science) && Number.isInteger(s.level) && s.level >= 0 && s.level <= 1000)
            .map(s => ({
                science: s.science,
                level: s.level,
                active_seconds: s.active_seconds,
                queued: Array.isArray(s.queued) ? s.queued.slice(0, 10) : [],
            }));
        if (rows.length < 4) return res.status(400).json({ error: 'Too few sciences recognised' });

        const levels = {};
        rows.forEach(r => { if (levels[r.science] == null) levels[r.science] = r.level; });
        const observedAtMs = Date.now();
        const items = schedule(buildQueue(rows), observedAtMs);
        scienceResearchRepo.saveResearch(bridge.player_id, {
            observedAtMs,
            scienceRate: Number.isFinite(scienceRate) && scienceRate >= 0 ? scienceRate : null,
            levels,
            items,
        });
        res.json({ success: true, items: items.length });
    } catch (err) {
        console.error('[DB Error] Research sync failure:', err);
        res.status(500).json({ error: 'Database sync error' });
    }
});

module.exports = router;
