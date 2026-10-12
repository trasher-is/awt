// Two hubs, two databases, two processes, real HTTP: hub A shares with hub B.
//
// What matters: B's admin adds A as a source and pulls; only what A granted arrives; the
// feed refuses missing, wrong and revoked tokens alike and refuses kinds it was not
// granted; a second pull with nothing new stores nothing; members can browse what arrived
// without ever seeing a partner's address or token; guests cannot change sharing; the
// one-time token is never listed again; and removing a source removes what it sent.
//
// All data is invented. Run with: node src/routes/peer-sharing-e2e.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROLE = process.env.PEER_E2E_ROLE || 'hubB';
process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `awt-peer-e2e-${ROLE}-`)), 'test.db');
delete process.env.DISCORD_TOKEN;
process.env.PEER_ALLOW_HTTP = '1';

const express = require('express');
const db = require('../database');
const peersRepo = require('../repositories/peers');

// ─── HUB A: the sharing side, run as a child process ───
if (ROLE === 'hubA') {
    const T = '2026-10-01 10:00:00';
    db.prepare(`INSERT INTO alliances (id, name, tag, updated_at) VALUES (2, 'Them', 'THEM', ?)`).run(T);
    db.prepare(`INSERT INTO players (id, name, alliance_id, race_attack, updated_at) VALUES (20, 'Foe', 2, 3, ?), (21, 'Foe2', 2, 1, ?)`).run(T, T);
    db.prepare(`INSERT INTO systems (id, name, x, y, updated_at) VALUES (100, 'Alpha', 1, 2, ?)`).run(T);
    db.prepare(`INSERT INTO fleets (owner_id, system_id, destroyers, updated_at) VALUES (20, 100, 5, ?)`).run(T);
    const { token } = peersRepo.createLink({ name: 'Hub B', scopes: ['players', 'systems'] });
    const revoked = peersRepo.createLink({ name: 'Old partner', scopes: ['players'] });
    peersRepo.deleteLink(revoked.link.id);
    const app = express();
    app.use('/peer-api', require('./peerFeed'));
    const server = app.listen(0, '127.0.0.1', () => {
        process.stdout.write('READY ' + JSON.stringify({ port: server.address().port, token, revokedToken: revoked.token }) + '\n');
    });
    process.on('SIGTERM', () => process.exit(0));
    return;
}

// ─── HUB B: the receiving side, this process ───
const { blockGuestWrites } = require('./_middleware');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) console.log(`  ok - ${desc}`);
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

function request(port, method, urlPath, body, headers = {}) {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: Object.assign(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, headers),
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { /* not json */ } resolve({ status: res.statusCode, body: json, raw }); });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function startHubA() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename], { env: Object.assign({}, process.env, { PEER_E2E_ROLE: 'hubA' }), stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', c => {
            out += c;
            const m = /READY (\{.*\})/.exec(out);
            if (m) resolve({ child, info: JSON.parse(m[1]) });
        });
        child.on('exit', code => reject(new Error(`hub A exited early (${code})`)));
        setTimeout(() => reject(new Error('hub A did not start')), 20000).unref();
    });
}

