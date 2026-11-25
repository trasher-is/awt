const express = require('express');
const { requireAuth, requireWriteRole } = require('./_middleware');
const knownNames = require('../repositories/knownNames');
const playersRepo = require('../repositories/players');

const router = express.Router();
const MAX_NAME = 50;

function readId(value) {
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function playerId(req, res, next) {
    req.knownNamePlayerId = readId(req.params.id);
    if (req.knownNamePlayerId === null) return res.status(400).json({ error: 'Invalid player ID.' });
    res.set('Cache-Control', 'no-store');
    next();
}

// A member may take back what they entered; an admin may remove any.
const mayRemove = (req, row) => req.session.role === 'admin' || row.added_by_user_id === req.session.userId;

const listFor = req => knownNames.listKnownNames(req.knownNamePlayerId).map(row => ({
    id: row.id, name: row.name, addedBy: row.added_by, createdAt: row.created_at,
    canRemove: mayRemove(req, row),
}));

router.get('/intel/player/:id/known-names', requireAuth, playerId, (req, res) => {
    try {
        res.json({ success: true, names: listFor(req) });
    } catch (err) {
        console.error('[DB Error] Failed to read known names:', err.message);
        res.status(500).json({ error: 'Failed to load known names.' });
    }
});

router.post('/intel/player/:id/known-names', requireAuth, requireWriteRole, playerId, (req, res) => {
    const raw = req.body && req.body.name;
    // Control characters and runs of spaces come from pasting, and would hide a duplicate.
    const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    if (name.length > MAX_NAME) return res.status(400).json({ error: `A name can be at most ${MAX_NAME} characters.` });
    try {
        if (!playersRepo.getPlayerName(req.knownNamePlayerId)) return res.status(404).json({ error: 'No such player on record.' });
        const added = knownNames.addKnownName(req.knownNamePlayerId, name,
            { id: req.session.userId, gameName: req.session.gameName || null });
        if (!added) return res.status(409).json({ error: `${name} is already on the list.` });
        res.json({ success: true, names: listFor(req) });
    } catch (err) {
        console.error('[DB Error] Failed to save known name:', err.message);
        res.status(500).json({ error: 'Failed to save the name.' });
    }
});

router.delete('/intel/player/:id/known-names/:nameId', requireAuth, requireWriteRole, playerId, (req, res) => {
    const nameId = readId(req.params.nameId);
    if (nameId === null) return res.status(400).json({ error: 'Invalid name ID.' });
    try {
        const row = knownNames.getKnownName(req.knownNamePlayerId, nameId);
        if (!row) return res.status(404).json({ error: 'That name is no longer on the list.' });
        if (!mayRemove(req, row)) return res.status(403).json({ error: 'Only the member who entered a name, or an admin, can remove it.' });
        knownNames.deleteKnownName(req.knownNamePlayerId, nameId);
        res.json({ success: true, names: listFor(req) });
    } catch (err) {
        console.error('[DB Error] Failed to remove known name:', err.message);
        res.status(500).json({ error: 'Failed to remove the name.' });
    }
});

module.exports = router;
