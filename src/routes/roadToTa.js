const express = require('express');
const { requireAuth } = require('./_middleware');
const roadToTa = require('../repositories/roadToTa');
const router = express.Router();

// Read-only planning input: observed alliance member data, no game traffic or writes.
router.get('/road-to-ta', requireAuth, (req, res) => {
    const requested = req.query.player_id;
    if (requested !== undefined && (typeof requested !== 'string' || !/^[1-9]\d*$/.test(requested)
        || !Number.isSafeInteger(Number(requested)))) {
        return res.status(400).json({ success: false, error: 'player_id must be a positive integer.' });
    }
    try {
        const players = roadToTa.getPlayers();
        const name = String(req.session.gameName || '').trim().toLowerCase();
        const me = players.find(player => player.name.toLowerCase() === name) || null;
        const selectedId = requested === undefined ? me?.id : Number(requested);
        const snapshot = selectedId === undefined ? null : roadToTa.getPlayerSnapshot(selectedId);
        if (requested !== undefined && !snapshot) {
            return res.status(404).json({ success: false, error: 'Player is not in the recorded alliance member roster.' });
        }
        res.json({ success: true, me, players, player: snapshot?.player ?? null,
            planets: snapshot?.planets ?? [], market: roadToTa.getMarket() });
    } catch (error) {
        console.error('[DB Error] Road to TA snapshot:', error);
        res.status(500).json({ success: false, error: 'Failed to load Road to TA data.' });
    }
});

module.exports = router;
