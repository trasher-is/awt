// --- SHARED ROUTE MIDDLEWARE ---

// MIDDLEWARE: AUTH CHECK
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'Unauthorized: Please log in' });
};

// MIDDLEWARE: ADMIN CHECK
// Put this in front of any route that only admins should touch
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.role === 'admin') return next();
    return res.status(403).json({ error: 'Unauthorized: Admins only' });
};

// --- GUEST ROLE ---
// The admin panel has offered 'guest' as a role since the beginning, and nothing has ever
// checked it. requireAuth and requireAdmin were the only gates, so a guest account had
// exactly the same write access as a full member: it could sync scraped data, delete
// other people's plans, edit the takeover board and propose trades.
//
// The gate is applied ONCE at the /hub-api mount rather than route by route. Two reasons:
// a per-route sprinkle across five files is easy to forget on the next new endpoint, and
// a single choke point is auditable in one place. The rule is the HTTP verb: guests get
// every GET, and nothing that mutates.
const ROLES_THAT_MAY_WRITE = new Set(['user', 'admin']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A few POSTs are reads wearing a POST because they take a body. They stay open to
// guests. Anything not listed here is treated as a write — the safe default when someone
// adds an endpoint and forgets this file exists.
const SAFE_POST_PATHS = new Set([
    '/login',              // no session yet; the login handler does its own checking
    '/logout',             // ending your own session is never a privileged act
    '/routes/preview',     // computes travel legs, stores nothing
    '/incoming/defenders', // computes who could intercept, stores nothing
]);

function isGuest(req) {
    return !!(req.session && req.session.role && !ROLES_THAT_MAY_WRITE.has(req.session.role));
}

const blockGuestWrites = (req, res, next) => {
    if (READ_ONLY_METHODS.has(req.method)) return next();
    if (SAFE_POST_PATHS.has(req.path)) return next();
    if (!isGuest(req)) return next();
    return res.status(403).json({
        error: 'Read-only account: guests can view alliance data but cannot change it.'
    });
};

// For the rare case where a specific route wants the check inline as well.
const requireWriteRole = (req, res, next) => {
    if (!isGuest(req)) return next();
    return res.status(403).json({
        error: 'Read-only account: guests can view alliance data but cannot change it.'
    });
};

module.exports = {
    requireAuth, requireAdmin, blockGuestWrites, requireWriteRole,
    ROLES_THAT_MAY_WRITE, SAFE_POST_PATHS, isGuest
};
