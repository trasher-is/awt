// Route-level coverage for the token-gated bonus-goals admin surface (see
// bonusGoals.js/secretOps.js's own comments for the secrecy design). Drives the real
// router end-to-end (express app + http server + fetch), same discipline as
// sync-battle-report-ship-detail.test.js. The token itself is not under test here — this
// router is mounted directly at its own base path in the test app, same as it would be
// mounted at /x/<token> in server.js; what IS under test is that requireAuth/requireAdmin
// actually gate it, and that the CRUD endpoints work.
//
// Run with: node src/routes/secretOps.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-secret-ops-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const secretOpsRouter = require('./secretOps');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('secretOps.test.js');

function buildApp(session) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session; next(); });
    app.use('/x/test-token', secretOpsRouter);
    return app;
}

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    console.log('\n── access control: no session at all ' + '─'.repeat(20));
    let server = buildApp(null).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const res = await request(server, 'GET', '/x/test-token/api/goals');
        ok('no session at all is rejected (401), not served', res.status === 401, res);
    } finally { server.close(); }

    console.log('\n── access control: logged in, but not an admin ' + '─'.repeat(10));
    server = buildApp({ userId: 1, role: 'user' }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const res = await request(server, 'GET', '/x/test-token/api/goals');
        ok('a logged-in non-admin is rejected (403) — the path alone is not enough', res.status === 403, res);
    } finally { server.close(); }

    console.log('\n── admin session: full CRUD round-trip ' + '─'.repeat(20));
    server = buildApp({ userId: 1, role: 'admin' }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const empty = await request(server, 'GET', '/x/test-token/api/goals');
        ok('an admin session is let in', empty.status === 200, empty);
        ok('starts with no goals', Array.isArray(empty.body.goals) && empty.body.goals.length === 0, empty.body);

        const created = await request(server, 'POST', '/x/test-token/api/goals', {
            type: 'ranking_match', name: 'route test goal',
            config: { ranking_path: '/Ranking/Fake', tier_size: 5, tier_start_points: 100, tier_step: -5, max_rank: 50 },
            enabled: true,
        });
        ok('create succeeds (200)', created.status === 200 && created.body.success, created.body);
        ok('the created goal comes back with a parsed config object', created.body.goal.config.tier_size === 5, created.body);
        const id = created.body.goal.id;

        const missingFields = await request(server, 'POST', '/x/test-token/api/goals', { name: 'no type' });
        ok('creating without a type is rejected (400)', missingFields.status === 400, missingFields);

        const badJson = await request(server, 'POST', '/x/test-token/api/goals', { type: 'ranking_match', name: 'x', config: '{not json' });
        ok('an unparseable config string is rejected (400), not silently stored empty', badJson.status === 400, badJson);

        const updated = await request(server, 'PUT', `/x/test-token/api/goals/${id}`, { enabled: false });
        ok('update succeeds and flips enabled', updated.status === 200 && updated.body.goal.enabled === false, updated.body);

        const listed = await request(server, 'GET', '/x/test-token/api/goals');
        ok('the updated goal shows up in the list', listed.body.goals.some(g => g.id === id && g.enabled === false), listed.body);

        const awardsEmpty = await request(server, 'GET', '/x/test-token/api/awards');
        ok('awards endpoint works even with none yet', awardsEmpty.status === 200 && awardsEmpty.body.awards.length === 0, awardsEmpty.body);

        const deleted = await request(server, 'DELETE', `/x/test-token/api/goals/${id}`);
        ok('delete succeeds', deleted.status === 200 && deleted.body.success, deleted.body);

        const deleteAgain = await request(server, 'DELETE', `/x/test-token/api/goals/${id}`);
        ok('deleting an already-gone goal reports 404, not a crash', deleteAgain.status === 404, deleteAgain);

        const page = await request(server, 'GET', '/x/test-token/');
        ok('the admin page itself loads for an admin session', page.status === 200, page.status);
    } finally { server.close(); }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch((err) => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
