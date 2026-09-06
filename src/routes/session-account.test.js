// Bans, role changes and password resets reach sessions that already exist.
//
// Run with:  node src/routes/session-account.test.js
//
// Before this (issue #127) a session was a snapshot of app_users taken at login and kept
// for the cookie's thirty days. Reproduced with the real middleware: an admin session,
// the account set to role=guest and is_active=0, and requireAuth, requireAdmin and
// blockGuestWrites all still called next().
//
// This boots the REAL routers (src/routes/api.js: guest gate + auth + admin + the rest),
// the REAL express-session, and the guard exactly as server.js mounts it, against a
// temporary synthetic database. Two or three independent cookie jars stand in for a
// member's devices; every account change goes through the real admin endpoints.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-session-account-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'master-admin-pw-1';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('../database');
const usersRepo = require('../repositories/users');
const apiRoutes = require('./api');
const { hubBody } = require('../utils/hub-body');
const { sessionAccountGuard, revocationReason, HUB_SESSION_COOKIE } = require('../utils/session-account');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const quiet = { warn() {}, error() {} };

// ─── THE APP, WIRED LIKE server.js ────────────────────────────────────────────
const app = express();
app.use(session({
    secret: 'test-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false },
}));
app.use(sessionAccountGuard({ loadAccount: usersRepo.getSessionAccountById, log: quiet }));

// The two "direct" admin endpoints in server.js read req.session.role themselves, without
// requireAdmin. Same shape here, so a demotion is proven to reach them too.
app.get('/hub-api/admin/api-traffic', (req, res) => {
    if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    res.json({ success: true });
});

app.use('/hub-api', hubBody({ syncLimit: '1mb', limit: '256kb' }));
app.use('/hub-api', apiRoutes);

// Stand-in for the game proxy chain: server.js's own requireAuth (redirect flavour) in
// front of "the proxy". What matters is that the guard already ran.
app.use('/game', (req, res) => {
    if (req.session && req.session.userId) return res.json({ proxied: true, as: req.session.gameName });
    res.redirect('/hub-assets/login.html');
});

// ─── A TINY HTTP CLIENT WITH COOKIE JARS ──────────────────────────────────────
let port;
function jar() { return { cookie: null, sids: [] }; }

function request(j, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (j.cookie) headers.Cookie = j.cookie;
        const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                const setCookie = res.headers['set-cookie'];
                if (setCookie && setCookie.length) {
                    const first = setCookie[0];
                    // An "Expires=Thu, 01 Jan 1970" cookie is a clear; anything else replaces the jar.
                    if (/Expires=Thu, 01 Jan 1970/.test(first)) j.cookie = null;
                    else {
                        j.cookie = first.split(';')[0];
                        j.sids.push(j.cookie);
                    }
                }
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* not JSON */ }
                resolve({ status: res.statusCode, body: parsed, location: res.headers.location, raw });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}
const get = (j, p) => request(j, 'GET', p);
const post = (j, p, b) => request(j, 'POST', p, b === undefined ? {} : b);
const del = (j, p) => request(j, 'DELETE', p);
const login = (j, game_name, password) => post(j, '/hub-api/login', { game_name, password });

