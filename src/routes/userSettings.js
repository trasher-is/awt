const express = require('express');
const { requireAuth } = require('./_middleware');
const usersRepo = require('../repositories/users');
const HubSettings = require('../../public/js/utils/hub-settings.js');
const router = express.Router();

// A member's own switches for the hub's extras and sidebar tools (the Settings panel).
//
// Per account, so a phone and a desktop agree. Only the choices that differ from the
// defaults are stored, and the keys, defaults and validation come from the same file the
// browser draws the panel from — public/js/utils/hub-settings.js — so the two cannot
// drift. Guests may use it: it only ever writes the caller's own row and no alliance data,
// which is why '/settings' is on SAFE_POST_PATHS in _middleware.js.

function answer(res, overrides) {
    res.json({ success: true, overrides, settings: HubSettings.resolve(overrides) });
}

router.get('/settings', requireAuth, (req, res) => {
    try {
        answer(res, HubSettings.parseStored(usersRepo.getUiSettings(req.session.userId)));
    } catch (err) {
        console.error('[Settings] load failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load settings' });
    }
});

// Body is either { changes: { "inject.suButtons": false, ... } } or { reset: true }.
// `changes` is merged into what is stored rather than replacing it, so a phone and a
// desktop changing different switches at the same moment do not wipe each other out.
router.post('/settings', requireAuth, (req, res) => {
    const body = req.body || {};
    let next;
    try {
        if (body.reset === true) {
            next = {};
        } else {
            const problem = HubSettings.invalidChanges(body.changes);
            if (problem) return res.status(400).json({ success: false, error: problem });
            next = HubSettings.applyChanges(HubSettings.parseStored(usersRepo.getUiSettings(req.session.userId)), body.changes);
        }
        const rows = usersRepo.setUiSettings(req.session.userId, Object.keys(next).length ? JSON.stringify(next) : null);
        // No row updated: the account is gone. Saying "saved" would be a lie.
        if (!rows) return res.status(404).json({ success: false, error: 'Account not found' });
        answer(res, next);
    } catch (err) {
        console.error('[Settings] save failed:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
});

module.exports = router;
