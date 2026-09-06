// Keeping a session honest about the account behind it.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// A session used to be a snapshot: userId, role and gameName were copied out of app_users
// at login and never looked at again, for up to the thirty days the cookie lives. Every
// gate downstream — requireAuth, requireAdmin, blockGuestWrites, the /api/v1 chain, the
// game proxy — read that snapshot. So:
//
//   • deactivating or deleting an account did nothing to its open sessions;
//   • demoting an admin to guest left them an admin on every device they were logged in on;
//   • resetting a password left every existing login usable.
//
// Reproduced with the real middleware on a synthetic database (issue #127): an admin
// session, the account set to role=guest and is_active=0, and requireAuth, requireAdmin
// and blockGuestWrites all still called next().
//
// ─── WHAT THIS DOES ───────────────────────────────────────────────────────────
// One middleware, mounted ONCE in server.js directly after express-session, in front of
// everything that reads req.session. For a request carrying a logged-in session it loads
// the account row and:
//
//   • destroys the session when the account is gone, inactive, or its session_version no
//     longer matches the one recorded at login (a password reset bumps it). The request
//     then continues WITHOUT a session, so the existing gates answer exactly as they do
//     for an anonymous caller — 401 JSON under /hub-api, a redirect to the login page for
//     a document. Nothing downstream has to learn a new case.
//   • otherwise refreshes role and gameName from the row, so a role change applies to the
//     very next request on every device.
//
// A session created before session_version existed carries no copy of it and is read as
// 0, which is the column default: deploying this logs nobody out. A session is only ever
// rejected because of something an admin did on purpose.
//
// If the account lookup itself fails (database locked, disk error) the request is
// answered 503 and the session is LEFT ALONE: failing open would defeat the point, and
// failing by logging everyone out would turn a transient fault into a support incident.

// express-session is mounted in server.js without a `name`, so it uses the library
// default. Cleared explicitly on revocation so the browser stops sending a dead id.
const HUB_SESSION_COOKIE = 'connect.sid';

function sessionVersionOf(session) {
    const v = Number(session.sessionVersion);
    return Number.isFinite(v) ? v : 0;
}

// null when the session may continue; otherwise a short reason for the log.
function revocationReason(session, account) {
    if (!account) return 'account no longer exists';
    if (Number(account.is_active) === 0) return 'account deactivated';
    if (sessionVersionOf(session) !== Number(account.session_version || 0)) return 'password was reset';
    return null;
}

/**
 * @param {object} options
 * @param {(userId: number) => ({id, game_name, role, is_active, session_version}|undefined)} options.loadAccount
 * @param {{warn: Function, error: Function}} [options.log]
 * @param {string} [options.cookieName]
 */
function sessionAccountGuard({ loadAccount, log = console, cookieName = HUB_SESSION_COOKIE } = {}) {
    if (typeof loadAccount !== 'function') {
        throw new TypeError('sessionAccountGuard needs a loadAccount(userId) function');
    }

    return function sessionAccount(req, res, next) {
        const session = req.session;
        if (!session || session.userId == null) return next();

        let account;
        try {
            account = loadAccount(session.userId);
        } catch (err) {
            log.error('[Auth] Could not verify the account behind a session:', err.message);
            return res.status(503).json({ error: 'Account check unavailable — try again shortly' });
        }

        const reason = revocationReason(session, account);
        if (reason) {
            log.warn(`[Auth] Session revoked for user #${session.userId}: ${reason}.`);
            return session.destroy(err => {
                if (err) log.error('[Auth] Could not destroy a revoked session:', err.message);
                if (typeof res.clearCookie === 'function') res.clearCookie(cookieName);
                next();
            });
        }

        // The row is the truth; the session is a cache of it. Only write when something
        // changed, so express-session does not persist an unmodified session on every hit.
        if (session.role !== account.role) session.role = account.role;
        if (session.gameName !== account.game_name) session.gameName = account.game_name;
        next();
    };
}

module.exports = { sessionAccountGuard, revocationReason, sessionVersionOf, HUB_SESSION_COOKIE };
