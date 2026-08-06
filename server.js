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
const { gameTrafficGate } = require('./src/utils/game-traffic');
const { hubBody } = require('./src/utils/hub-body');
const { splitSessionsDatabase } = require('./src/utils/session-store');

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
    const awtOwned = req.path.startsWith('/rzhub/') || req.path === '/ta';
    if (host.startsWith('rz.') && !awtOwned) {
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

// Redzone trade-agreement planner page (self-contained). Carved out of the rz proxy
// above; open, like the rest of the rz tooling.
app.get('/ta', (req, res) => res.sendFile(path.join(__dirname, 'public', 'rz-ta.html')));
// NOTE: the pm2 log viewer used to live here as GET /api/admin/logs, registered above
// the session middleware — so req.session did not exist and it served the tail of the
// server log to anyone who asked. Nothing called it either: the admin panel fetches
// /hub-api/admin/logs. It now lives in src/routes/admin.js behind requireAdmin.

// --- 1. SESSIONS & SECURITY ---
// Session cookie Secure flag. Default 'auto': express-session sets Secure only when
// Express believes the request arrived over TLS (req.secure), which behind a proxy means
// `trust proxy` is on AND the proxy sent X-Forwarded-Proto.
//
// This used to default to a hard `true`, which failed in the worst possible way: if the
// reverse proxy did not send X-Forwarded-Proto, Express saw the proxy->app hop as plain
// HTTP, express-session silently refused to set a Secure cookie, and EVERY login failed
// with no error anywhere. Anyone already holding a cookie stayed logged in, so it looked
// like "after logging out nobody can log back in" — see checkProxyHeaders() below, which
// now names the missing header instead of leaving people to guess.
//
// 'auto' keeps the Secure flag whenever TLS is detectable and degrades to a working
// (non-Secure) cookie when it is not, so a self-hosted instance behind a misconfigured
// proxy is usable rather than locked out. COOKIE_SECURE=true forces it on regardless
// (correct once the header is in place), COOKIE_SECURE=false forces it off.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === 'true'
    : 'auto';

// Sessions used to live in awt.db alongside the intel. A galaxy sync writes thousands of
// rows in one transaction and holds the write lock for its duration, and connect-sqlite3
// offers no busy-timeout option — so session writes in that window failed outright:
//
//   Error: SQLITE_BUSY: database is locked      (node-sqlite3's wording, i.e. the store,
//                                                not our better-sqlite3 connection, which
//                                                already waits up to 10s)
//
// which means a member's login silently did not persist. Own file, own write lock. The
// split copies existing sessions across once so nobody is logged out by the change.
const sessionSplit = splitSessionsDatabase(path.join(__dirname, 'awt.db'), path.join(__dirname, 'sessions.db'));
if (sessionSplit.action === 'split') {
    console.log(`[Core] Moved ${sessionSplit.copied} sessions out of awt.db into sessions.db.`);
} else if (sessionSplit.error) {
    console.warn(`[Core] Session split skipped (${sessionSplit.action}): ${sessionSplit.error}. Everyone will need to log in again.`);
}

app.use(session({
    // `dir` must be absolute for the same reason .env is loaded from __dirname above:
    // under pm2 the working directory can differ from the project root, and a relative
    // '.' would then point the session store at a different file than the one the split
    // above wrote — logging everyone out with no obvious cause.
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
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

// Reverse-proxy sanity check, once, on the first real request. A proxy that terminates
// TLS but forwards neither X-Forwarded-Proto nor X-Forwarded-For leaves the app blind:
// session cookies lose their Secure flag and the rate limiters bucket everyone under the
// proxy's IP. Both are silent, so say it out loud with the fix attached.
const proxyCheck = { done: false };
function checkProxyHeaders(req) {
    if (proxyCheck.done) return;
    if (!app.get('trust proxy')) return;            // direct exposure: these headers are not expected
    if (req.headers['x-forwarded-proto']) { proxyCheck.done = true; return; }  // configured correctly

    // Do NOT judge by req.socket.remoteAddress: a reverse proxy on the same box connects
    // from 127.0.0.1, so treating loopback as "local traffic" would silence this warning in
    // precisely the deployment it exists to catch. Decide from the request instead — a
    // forwarded-for header, or a real hostname, both mean something is proxying us.
    const host = String(req.headers.host || '').toLowerCase();
    const looksLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    if (!req.headers['x-forwarded-for'] && looksLocal) return; // plain local dev, stay quiet

    proxyCheck.done = true;
    console.warn(
        '[Core] Reverse proxy is not sending X-Forwarded-Proto.\n' +
        '       Session cookies cannot be marked Secure, and TLS cannot be detected.\n' +
        '       nginx:  proxy_set_header X-Forwarded-Proto $scheme;   (then: nginx -t && systemctl reload nginx)\n' +
        '       Caddy/Traefik send it by default. Apache: ProxyPreserveHost On + RequestHeader set X-Forwarded-Proto https\n' +
        '       If the hub really is served over plain HTTP, set COOKIE_SECURE=false to silence this.'
    );
}
app.use((req, res, next) => { try { checkProxyHeaders(req); } catch (err) { /* never block a request */ } next(); });

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

app.use('/hub-assets', express.static(path.join(__dirname, 'public')));

// JSON parsing for our api routes only, with the size ceilings scoped to /sync/* — and
// the guarantee that req.body is an object by the time any handler sees it. See
// src/utils/hub-body.js: express.json() leaves req.body undefined whenever the
// Content-Type does not match, and nineteen handlers destructure it without a guard, so
// a POST with the wrong content type answered 500 with a stack trace in the body.
app.use('/hub-api', hubBody({ syncLimit: '50mb', limit: '2mb' }));

// Brute-force guard on the hub login: loose enough that a forgetful member is not
// locked out, tight enough that guessing a password over the network is hopeless.
app.use('/hub-api/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.LOGIN_MAX === undefined ? 15 : Number(process.env.LOGIN_MAX)
}));

// --- GAME TRAFFIC BUDGET ---
// Everything the scrapers fetch is a relative path on this origin, so every automated
// request to the game passes through this process. That makes the hub the only place the
// five-per-second agreement with the game's administrator can actually be enforced — the
// browser-side gate in public/js/utils/game-rate-limit.js is the first line, not the
// floor. See src/utils/game-traffic.js for what counts and why it waits rather than fails.
const gameGate = gameTrafficGate({
    maxPerSecond: process.env.GAME_MAX_PER_SECOND === undefined ? 5 : Number(process.env.GAME_MAX_PER_SECOND),
    maxWaitMs: process.env.GAME_MAX_WAIT_MS === undefined ? 8000 : Number(process.env.GAME_MAX_WAIT_MS),
});

// A ceiling on ALL proxied traffic, marked or not, per member. One game page pulls dozens
// of assets, so this is deliberately loose — it exists to stop a runaway loop that bypassed
// gameFetch entirely, not to shape normal browsing. PROXY_MAX=0 disables it.
const proxyCeiling = rateLimit({
    windowMs: 60 * 1000,
    max: process.env.PROXY_MAX === undefined ? 900 : Number(process.env.PROXY_MAX),
    message: 'Too many requests to the game from this account. Slow down and try again shortly.',
    keyOf: req => (req.session && req.session.userId ? `u${req.session.userId}` : null),
});

// Read-only view of what the gate has been doing — for the admin panel, and for the day
// someone asks us to show that the agreement is being kept. Registered before the /hub-api
// router so it is unambiguously this file's endpoint, not one of the domain routers'.
app.get('/hub-api/admin/game-traffic', (req, res) => {
    if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    res.json({ success: true, gate: gameGate.snapshot() });
});

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
app.use('/', requireAuth, proxyCeiling, gameGate, (req, res, next) => {
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
