require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const db = require('./src/database'); 
const apiRoutes = require('./src/routes/api');
const proxyMiddleware = require('./src/proxy');

const app = express();
const PORT = process.env.PORT || 3000;

const { initDiscordBot } = require('./src/discord_bot');

// --- 1. SESSIONS & SECURITY ---
app.use(session({
    store: new SQLiteStore({ db: 'awt.db', dir: '.' }), // Saves sessions into your existing database file
    secret: process.env.SESSION_SECRET || 'alliance_super_secret_key_change_in_production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true } // Cookies last for 30 days
}));

// 🔴 FIX: Removed global express.json() from here so it doesn't eat the proxy's POST streams!

app.use('/hub-assets', express.static(path.join(__dirname, 'public')));

// 🔴 FIX: Attached the JSON parser strictly to OUR api routes only.
app.use('/hub-api', express.json({ limit: '50mb' }), apiRoutes);

// --- 3. AUTHENTICATION FIREWALL ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    res.redirect('/hub-assets/login.html'); 
};

// --- 4. PROTECTED ROUTES ---
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Wrapper.html'));
});

app.get('/admin', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'Admin.html'));
});

// Force all direct browser navigation into the Wrapper g
app.use('/', requireAuth, (req, res, next) => {
    // If the browser is requesting a full page document directly (not an iframe or fetch request)
    if (req.headers['sec-fetch-dest'] === 'document') {
        
        // Ignore our actual hub tool routes so we don't cause an infinite redirect loop
        if (req.path !== '/dashboard' && !req.path.startsWith('/admin')) {
            
            console.log(`[Core] Trapped direct navigation to ${req.originalUrl}. Redirecting to Wrapper...`);
            // Wrap the requested game URL inside the dashboard's URL parameter
            return res.redirect(`/dashboard?p=${encodeURIComponent(req.originalUrl)}`);
        }
    }
    next(); // Pass control to the proxy
}, proxyMiddleware);

app.listen(PORT, () => {
    console.log(`[Core] Alliance Intelligence Hub v2 online on port ${PORT}`);
});

initDiscordBot(process.env.DISCORD_TOKEN);