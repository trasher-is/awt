const express = require('express');
const { requireAuth } = require('./_middleware');
const { raceDisplay } = require('../utils/race-display');
const router = express.Router();

router.get('/intel/player/:id/race-estimate', requireAuth, (req, res) => {
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
        return res.status(400).json({ success: false, error: 'Invalid player ID.' });
    }
    res.set('Cache-Control', 'no-store');
    try {
        const display = raceDisplay(Number(req.params.id), { role: req.session.role });
        if (!display) return res.status(404).json({ success: false, error: 'Player not found.' });
        res.json({ success: true, ...display });
    } catch (err) {
        console.error('[Race] display read failed:', err.message);
        res.status(500).json({ success: false, error: 'Could not load race evidence.' });
    }
});

module.exports = router;
