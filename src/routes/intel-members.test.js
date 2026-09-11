// GET /hub-api/intel/members — feeds spy.js's ally-name resolution ("Allied Siege by X").
// `members` (hub-registered game names) is the original, narrower list; `allied_tags` is
// new (see friendly-alliance-tags.js): a real alliance member never needs a hub account at
// all for tag-based matching to recognize them, unlike the name list.
//
// Run with: node src/routes/intel-members.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-members-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const settingsRepo = require('../repositories/settings');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

const app = express();
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', intelRouter);

function request(server, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port, path: urlPath }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (err) { reject(err); } });
        }).on('error', reject);
    });
}

// A hub-registered member (shows up in `members`)...
usersRepo.createUser('Caveman', 'not-a-real-hash', 'user', null);
// ...and our alliance, discovered the same way friendlyAllianceTags always does: via a
// member with an alliance_member_stats row. Deliberately a DIFFERENT player id than the
// hub account above — a real alliance member (BaldWithABeard, live 2026-09-11) never needs
// their own hub login for tag-based matching to work, which is the entire point.
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (300, 'Our Alliance', 'RAID')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (30, 'SomeOtherRaidMember', 300)`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (30)`).run();
settingsRepo.setSetting('alliance_relations_allied', 'AO');

(async () => {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));

    try {
        const res = await request(server, '/hub-api/intel/members');
        ok('succeeds (200)', res.status === 200, res);
        ok('members lists the hub-registered account', res.body.members.includes('Caveman'), res.body);
        ok('allied_tags includes our own alliance tag (RAID), discovered without any hub account for it',
            res.body.allied_tags.includes('RAID'), res.body);
        ok('allied_tags includes the admin-configured allied tag (AO) too',
            res.body.allied_tags.includes('AO'), res.body);
    } finally {
        server.close();
    }

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch(err => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
