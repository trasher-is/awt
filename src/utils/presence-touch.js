// "Is this account using AWT right now" — distinct from players.last_activity_at, which
// is the GAME's idea of activity (from the API/DOM) and says nothing about whether the
// tool itself is open. This is the tool's own signal: every request that carries a
// session sessionAccountGuard has already confirmed is live marks that account as seen.
//
// Mounted once, directly after sessionAccountGuard (server.js), so it only ever sees a
// session already known to be valid — a deactivated or revoked account never gets touched.
// The actual throttling (so a user clicking around isn't a DB write per request) lives in
// touchUserLastSeen itself (repositories/users.js), not here — keeps this middleware a
// one-line dispatch that's trivial to unit test without faking time.
function presenceTouch({ touchLastSeen, log = console } = {}) {
    if (typeof touchLastSeen !== 'function') {
        throw new TypeError('presenceTouch needs a touchLastSeen(userId) function');
    }
    return function touch(req, res, next) {
        if (req.session && req.session.userId != null) {
            try {
                touchLastSeen(req.session.userId);
            } catch (err) {
                log.error('[Presence] Could not record last-seen:', err.message);
            }
        }
        next();
    };
}

module.exports = { presenceTouch };
