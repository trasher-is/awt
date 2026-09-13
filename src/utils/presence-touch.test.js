// presence-touch: marks an app_user "using AWT right now" on every request carrying a
// session sessionAccountGuard has already confirmed live.
//
// Run with:  node src/utils/presence-touch.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-presence-touch-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
delete process.env.DISCORD_TOKEN;

const express = require('express');
const session = require('express-session');

const db = require('../database');
const usersRepo = require('../repositories/users');
const apiRoutes = require('../routes/api');
const { hubBody } = require('./hub-body');
const { sessionAccountGuard } = require('./session-account');
const { presenceTouch } = require('./presence-touch');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const quiet = { warn() {}, error() {} };

// ─── THE MIDDLEWARE ALONE ──────────────────────────────────────────────────────
function drive(mw, sess) {
    const out = { nexted: false };
    mw({ session: sess }, {}, () => { out.nexted = true; });
    return out;
}

let threw = false;
try { presenceTouch({}); } catch (e) { threw = true; }
ok('building it without a touchLastSeen function is a programming error', threw);

let calledWith = null;
let mw = presenceTouch({ touchLastSeen: id => { calledWith = id; } });
ok('a logged-in session is touched with its userId',
    drive(mw, { userId: 42 }).nexted && calledWith === 42, calledWith);

calledWith = 'untouched';
ok('an anonymous session is left alone', drive(mw, {}).nexted && calledWith === 'untouched');
ok('no session object at all is left alone', drive(mw, undefined).nexted && calledWith === 'untouched');

mw = presenceTouch({ touchLastSeen: () => { throw new Error('db locked'); }, log: quiet });
ok('a failing touch never blocks the request', drive(mw, { userId: 1 }).nexted);

// ─── WIRED INTO A REAL APP, LIKE server.js ─────────────────────────────────────
const app = express();
app.use(session({ secret: 'test-only-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: false } }));
app.use(sessionAccountGuard({ loadAccount: usersRepo.getSessionAccountById, log: quiet }));
app.use(presenceTouch({ touchLastSeen: usersRepo.touchUserLastSeen, log: quiet }));
app.use('/hub-api', hubBody({ syncLimit: '1mb', limit: '256kb' }));
app.use('/hub-api', apiRoutes);

function request(cookieJar, method, urlPath) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (cookieJar.cookie) headers.Cookie = cookieJar.cookie;
        const req = http.request({ hostname: '127.0.0.1', port: cookieJar.port, method, path: urlPath, headers }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                const setCookie = res.headers['set-cookie'];
                if (setCookie && setCookie.length) cookieJar.cookie = setCookie[0].split(';')[0];
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* not JSON */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;

    const bcrypt = require('bcryptjs');
    usersRepo.createUser('Presencer', bcrypt.hashSync('pw-1234567', 4), 'user', null);
    const userId = usersRepo.getUserByGameName('Presencer').id;

    try {
        const jar = { port, cookie: null };
        const beforeLogin = usersRepo.getUserPresence().find(u => u.id === userId);
        ok('never seen before any request', beforeLogin && !beforeLogin.last_seen_at, beforeLogin);

        const login = new Promise((resolve, reject) => {
            const payload = JSON.stringify({ game_name: 'Presencer', password: 'pw-1234567' });
            const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/hub-api/login', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
                let raw = '';
                res.on('data', c => { raw += c; });
                res.on('end', () => {
                    const setCookie = res.headers['set-cookie'];
                    if (setCookie && setCookie.length) jar.cookie = setCookie[0].split(';')[0];
                    resolve({ status: res.statusCode });
                });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
        const loginResult = await login;
        ok('logs in', loginResult.status === 200, loginResult);

        // Login itself isn't touched — req.session.userId is only set partway through that
        // request's handler, after presenceTouch has already run for it. The very next
        // request from the same browser carries the session from the start, and IS touched.
        const afterLogin = usersRepo.getUserPresence().find(u => u.id === userId);
        ok('login alone does not yet set last_seen_at', afterLogin && !afterLogin.last_seen_at, afterLogin);

        // Force it stale, then prove an ordinary authenticated GET refreshes it.
        db.prepare(`UPDATE app_users SET last_seen_at = datetime('now', '-1 hour') WHERE id = ?`).run(userId);
        const r = await request(jar, 'GET', '/hub-api/me');
        ok('an authenticated request succeeds', r.status === 200, r);
        const afterGet = usersRepo.getUserPresence().find(u => u.id === userId);
        ok('...and refreshes last_seen_at',
            afterGet && Date.now() - new Date(afterGet.last_seen_at.replace(' ', 'T') + 'Z').getTime() < 60000, afterGet);

        const presenceRes = await request(jar, 'GET', '/hub-api/users/presence');
        ok('GET /hub-api/users/presence lists the account', presenceRes.status === 200
            && presenceRes.body.success === true
            && presenceRes.body.users.some(u => u.game_name === 'Presencer'), presenceRes.body);

        const anonRes = await request({ port, cookie: null }, 'GET', '/hub-api/users/presence');
        ok('...and requires a session like any other hub-api route', anonRes.status === 401, anonRes);
    } finally {
        server.close();
    }

    // ─── IT IS ACTUALLY MOUNTED, AFTER THE GUARD ───────────────────────────────
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const guardMount = serverSrc.indexOf('app.use(sessionAccountGuard(');
    const presenceMount = serverSrc.indexOf('app.use(presenceTouch(');
    ok('server.js mounts presenceTouch', presenceMount !== -1);
    ok('...after the session-account guard', guardMount !== -1 && presenceMount > guardMount, [guardMount, presenceMount]);
    ok('...wired to the real repository', /presenceTouch\(\{ touchLastSeen: usersRepo\.touchUserLastSeen \}\)/.test(serverSrc));

    db.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