(async () => {
    console.log('peer-sharing-e2e.test.js');
    const { child, info } = await startHubA();
    const A = info.port;
    const bearer = t => ({ Authorization: `Bearer ${t}` });

    try {
        // ─── hub A's feed, seen from outside ───
        const noTok = await request(A, 'GET', '/peer-api/v1/hello');
        const wrongTok = await request(A, 'GET', '/peer-api/v1/hello', undefined, bearer('awtp_' + 'z'.repeat(43)));
        const revoked = await request(A, 'GET', '/peer-api/v1/hello', undefined, bearer(info.revokedToken));
        ok('no token, a wrong token and a revoked token all get the same 401', [noTok, wrongTok, revoked].every(r => r.status === 401)
            && noTok.raw === wrongTok.raw && wrongTok.raw === revoked.raw, [noTok.status, wrongTok.status, revoked.status]);
        const hello = await request(A, 'GET', '/peer-api/v1/hello', undefined, bearer(info.token));
        ok('hello lists exactly the kinds granted', hello.status === 200 && JSON.stringify(hello.body.kinds) === '["players","systems"]', hello.body);
        const fleets = await request(A, 'GET', '/peer-api/v1/feed?kind=fleets', undefined, bearer(info.token));
        ok('a kind not granted is refused', fleets.status === 403, fleets.status);
        const appUsers = await request(A, 'GET', '/peer-api/v1/feed?kind=app_users', undefined, bearer(info.token));
        ok('a table that is not a kind is refused', appUsers.status === 400, appUsers.status);

        // ─── hub B's own API ───
        let session = { userId: 1, gameName: 'AdminB', role: 'admin' };
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => { req.session = session ? { ...session } : undefined; next(); });
        app.use('/hub-api', blockGuestWrites, require('./peers'));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        const B = server.address().port;

        try {
            const bad = await request(B, 'POST', '/hub-api/admin/peers/sources', { name: 'Game', baseUrl: 'https://astrowars.games', token: info.token });
            ok('the game itself cannot be added as a source', bad.status === 400, bad.body);

            const add = await request(B, 'POST', '/hub-api/admin/peers/sources', { name: 'Hub A', baseUrl: `http://127.0.0.1:${A}/`, token: info.token });
            ok('admin adds hub A as a source', add.status === 200 && add.body.source && add.body.source.baseUrl === `http://127.0.0.1:${A}`, add.body);
            ok('the stored token is not echoed back', add.body && !JSON.stringify(add.body).includes(info.token));
            const sid = add.body.source.id;

            const pull = await request(B, 'POST', `/hub-api/admin/peers/sources/${sid}/pull`);
            ok('pull succeeds and stores what A granted', pull.status === 200 && pull.body.success && pull.body.result.received === 3, pull.body);
            const kinds = db.prepare(`SELECT kind, COUNT(*) n FROM peer_intel GROUP BY kind ORDER BY kind`).all();
            ok('only players and systems arrived — no fleets', JSON.stringify(kinds) === '[{"kind":"players","n":2},{"kind":"systems","n":1}]', kinds);
            ok('nothing landed in B\'s own player table', db.prepare(`SELECT COUNT(*) n FROM players`).get().n === 0);

            const pull2 = await request(B, 'POST', `/hub-api/admin/peers/sources/${sid}/pull`);
            ok('a second pull with nothing new stores nothing', pull2.body.success && pull2.body.result.received === 0, pull2.body);

            session = { userId: 2, gameName: 'MemberB', role: 'user' };
            const intel = await request(B, 'GET', '/hub-api/peers/intel?kind=players&q=foe2');
            ok('a member can search shared players', intel.status === 200 && intel.body.rows.length === 1 && intel.body.rows[0].data.race_attack === 1
                && intel.body.rows[0].sourceName === 'Hub A', intel.body);
            const summary = await request(B, 'GET', '/hub-api/peers/summary');
            ok('the member summary names sources and counts', summary.status === 200 && summary.body.sources[0].counts.players === 2, summary.body);
            ok('…without the partner\'s address or token', !summary.raw.includes('127.0.0.1') && !summary.raw.includes(info.token) && !summary.raw.includes('awtp_'));
            const memberAdmin = await request(B, 'GET', '/hub-api/admin/peers');
            ok('members cannot see the admin view', memberAdmin.status === 403);

            session = { userId: 3, gameName: 'GuestB', role: 'guest' };
            const guestLink = await request(B, 'POST', '/hub-api/admin/peers/links', { name: 'x', scopes: ['players'] });
            ok('a guest cannot create a share link', guestLink.status === 403);

            session = { userId: 1, gameName: 'AdminB', role: 'admin' };
            const mk = await request(B, 'POST', '/hub-api/admin/peers/links', { name: 'Hub C', scopes: ['players', 'nope'] });
            ok('creating a link returns its token once, unknown scopes dropped', mk.status === 200 && /^awtp_/.test(mk.body.token)
                && JSON.stringify(mk.body.link.scopes) === '["players"]', mk.body);
            const listed = await request(B, 'GET', '/hub-api/admin/peers');
            ok('the admin list never shows the token or its hash', !listed.raw.includes(mk.body.token) && !listed.raw.includes(peersRepo.sha256(mk.body.token)));
            const empty = await request(B, 'POST', '/hub-api/admin/peers/links', { name: 'Hub D', scopes: [] });
            ok('a link that shares nothing is refused', empty.status === 400);

            const del = await request(B, 'DELETE', `/hub-api/admin/peers/sources/${sid}`);
            ok('removing a source removes everything it sent', del.status === 200 && db.prepare(`SELECT COUNT(*) n FROM peer_intel`).get().n === 0);
        } finally {
            server.close();
        }
    } finally {
        child.kill('SIGTERM');
    }

    console.log(failed ? `\n${failed} FAILED` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
