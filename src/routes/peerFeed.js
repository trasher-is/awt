// /peer-api/v1/* — what a partner hub reads from us. No session: the caller is another
// hub, identified only by the bearer token we issued it in Admin -> Peer Sharing.
//
// Mounted in server.js ahead of sessions and the game proxy. GET only, nothing here
// writes anything except the link's own "last read" counter.
const express = require('express');
const peersRepo = require('../repositories/peers');
const { buildFeedPage } = require('../utils/peer-feed');
const { KIND_NAMES } = require('../utils/peer-kinds');

const router = express.Router();

function bearer(req) {
    const h = req.get('authorization') || '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m ? m[1] : null;
}

// Same answer for "no token", "wrong token" and "revoked": nothing about which links exist
// is disclosed to someone who does not hold one.
function requireLink(req, res, next) {
    const link = peersRepo.findEnabledLinkByToken(bearer(req));
    if (!link) return res.status(401).json({ error: 'Unknown or revoked peer token' });
    req.peerLink = link;
    next();
}

router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// What this token may read, so the partner asks only for that.
router.get('/v1/hello', requireLink, (req, res) => {
    peersRepo.touchLink(req.peerLink.id);
    res.json({ v: 1, kinds: req.peerLink.scopes.filter(k => KIND_NAMES.includes(k)) });
});

router.get('/v1/feed', requireLink, (req, res) => {
    try {
        const page = buildFeedPage(req.peerLink, String(req.query.kind || ''), {
            after: req.query.after ? String(req.query.after) : '',
            limit: req.query.limit,
        });
        res.json(page);
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[Peers] Feed failed:', err.message);
        res.status(500).json({ error: 'Feed failed' });
    }
});

module.exports = router;
