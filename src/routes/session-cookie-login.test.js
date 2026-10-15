// The hub cookie lives as long as the member is active, and the login name is not
// case-sensitive.
//
// Run with:  node src/routes/session-cookie-login.test.js
//
// Two production failures on 14 Oct 2026:
//
//   • A member was active at 20:07:50 and logged out at 20:08:45 — thirty days to the
//     minute after that login. express-session moved the STORE's expiry forward on every
//     request but, without `rolling`, never re-sent the cookie, so the browser dropped it
//     on the original date. (src/utils/session-options.js)
//   • Logging back in then failed with "Invalid credentials" eight times from a phone.
//     Names are stored mostly lowercase and the lookup was an exact match, so a keyboard
//     capitalising the first letter was enough. (getUserForLogin in src/repositories/users.js)
//
// Boots the REAL routers and the REAL session options server.js mounts, against a
// temporary synthetic database.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-session-cookie-'));
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
const { sessionAccountGuard } = require('../utils/session-account');
const { hubSessionOptions, SESSION_MAX_AGE_MS } = require('../utils/session-options');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const quiet = { warn() {}, error() {} };

function buildApp(sessionOptions) {
    const app = express();
    app.use(session(sessionOptions));
    app.use(sessionAccountGuard({ loadAccount: usersRepo.getSessionAccountById, log: quiet }));
    app.use('/hub-api', hubBody({ syncLimit: '1mb', limit: '256kb' }));
    app.use('/hub-api', apiRoutes);
    return app;
}

// ─── A TINY HTTP CLIENT WITH A COOKIE JAR ─────────────────────────────────────
function jar() { return { cookie: null }; }

function request(port, j, method, urlPath, body) {
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
                const setCookie = (res.headers['set-cookie'] || [])[0] || null;
                if (setCookie) j.cookie = setCookie.split(';')[0];
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* not JSON */ }
                resolve({ status: res.statusCode, body: parsed, setCookie });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

function expiresOf(setCookie) {
    const m = /Expires=([^;]+)/i.exec(setCookie || '');
    return m ? new Date(m[1]).getTime() : null;
}

async function listen(app) {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    return server;
}

(async () => {
    usersRepo.createUser('caveman', bcrypt.hashSync('cave-pw-12345', 4), 'user', null);
    usersRepo.createUser('BaldWithABeard', bcrypt.hashSync('bald-pw-12345', 4), 'user', null);
    // Two accounts that differ only by case — allowed by the case-sensitive UNIQUE.
    usersRepo.createUser('Sam', bcrypt.hashSync('big-sam-pw-1', 4), 'user', null);
    usersRepo.createUser('sam', bcrypt.hashSync('small-sam-pw', 4), 'user', null);

    const live = await listen(buildApp(hubSessionOptions({ secret: 'test-only-secret', secure: false })));
    const port = live.address().port;
    const req = (j, m, p, b) => request(port, j, m, p, b);
    const login = (j, game_name, password) => req(j, 'POST', '/hub-api/login', { game_name, password });

    try {
        console.log('── The cookie is renewed by activity ' + '─'.repeat(40));
        const anon = jar();
        let r = await req(anon, 'GET', '/hub-api/me');
        ok('an anonymous request gets no cookie (saveUninitialized stays off)', r.status === 401 && !r.setCookie, r);

        const m = jar();
        r = await login(m, 'caveman', 'cave-pw-12345');
        ok('login sets a cookie', r.status === 200 && !!r.setCookie, r);
        const loginExpires = expiresOf(r.setCookie);
        ok('that cookie lasts thirty days', Math.abs(loginExpires - (Date.now() + SESSION_MAX_AGE_MS)) < 5000,
            new Date(loginExpires).toISOString());

        await new Promise(res => setTimeout(res, 1100)); // Expires has one-second resolution
        r = await req(m, 'GET', '/hub-api/me');
        ok('a plain request that changes nothing in the session still re-sends the cookie',
            r.status === 200 && !!r.setCookie, r.setCookie);
        ok('with an expiry pushed forward from the login one', expiresOf(r.setCookie) > loginExpires,
            [new Date(loginExpires).toISOString(), r.setCookie]);
        ok('and the same session id (renewed, not replaced)', r.setCookie && r.setCookie.split(';')[0] === m.cookie);

        // Control: the options as they were before — proves the check above can fail.
        const before = await listen(buildApp({
            ...hubSessionOptions({ secret: 'test-only-secret', secure: false }), rolling: false,
        }));
        const old = jar();
        await request(before.address().port, old, 'POST', '/hub-api/login', { game_name: 'caveman', password: 'cave-pw-12345' });
        const oldMe = await request(before.address().port, old, 'GET', '/hub-api/me');
        ok('(control) without rolling, the same request sends no cookie — the browser keeps the login-day expiry',
            oldMe.status === 200 && !oldMe.setCookie, oldMe.setCookie);
        before.close();

        console.log('── The login name is not case-sensitive ' + '─'.repeat(37));
        for (const typed of ['caveman', 'Caveman', 'CAVEMAN', '  caveman ']) {
            r = await login(jar(), typed, 'cave-pw-12345');
            ok(`"${typed}" logs in as caveman`, r.status === 200 && r.body.success === true, r.body);
        }
        const bald = jar();
        r = await login(bald, 'baldwithabeard', 'bald-pw-12345');
        ok('a mixed-case name logs in typed all lowercase', r.status === 200, r.body);
        r = await req(bald, 'GET', '/hub-api/me');
        ok('…and the session belongs to the stored name', r.status === 200 && r.body.gameName === 'BaldWithABeard', r.body);

        r = await login(jar(), 'Caveman', 'wrong-password');
        ok('a wrong password is still 401 under a different case', r.status === 401, r.status);
        r = await login(jar(), 'nobody', 'cave-pw-12345');
        ok('an unknown name is still 401', r.status === 401, r.status);
        r = await login(jar(), undefined, 'cave-pw-12345');
        ok('a missing name is 401, not a crash', r.status === 401, [r.status, r.body]);

        console.log('── Names that differ only by case ' + '─'.repeat(43));
        r = await login(jar(), 'Sam', 'big-sam-pw-1');
        ok('the exact name "Sam" logs into Sam', r.status === 200, r.body);
        r = await login(jar(), 'sam', 'small-sam-pw');
        ok('the exact name "sam" logs into sam', r.status === 200, r.body);
        r = await login(jar(), 'SAM', 'big-sam-pw-1');
        ok('"SAM" matches neither — no guessing between two accounts', r.status === 401, r.status);
        ok('getUserForLogin agrees', usersRepo.getUserForLogin('SAM') === undefined
            && usersRepo.getUserForLogin('sam').game_name === 'sam'
            && usersRepo.getUserForLogin('CAVEMAN').game_name === 'caveman');
    } catch (err) {
        fail++;
        console.log('  ❌ test threw:', err);
    } finally {
        live.close();
        db.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
