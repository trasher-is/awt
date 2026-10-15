// The hub's express-session options, in one place so a test can boot exactly what
// server.js mounts.
//
// ─── WHY rolling ──────────────────────────────────────────────────────────────
// The cookie used to be sent only when the session was created or its data changed. On
// every request express-session pushed the STORE's expiry thirty days forward (store.touch),
// but without `rolling` it never re-sent the cookie — and session data almost never changes
// after login. So the server kept a session alive while the browser threw its cookie away
// exactly thirty days after login, however active the member was.
//
// Seen in production on 14 Oct 2026: a member was active at 20:07:50, their cookie expired
// at 20:08:45 (thirty days after that login), and they were dropped mid-session while
// sessions.db still held the row with eleven days to go. Earlier cases were in the same store.
//
// `rolling: true` re-sends the cookie with a fresh thirty days on every response that
// carries a session, so "thirty days" now means thirty days of inactivity — which is what
// the store was already enforcing. saveUninitialized stays false, so anonymous visitors
// still get no cookie at all.

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function hubSessionOptions({ store, secret, secure }) {
    return {
        store,
        secret,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            maxAge: SESSION_MAX_AGE_MS,
            httpOnly: true,
            sameSite: 'lax',
            secure
        }
    };
}

module.exports = { hubSessionOptions, SESSION_MAX_AGE_MS };
