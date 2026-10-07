// The admin page's Versions card, end to end through the real /hub-api mount: a tab's version
// poll records which build it loaded, and only an admin can read the list. Also pins that the
// poll still answers a logged-out tab (the one most likely to be running something ancient)
// and records nothing for it. Synthetic accounts; GitHub is never contacted (the update check
// is not started in tests, and its state is only read).
//
// Run with: node src/routes/admin-versions.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-admin-versions-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const apiRouter = require('./api');
const { buildVersion } = require('../utils/build-version');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const memberId = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('SynthMember', 'x', 'user')`).run().lastInsertRowid;
const adminId = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('SynthAdmin', 'x', 'admin')`).run().lastInsertRowid;

// Who is calling is chosen per request by a test-only header.
const sessions = { member: { userId: Number(memberId), role: 'user' }, admin: { userId: Number(adminId), role: 'admin' }, none: null };
const app = express();
app.use(express.json());
app.use((req, res, next) => { const s = sessions[req.get('x-test-as') || 'none']; if (s) req.session = { ...s }; next(); });
app.use('/hub-api', apiRouter);

function get(server, urlPath, as, userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36') {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath, headers: { 'x-test-as': as, 'user-agent': userAgent } }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { let body = null; try { body = JSON.parse(raw); } catch (_) { /* leave null */ } resolve({ status: res.statusCode, body }); });
        }).on('error', reject);
    });
}

(async () => {
    console.log('admin-versions.test.js');
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const current = buildVersion();
    try {
        console.log('\n── the version poll ' + '─'.repeat(50));
        const plain = await get(server, '/hub-api/version', 'none');
        ok('a logged-out tab still gets the version', plain.status === 200 && plain.body.version === current, plain);
        await get(server, '/hub-api/version?tab=anon-tab-0001&build=abcdef123456', 'none');

        await get(server, '/hub-api/version?tab=member-phone-1&build=abcdef123456', 'member');
        await get(server, `/hub-api/version?tab=member-desk-22&build=${current}`, 'member', 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0');
        await get(server, '/hub-api/version?tab=member-bad-333&build=<b>nope</b>', 'member');

        console.log('\n── the admin list ' + '─'.repeat(52));
        const denied = await get(server, '/hub-api/admin/versions', 'member');
        ok('a member cannot read it', denied.status === 403, denied);
        const res = await get(server, '/hub-api/admin/versions', 'admin');
        ok('an admin can', res.status === 200 && res.body.success === true, res);
        const tabs = res.body.tabs;
        ok('both of the member\'s tabs are listed, nothing from the logged-out poll or the malformed one',
            tabs.length === 2 && tabs.every(t => t.game_name === 'SynthMember'), tabs);
        ok('the old tab is first and marked not current', tabs[0].current === false && tabs[0].build === 'abcdef123456', tabs[0]);
        ok('with what it runs on (from its User-Agent)', tabs[0].browser === 'chrome' && tabs[0].mobile === 1, tabs[0]);
        ok('the up-to-date tab is marked current', tabs[1].current === true && tabs[1].browser === 'firefox' && tabs[1].mobile === 0, tabs[1]);
        ok('it says which build is current', res.body.current_build === current);
        ok('and carries the hub\'s update status', res.body.hub && typeof res.body.hub.status === 'string' && res.body.hub.repo, res.body.hub);

        db.prepare('DELETE FROM app_users WHERE id = ?').run(memberId);
        const afterDelete = await get(server, '/hub-api/admin/versions', 'admin');
        ok('a deleted account\'s tabs are not shown', afterDelete.body.tabs.length === 0, afterDelete.body.tabs);
    } finally {
        server.close();
    }
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
})().catch((err) => { console.error('Test run crashed:', err); process.exit(1); });