function seedUser(name, pw, role) {
    usersRepo.createUser(name, bcrypt.hashSync(pw, 4), role, null);
    return usersRepo.getUserByGameName(name).id;
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    port = server.address().port;

    const adminId = usersRepo.getUserByGameName('admin').id;
    const aliceId = seedUser('Alice', 'alice-pw-12345', 'admin');
    const bobId = seedUser('Bob', 'bob-pw-12345', 'user');

    const master = jar(), master2 = jar(), alice = jar(), bob = jar(), bob2 = jar();

    try {
        console.log('── Login: a fresh, persisted session id every time ' + '─'.repeat(25));
        const anon = await get(jar(), '/hub-api/me');
        ok('anonymous /me is 401', anon.status === 401, anon.status);

        const badPw = await login(jar(), 'Bob', 'wrong-password');
        ok('a wrong password is 401', badPw.status === 401, badPw.status);
        const noPw = await login(jar(), 'Bob', undefined);
        ok('a missing password is 401, not a crash', noPw.status === 401, [noPw.status, noPw.body]);

        let r = await login(bob, 'Bob', 'bob-pw-12345');
        ok('Bob logs in', r.status === 200 && r.body.success === true, r.body);
        ok('and gets a session cookie', bob.cookie != null, bob.cookie);
        const firstSid = bob.cookie;
        r = await get(bob, '/hub-api/me');
        ok('the cookie is usable straight away (the session was saved before the answer)',
            r.status === 200 && r.body.id === bobId, r.body);

        // Log in AGAIN with the same cookie: the id must change, or a pre-authentication id
        // (planted, or captured) would become an authenticated one.
        r = await login(bob, 'Bob', 'bob-pw-12345');
        ok('logging in again regenerates the session id', bob.cookie !== firstSid, [firstSid, bob.cookie]);
        r = await get(bob, '/hub-api/me');
        ok('...and the new id works', r.status === 200 && r.body.id === bobId, r.body);

        r = await login(bob2, 'Bob', 'bob-pw-12345');
        ok('a second device logs Bob in independently', r.status === 200 && bob2.cookie && bob2.cookie !== bob.cookie);
        r = await login(alice, 'Alice', 'alice-pw-12345');
        ok('Alice (admin) logs in', r.status === 200 && r.body.role === 'admin', r.body);
        r = await login(master, 'admin', 'master-admin-pw-1');
        ok('the master admin logs in', r.status === 200 && r.body.role === 'admin', r.body);
        r = await login(master2, 'admin', 'master-admin-pw-1');
        ok('...on a second device as well', r.status === 200);

        console.log('\n── Baseline: everything works before anyone touches the accounts ' + '─'.repeat(10));
        r = await post(bob, '/hub-api/link-code');
        ok('Bob (user) can hit a write endpoint', r.status === 200 && r.body.success === true, [r.status, r.body]);
        r = await get(bob, '/game/Game/News');
        ok('Bob reaches the proxied game', r.status === 200 && r.body.proxied === true && r.body.as === 'Bob', r.body);
        r = await get(alice, '/hub-api/admin/users');
        ok('Alice reaches an admin route', r.status === 200, r.status);
        r = await get(alice, '/hub-api/admin/api-traffic');
        ok('Alice reaches the direct admin traffic endpoint', r.status === 200, r.status);

        console.log('\n── Deactivating an account ends its sessions — all of them ' + '─'.repeat(16));
        r = await post(alice, `/hub-api/admin/users/${bobId}/toggle`);
        ok('Alice deactivates Bob through the real admin endpoint', r.status === 200 && r.body.is_active === 0, r.body);
        r = await get(bob, '/hub-api/me');
        ok('Bob\'s first device: a hub read is now 401', r.status === 401, r.status);
        r = await post(bob2, '/hub-api/link-code');
        ok('Bob\'s second device: a hub write is now 401', r.status === 401, r.status);
        r = await get(bob2, '/game/Game/News');
        ok('and the game proxy sends him to the login page', r.status === 302 && /login/.test(r.location || ''), [r.status, r.location]);
        ok('the dead cookie was cleared on the way out', bob.cookie === null && bob2.cookie === null, [bob.cookie, bob2.cookie]);

        r = await post(alice, `/hub-api/admin/users/${bobId}/toggle`);
        ok('Alice reactivates Bob', r.status === 200 && r.body.is_active === 1, r.body);
        r = await login(bob, 'Bob', 'bob-pw-12345');
        ok('Bob has to log in again, and can', r.status === 200, r.status);
        r = await login(bob2, 'Bob', 'bob-pw-12345');
        ok('...on both devices', r.status === 200, r.status);

        console.log('\n── A role change applies on the very next request ' + '─'.repeat(25));
        r = await post(master, `/hub-api/admin/users/${aliceId}/role`, { role: 'guest' });
        ok('the master admin demotes Alice from admin to guest', r.status === 200 && r.body.role === 'guest', r.body);
        r = await get(alice, '/hub-api/admin/users');
        ok('Alice\'s existing session is refused by requireAdmin', r.status === 403, r.status);
        r = await get(alice, '/hub-api/admin/api-traffic');
        ok('...and by the direct admin traffic endpoint', r.status === 403, r.status);
        r = await post(alice, '/hub-api/link-code');
        ok('...and blockGuestWrites now treats her as read-only', r.status === 403 && /Read-only/.test(r.body.error), r.body);
        r = await get(alice, '/hub-api/me');
        ok('reads still work, and /me reports the NEW role', r.status === 200 && r.body.role === 'guest', r.body);

        r = await post(master, `/hub-api/admin/users/${aliceId}/role`, { role: 'user' });
        ok('promoted back to user', r.status === 200);
        r = await post(alice, '/hub-api/link-code');
        ok('the same session can write again', r.status === 200, r.status);

        console.log('\n── A password reset logs out every other device ' + '─'.repeat(27));
        r = await post(master, `/hub-api/admin/users/${bobId}/password`, { new_password: 'bob-new-pw-12345' });
        ok('the master admin resets Bob\'s password', r.status === 200 && r.body.otherSessionsInvalidated === true, r.body);
        r = await get(bob, '/hub-api/me');
        ok('Bob\'s first device is logged out', r.status === 401, r.status);
        r = await get(bob2, '/hub-api/me');
        ok('...and so is the second', r.status === 401, r.status);
        r = await login(bob, 'Bob', 'bob-pw-12345');
        ok('the old password no longer works', r.status === 401, r.status);
        r = await login(bob, 'Bob', 'bob-new-pw-12345');
        ok('the new one does', r.status === 200, r.status);
        r = await get(bob, '/hub-api/me');
        ok('and the fresh session is valid', r.status === 200 && r.body.id === bobId, r.body);

        console.log('\n── Changing your OWN password keeps this session, and only this one ' + '─'.repeat(6));
        r = await post(master, `/hub-api/admin/users/${adminId}/password`, { new_password: 'master-admin-pw-2' });
        ok('the master admin changes their own password', r.status === 200, r.body);
        r = await get(master, '/hub-api/admin/users');
        ok('the device that typed it stays logged in', r.status === 200, r.status);
        r = await get(master2, '/hub-api/me');
        ok('the master admin\'s OTHER device is logged out', r.status === 401, r.status);
        r = await login(master2, 'admin', 'master-admin-pw-2');
        ok('...and gets back in with the new password', r.status === 200, r.status);

        console.log('\n── Deleting an account ends its session ' + '─'.repeat(35));
        const carolId = seedUser('Carol', 'carol-pw-12345', 'user');
        const carol = jar();
        r = await login(carol, 'Carol', 'carol-pw-12345');
        ok('Carol logs in', r.status === 200);
        r = await del(master, `/hub-api/admin/users/${carolId}`);
        ok('the master admin deletes Carol', r.status === 200, r.body);
        r = await get(carol, '/hub-api/me');
        ok('Carol\'s session is gone', r.status === 401, r.status);

        console.log('\n── Logout is explicit ' + '─'.repeat(53));
        r = await post(bob, '/hub-api/logout');
        ok('logout answers success', r.status === 200 && r.body.success === true, r.body);
        ok('and clears the cookie', bob.cookie === null, bob.cookie);
        r = await get(bob, '/hub-api/me');
        ok('a request afterwards is anonymous', r.status === 401, r.status);
        r = await post(jar(), '/hub-api/logout');
        ok('logging out with no session at all is not an error', r.status === 200, r.status);

        console.log('\n── Nothing changes for an account nobody touched ' + '─'.repeat(26));
        r = await get(alice, '/hub-api/me');
        ok('Alice\'s session from the very start is still valid', r.status === 200 && r.body.gameName === 'Alice', r.body);
    } finally {
        server.close();
    }

    // ─── THE GUARD ON ITS OWN: edges the HTTP run cannot reach ───────────────────
    console.log('\n── The guard alone ' + '─'.repeat(56));
    function drive(guard, sess) {
        const out = { nexted: false, status: null, body: null, destroyed: false, cleared: null };
        const req = { session: sess };
        if (sess) sess.destroy = cb => { out.destroyed = true; req.session = undefined; cb(); };
        const res = {
            status(c) { out.status = c; return this; },
            json(b) { out.body = b; return this; },
            clearCookie(n) { out.cleared = n; },
        };
        guard(req, res, () => { out.nexted = true; });
        return Object.assign(out, { session: req.session });
    }
    const account = { id: 7, game_name: 'Seven', role: 'user', is_active: 1, session_version: 0 };

    let g = sessionAccountGuard({ loadAccount: () => account, log: quiet });
    let d = drive(g, { userId: 7, role: 'user', gameName: 'Seven' });
    ok('a valid session passes', d.nexted && !d.destroyed);
    d = drive(g, { userId: 7, role: 'user', gameName: 'Seven' });   // no sessionVersion at all
    ok('a session from before session_version existed is read as version 0 and passes',
        d.nexted && !d.destroyed, d);
    d = drive(g, { userId: 7, role: 'admin', gameName: 'Old Name', sessionVersion: 0 });
    ok('role and gameName are refreshed from the row', d.session.role === 'user' && d.session.gameName === 'Seven', d.session);
    d = drive(g, {});
    ok('an anonymous request is left alone', d.nexted && !d.destroyed);
    d = drive(g, undefined);
    ok('no session object at all is left alone', d.nexted);

    g = sessionAccountGuard({ loadAccount: () => Object.assign({}, account, { session_version: 3 }), log: quiet });
    d = drive(g, { userId: 7, sessionVersion: 0 });
    ok('a version mismatch destroys the session and continues anonymously',
        d.destroyed && d.nexted && d.session === undefined && d.cleared === HUB_SESSION_COOKIE, d);
    d = drive(g, { userId: 7 });
    ok('a legacy session with no version is rejected once the account\'s version moved', d.destroyed && d.nexted, d);

    g = sessionAccountGuard({ loadAccount: () => { throw new Error('database is locked'); }, log: quiet });
    d = drive(g, { userId: 7, sessionVersion: 0 });
    ok('a failing lookup answers 503 and does NOT destroy the session',
        d.status === 503 && !d.destroyed && !d.nexted, d);

    ok('revocationReason names each case',
        revocationReason({}, undefined) === 'account no longer exists'
        && revocationReason({}, { is_active: 0, session_version: 0 }) === 'account deactivated'
        && revocationReason({ sessionVersion: 1 }, { is_active: 1, session_version: 2 }) === 'password was reset'
        && revocationReason({ sessionVersion: 2 }, { is_active: 1, session_version: 2 }) === null);

    let threw = false;
    try { sessionAccountGuard({}); } catch (e) { threw = true; }
    ok('building the guard without a loader is a programming error, not a silent pass-through', threw);

    // ─── IT IS ACTUALLY MOUNTED, AND FIRST ───────────────────────────────────────
    console.log('\n── The guard is wired in, ahead of everything that reads the session ' + '─'.repeat(5));
    const readRaw = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    const readCode = rel => readRaw(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    // server.js is scanned RAW: a line comment in it mentions "/rzhub/*", which the block-
    // comment stripper above reads as an opening "/*" and swallows everything up to the
    // next "*/" — including the session mount these anchors sit next to. None of the
    // anchors below can occur inside a comment, so the raw text is the safer read here.
    const serverSrc = readRaw('server.js');
    const sessionMount = serverSrc.indexOf('app.use(session({');
    const guardMount = serverSrc.indexOf('app.use(sessionAccountGuard(');
    ok('server.js mounts the guard', guardMount !== -1);
    ok('...after the session middleware', sessionMount !== -1 && guardMount > sessionMount, [sessionMount, guardMount]);
    for (const [what, marker] of [
        ['the direct game-traffic endpoint', `app.get('/hub-api/admin/game-traffic'`],
        ['the direct api-traffic endpoint', `app.get('/hub-api/admin/api-traffic'`],
        ['the /hub-api routers', `app.use('/hub-api', apiRoutes)`],
        ['the /api/v1 chain', 'if (!isGameApiPath(req))'],
        ['/dashboard', `app.get('/dashboard'`],
        ['the catch-all game proxy', `app.use('/', requireAuth`],
    ]) {
        const at = serverSrc.indexOf(marker);
        ok(`...and before ${what}`, at !== -1 && guardMount < at, [guardMount, at]);
    }
    ok('the guard loads accounts through the users repository',
        /sessionAccountGuard\(\{ loadAccount: usersRepo\.getSessionAccountById \}\)/.test(serverSrc));

    const authSrc = readCode('src/routes/auth.js');
    ok('login regenerates the session id', /req\.session\.regenerate\(/.test(authSrc));
    ok('login persists before answering', /req\.session\.save\(/.test(authSrc));
    ok('login records the account\'s session version', /req\.session\.sessionVersion\s*=/.test(authSrc));
    const adminSrc = readCode('src/routes/admin.js');
    ok('the password route bumps the session version', /bumpSessionVersion\(/.test(adminSrc));
    const dbSrc = readCode('src/database.js');
    ok('the column is migrated in', /addColumn\('app_users', 'session_version'/.test(dbSrc));

    db.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
