const path = require('path');
// Load .env from next to this file, NOT from process.cwd(). Under pm2 the working
// directory can differ from the project root, which makes a bare config() read the
// wrong (or no) .env and silently inject 0 vars. Anchoring to __dirname fixes that.
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const db = require('./src/database');
const apiRoutes = require('./src/routes/api');
const proxyMiddleware = require('./src/proxy');
const redzoneProxy = require('./src/redzone-proxy');

const app = express();
const PORT = process.env.PORT || 3000;

const { initDiscordBot } = require('./src/discord_bot');

const fs = require('fs');
const crypto = require('crypto');
const { rateLimit } = require('./src/utils/rate-limit');

// Behind a TLS terminator every request arrives from the same socket address. Without
// this, req.ip is the proxy for everyone — the rate limiters below would throttle all
// users as a single bucket, and `cookie.secure` would never be satisfied.
// Set TRUST_PROXY=0 when the app is exposed directly on the public port.
const trustProxySetting = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', /^(0|false|off)$/i.test(trustProxySetting) ? false : Number(trustProxySetting) || 1);

// Session secret. Prefer the env var; if it is missing, generate one and persist it
// next to this file rather than falling back to a constant — a constant committed to
// git lets anyone who reads the repo forge a signed session cookie. Persisting instead
// of generating per boot keeps existing logins valid across restarts.
function resolveSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

    const secretFile = path.join(__dirname, '.session-secret');
    try {
        if (fs.existsSync(secretFile)) {
            const existing = fs.readFileSync(secretFile, 'utf8').trim();
            if (existing) return existing;
        }
        const generated = crypto.randomBytes(48).toString('hex');
        fs.writeFileSync(secretFile, generated, { mode: 0o600 });
        console.warn('[Core] SESSION_SECRET is not set — generated one in .session-secret. Set SESSION_SECRET in .env to control it.');
        return generated;
    } catch (err) {
        // Read-only filesystem or similar. Fail loudly instead of silently falling back
        // to a guessable value.
        throw new Error(`SESSION_SECRET is not set and .session-secret could not be created: ${err.message}`);
    }
}

// The redzone proxy is open to the internet by design, so a flood there costs us
// bandwidth and reputation with the upstream game. The ceiling is deliberately high —
// a single game page pulls dozens of assets. RZ_PROXY_MAX=0 disables it.
const rzProxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: process.env.RZ_PROXY_MAX === undefined ? 900 : Number(process.env.RZ_PROXY_MAX)
});

// --- REDZONE SUBDOMAIN (rz.<host>) ---
// First middleware of all: anything arriving on the rz.* subdomain is an open, login-free
// reverse proxy to redzone.astrowars.games (see src/redzone-proxy.js). Handled before
// sessions/static/auth so redzone traffic never touches the awt session or the astrowars
// proxy — the two games stay fully separated by hostname. The injected QoL script loads by
// absolute URL from the main host, so its request lands on the normal (non-rz) stack below.
//
// EXCEPTION: /rzhub/* is NOT proxied — it's the awt-served backend for the shared system
// planner (password-gated). Leaving it same-origin with the rz pages keeps the unlock
// cookie first-party. It's mounted just below and reachable regardless of host.
app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (host.startsWith('rz.') && !req.path.startsWith('/rzhub/')) {
        return rzProxyLimiter(req, res, () => redzoneProxy(req, res, next));
    }
    next();
});

// Throttle guesses at the shared planner password. Only the login endpoint is limited;
// the note read/write calls behind it are normal app traffic.
app.use('/rzhub/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.RZ_LOGIN_MAX === undefined ? 20 : Number(process.env.RZ_LOGIN_MAX)
}));

app.use('/rzhub', express.json(), require('./src/routes/rzhub'));

// NOTE: the pm2 log viewer used to live here as GET /api/admin/logs, registered above
// the session middleware — so req.session did not exist and it served the tail of the
// server log to anyone who asked. Nothing called it either: the admin panel fetches
// /hub-api/admin/logs. It now lives in src/routes/admin.js behind requireAdmin.

// --- 1. SESSIONS & SECURITY ---
// Cookies are sent over HTTPS in production. Plain-HTTP local dev would never receive
// them back with Secure set, so it is opt-out via COOKIE_SECURE=false / NODE_ENV.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV !== 'development';

app.use(session({
    // `dir` must be absolute for the same reason .env is loaded from __dirname above:
    // under pm2 the working directory can differ from the project root, and a relative
    // '.' would then point the session store at a different awt.db than the one the
    // rest of the app uses — logging everyone out with no obvious cause.
    store: new SQLiteStore({ db: 'awt.db', dir: __dirname }),
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // Cookies last for 30 days
        httpOnly: true,
        sameSite: 'lax',
        secure: COOKIE_SECURE
    }
}));

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

app.use('/hub-assets', express.static(path.join(__dirname, 'public')));

// 🔴 FIX: Attached the JSON parser strictly to OUR api routes only.
// Galaxy and system syncs legitimately post megabytes of scraped rows; nothing else
// does. The 50 MB ceiling is therefore scoped to /sync/*, and every other hub endpoint
// gets a sane 2 MB so one logged-in account cannot tie up the process with a huge body.
const syncJson = express.json({ limit: '50mb' });
const hubJson = express.json({ limit: '2mb' });
app.use('/hub-api', (req, res, next) => (req.path.startsWith('/sync') ? syncJson : hubJson)(req, res, next));

// Brute-force guard on the hub login: loose enough that a forgetful member is not
// locked out, tight enough that guessing a password over the network is hopeless.
app.use('/hub-api/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.LOGIN_MAX === undefined ? 15 : Number(process.env.LOGIN_MAX)
}));

app.use('/hub-api', apiRoutes);

// External game-notification webhook (no session auth — called by the in-game forwarder).
// Rate-limited because it is reachable by anyone and each call runs several joins plus a
// travel-time calculation per candidate fleet.
app.use('/api/game-notifications', rateLimit({
    windowMs: 60 * 1000,
    max: process.env.WEBHOOK_MAX === undefined ? 30 : Number(process.env.WEBHOOK_MAX)
}));
app.use('/api', express.json({ limit: '5mb' }), require('./src/routes/webhook'));

// --- 3. AUTHENTICATION FIREWALL ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    res.redirect('/hub-assets/login.html'); 
};

// Short shareable shortcut: /rz -> the redzone subdomain (the actual open proxy). No
// auth — it's just a redirect to a public entry point.
app.get('/rz', (req, res) => res.redirect(process.env.RZ_PUBLIC_URL || 'https://rz.37.27.17.97.nip.io/'));

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

const server = app.listen(PORT, () => {
    console.log(`[Core] Alliance Intelligence Hub v2 online on port ${PORT}`);
});

initDiscordBot(process.env.DISCORD_TOKEN);

// pm2 sends SIGINT/SIGTERM on restart and deploy. Stop accepting connections and close
// the database handle so a WAL write is not cut off mid-transaction.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[Core] ${signal} received — shutting down.`);
        server.close(() => {
            try { db.close(); } catch (err) { console.error('[Core] DB close failed:', err.message); }
            process.exit(0);
        });
        // A hung keep-alive connection must not block the restart forever.
        setTimeout(() => process.exit(0), 5000).unref();
    });
}