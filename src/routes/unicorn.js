const express = require('express');
const { requireAuth } = require('./_middleware');
const unicornRepo = require('../repositories/unicorn');
const router = express.Router();

// Read-only like the other intel endpoints, including for authenticated guests. The
// browser controls the temporary mode; this endpoint only reads already captured data.
router.get('/intel/unicorn', requireAuth, (req, res) => {
    try {
        res.json({ success: true, ...unicornRepo.getUnicornIntel() });
    } catch (err) {
        console.error('[DB Error] Failed to load unicorn intel:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load unicorn intel' });
    }
});

module.exports = router;
