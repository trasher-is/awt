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

module.exports = { requireAuth, requireAdmin };
