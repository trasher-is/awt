const express = require('express');
const { requireAuth, requireWriteRole } = require('./_middleware');
const battleRace = require('../repositories/battleRace');

const router = express.Router();
const endpoint = '/intel/player/:id/battle-race-inference';

function playerId(req, res, next) {
    const id = req.params.id;
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
        return res.status(400).json({ success: false, error: 'Invalid player ID.' });
    }
    req.battleRacePlayerId = Number(id);
    res.set('Cache-Control', 'no-store');
    next();
}

router.get(endpoint, requireAuth, playerId, (req, res) => {
    try {
        const result = battleRace.getBattleRace(req.battleRacePlayerId);
        if (!result) return res.status(404).json({ success: false, error: 'Player not found.' });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[DB Error] Failed to read battle race analysis:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load battle race analysis.' });
    }
});

router.post(endpoint, requireAuth, requireWriteRole, playerId, (req, res) => {
    // Only the server's stored reports are evidence. Ignore supplied candidates and
    // player stats; a browser must never be able to label its own guess as our analysis.
    try {
        const target = new URL(process.env.TARGET_URL || 'https://astrowars.games');
        const universe = target.hostname.startsWith('redzone.') ? 'redzone' : 'standard';
        const result = battleRace.updateBattleRace(req.battleRacePlayerId, { universe });
        if (result.status === 'not_found') return res.status(404).json({ success: false, error: 'Player not found.' });
        if (result.status === 'bio_locked') {
            return res.status(409).json({ success: false, has_bio: true, inference: null,
                error: 'Bio intelligence is already recorded. Battle analysis cannot replace it.' });
        }
        res.json({ success: true, has_bio: false, inference: result.inference });
    } catch (err) {
        console.error('[DB Error] Failed to update battle race analysis:', err.message);
        res.status(500).json({ success: false, error: 'Failed to update battle race analysis.' });
    }
});

module.exports = router;
