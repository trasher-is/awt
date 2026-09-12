// Regression coverage for the "possible friendly-fire / NAP violation" check added to
// /sync/system (2026-09-12, Various Changes): real damage only (a conquest, or a
// bombardment with a confidently matched attacker) between two friendly tags -- NOT just
// any battle report existing between friendlies, since routine XP-farming duels don't
// actually take territory or kill population.
//
// discord_bot.js's sendVariousChangeEmbed is mocked (same require.cache technique as
// sync-population.test.js) so this test can observe WHEN it's called, not just that the
// route doesn't crash.
//
// Run with: node src/routes/sync-friendly-fire.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-friendly-fire-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const calls = [];
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = {
    id: botPath, filename: botPath, loaded: true, exports: {
        announceSystemChanges: async () => {},
        announceSystemMilestones: async () => {},
        sendVariousChangeEmbed: async (title, description) => { calls.push({ title, description }); },
    },
};

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-friendly-fire.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);

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
            res.on('end', () => { resolve({ status: res.statusCode }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders'), (2, 'NAP1', 'Allies'), (3, 'FOE', 'Enemies')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (601, 'RaidHolder', 1), (602, 'NapAttacker', 2), (603, 'FoeAttacker', 3)`).run();
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (601)`).run(); // RAID = own alliance
        db.prepare(`INSERT INTO app_settings (key, value) VALUES ('alliance_relations_allied', 'NAP1')`).run();
        await new Promise(r => setTimeout(r, 0)); // let settings write land before the sync reads it

        console.log('\n── An enemy conquering a friendly planet is NOT flagged as friendly-fire ' + '─'.repeat(2));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (930, 'FF Test A', 5, 5)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (93001, 930, 1, 601, 5)`).run();
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 930,
            planets: [{ game_planet_id: 93001, planet_index: 1, owner: { id: 603, name: 'FoeAttacker', alliance_tag: 'FOE' }, population: 3, starbase: 0 }],
        });
        ok('no friendly-fire alert for an enemy conquest', calls.length === 0, calls);

        console.log('\n── A NAP ally conquering a RAID planet IS flagged ' + '─'.repeat(22));
        calls.length = 0;
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (931, 'FF Test B', 6, 6)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (93101, 931, 1, 601, 5)`).run();
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 931,
            planets: [{ game_planet_id: 93101, planet_index: 1, owner: { id: 602, name: 'NapAttacker', alliance_tag: 'NAP1' }, population: 3, starbase: 0 }],
        });
        const fireAlerts = () => calls.filter(c => c.title.includes('friendly-fire'));
        ok('exactly one friendly-fire alert fires (a secured-systems milestone may also fire alongside it)',
            fireAlerts().length === 1, calls);
        ok('the alert names both friendly parties', /NapAttacker/.test(fireAlerts()[0].description) && /RaidHolder/.test(fireAlerts()[0].description), calls);

        console.log('\n── An enemy taking an enemy\'s planet is NOT flagged (nobody friendly involved) ' + '─'.repeat(1));
        calls.length = 0;
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (932, 'FF Test C', 7, 7)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (93201, 932, 1, 603, 4)`).run();
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 932,
            planets: [{ game_planet_id: 93201, planet_index: 1, owner: { id: 602, name: 'NapAttacker', alliance_tag: 'NAP1' }, population: 2, starbase: 0 }],
        });
        ok('no friendly-fire alert when the VICTIM was not friendly', fireAlerts().length === 0, calls);

        console.log('\n── A bombardment (same owner, matched attacker) between friendlies IS flagged ' + '─'.repeat(2));
        calls.length = 0;
        const scannedAt = new Date(Date.now() - 20 * 60000).toISOString();
        const reportAt = new Date(Date.now() - 10 * 60000).toISOString();
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (933, 'FF Test D', 8, 8)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, updated_at) VALUES (93301, 933, 1, 601, 9, ?)`).run(scannedAt);
        db.prepare(`INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_id, att_player_name, att_alliance_tag, def_player_id, killed_population, winner)
            VALUES (50001, ?, 933, 1, 602, 'NapAttacker', 'NAP1', 601, 4, 'Attacker')`).run(reportAt);
        await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 933,
            planets: [{ planet_index: 1, owner: { id: 601, name: 'RaidHolder', alliance_tag: 'RAID' }, population: 5, starbase: 0 }],
        });
        ok('exactly one friendly-fire alert fires for the matched bombardment', fireAlerts().length === 1, calls);
        ok('the bombardment alert names the attacker and victim', fireAlerts()[0] && /NapAttacker/.test(fireAlerts()[0].description) && /RaidHolder/.test(fireAlerts()[0].description), calls);
    } finally {
        server.close();
    }

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
