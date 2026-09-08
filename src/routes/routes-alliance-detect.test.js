// Issue #147: the route planner's alliance/own-destination halving used to be one manual
// checkbox applied to the WHOLE route, even though the game's real rule is per-flight (half
// time whenever the DESTINATION is your own or an ally's planet). This drives the REAL
// /hub-api/routes/preview route end-to-end and checks that each leg is auto-detected from
// who currently owns its destination planet — own alliance, the configured allied list, an
// unrelated/enemy owner, and an unowned/never-scanned planet — plus that the manual
// checkbox still works as an override for a destination our own data doesn't know about.
//
// Run with: node src/routes/routes-alliance-detect.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-routes-alliance-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const systemsRepo = require('../repositories/systems');
const settingsRepo = require('../repositories/settings');
const { hubBody } = require('../utils/hub-body');
const routesRouter = require('./routes');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

usersRepo.createUser('Navigator', 'not-a-real-hash', 'user', null);
const me = usersRepo.getUserByGameName('Navigator');

const app = express();
app.use('/hub-api', hubBody({ syncLimit: '1mb', limit: '256kb' }));
app.use((req, res, next) => { req.session = { userId: me.id, gameName: 'Navigator', role: 'user' }; next(); });
app.use('/hub-api', routesRouter);

let port;
function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
        const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* */ } resolve({ status: res.statusCode, body: b, raw }); });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}
const preview = body => request('POST', '/hub-api/routes/preview', body);

// --- Seed the galaxy: one home system, four destination systems at distinct coordinates ---
systemsRepo.upsertSystemFull(1, 'Home', 0, 0);
systemsRepo.upsertSystemFull(2, 'OwnTerritory', 3, 4);
systemsRepo.upsertSystemFull(3, 'AlliedTerritory', 6, 8);
systemsRepo.upsertSystemFull(4, 'EnemyTerritory', 9, 12);
systemsRepo.upsertSystemFull(5, 'NeverScanned', 12, 16);

// --- Our own alliance: a member with alliance_member_stats (how getAllianceMemberStatIds
// finds "us"), owning the planet at OwnTerritory #1 ---
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (100, 'Our Alliance', 'RAID')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (10, 'Caveman', 100)`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (10)`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (201, 2, 1, 10, 5)`).run();

// --- An allied alliance (configured via the Admin -> Alliance Relations tag list), owning
// the planet at AlliedTerritory #1 ---
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (101, 'Our Friends', 'AO')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (11, 'Ally Player', 101)`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (301, 3, 1, 11, 5)`).run();
settingsRepo.setSetting('alliance_relations_allied', 'AO');

// --- An unrelated (enemy/neutral) alliance, owning the planet at EnemyTerritory #1 ---
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (102, 'Someone Else', 'XYZ')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (12, 'Rando', 102)`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (401, 4, 1, 12, 5)`).run();

// NeverScanned #1 gets no planets row at all — the tool has no idea who (if anyone) owns it.

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    port = server.address().port;

    try {
        console.log('── A leg to our own alliance\'s planet is auto-halved ' + '─'.repeat(20));
        let r = await preview({
            waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 1 }],
            energy: 0, raceSpeed: 0, biology: 0, isAllianceMove: false,
        });
        ok('responds 200', r.status === 200, r.body);
        let leg = r.body && r.body.legs && r.body.legs[0];
        ok('isAllianceMove is true for a planet owned by our own alliance', leg && leg.isAllianceMove === true, leg);
        ok('autoAllianceMove is true (detected, not the manual checkbox)', leg && leg.autoAllianceMove === true, leg);

        console.log('\n── A leg to an ALLIED alliance\'s planet is auto-halved ' + '─'.repeat(18));
        r = await preview({
            waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 3, planetIndex: 1 }],
            energy: 0, raceSpeed: 0, biology: 0, isAllianceMove: false,
        });
        leg = r.body && r.body.legs && r.body.legs[0];
        ok('isAllianceMove is true for a planet owned by an allied-tag alliance', leg && leg.isAllianceMove === true, leg);
        ok('autoAllianceMove is true', leg && leg.autoAllianceMove === true, leg);

        console.log('\n── A leg to an unrelated alliance\'s planet is NOT halved ' + '─'.repeat(16));
        r = await preview({
            waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 4, planetIndex: 1 }],
            energy: 0, raceSpeed: 0, biology: 0, isAllianceMove: false,
        });
        leg = r.body && r.body.legs && r.body.legs[0];
        ok('isAllianceMove is false for an unrelated/enemy owner', leg && leg.isAllianceMove === false, leg);
        ok('autoAllianceMove is false', leg && leg.autoAllianceMove === false, leg);

        console.log('\n── A leg to a never-scanned planet is NOT halved by default ' + '─'.repeat(12));
        r = await preview({
            waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 5, planetIndex: 1 }],
            energy: 0, raceSpeed: 0, biology: 0, isAllianceMove: false,
        });
        leg = r.body && r.body.legs && r.body.legs[0];
        ok('isAllianceMove is false — no data to auto-detect from', leg && leg.isAllianceMove === false, leg);

        console.log('\n── ...but the manual checkbox still overrides for that same destination ' + '─'.repeat(3));
        r = await preview({
            waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 5, planetIndex: 1 }],
            energy: 0, raceSpeed: 0, biology: 0, isAllianceMove: true,
        });
        leg = r.body && r.body.legs && r.body.legs[0];
        ok('isAllianceMove is true (forced by the checkbox)', leg && leg.isAllianceMove === true, leg);
        ok('autoAllianceMove stays false (it was not auto-detected — the checkbox forced it)',
            leg && leg.autoAllianceMove === false, leg);

        console.log('\n── A multi-leg route auto-detects EACH leg independently ' + '─'.repeat(15));
        r = await preview({
            waypoints: [
                { systemId: 1, planetIndex: 1 },  // home
                { systemId: 2, planetIndex: 1 },  // -> own alliance (should halve)
                { systemId: 4, planetIndex: 1 },  // -> enemy (should NOT halve)
            ],
            energy: 0, raceSpeed: 0, biology: 0, isAllianceMove: false,
        });
        ok('responds 200 for the 2-leg route', r.status === 200, r.body);
        const legs = r.body && r.body.legs;
        ok('leg 1 (to own alliance) is halved', legs && legs[0].isAllianceMove === true, legs);
        ok('leg 2 (to enemy) is NOT halved, independently of leg 1', legs && legs[1].isAllianceMove === false, legs);
    } finally {
        server.close();
    }

    if (fail > 0) {
        console.error(`\n${fail} check(s) failed, ${pass} passed`);
        process.exit(1);
    }
    console.log(`\nAll ${pass} checks passed`);
})().catch((err) => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
