// Regression coverage for the per-system Discord milestone plumbing added to /sync/system
// (2026-09-12): SIEGE_STARTED detection (is_sieged 0->1), the raw new_owner_alliance_tag
// carried on OWNER_CHANGE events, and the "system secured" transition
// (systemsRepo.checkAndUpdateSystemSecured) that feeds announceSystemMilestones.
//
// This drives the REAL /sync/system route end-to-end against a scratch sqlite database,
// with DISCORD_TOKEN unset so the bot never connects — announceSystemChanges/
// announceSystemMilestones correctly no-op in that state (client.isReady() is false), so
// what this test can actually observe is: the route never throws (a bug in the new event-
// building code would otherwise surface as a 500), and the systems.is_secured column ends
// up right. The wording/filtering logic itself (buildSystemMilestoneLines) has its own
// full unit coverage in system-change-lines.test.js.
//
// Run with: node src/routes/sync-system-milestones.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-system-milestones-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-system-milestones.test.js');

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
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders'), (2, 'FOE', 'Enemies')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (701, 'Holder', 1), (702, 'Raider', 2)`).run();
        // friendlyAllianceTags() derives "own alliance" from alliance_member_stats (the
        // per-member sheet a real alliance-page scan populates) — without a row there, RAID
        // would never resolve as friendly, so "secured" could never fire in this test.
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (701)`).run();
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (950, 'Milestone Test System', 3, 3)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, is_sieged) VALUES (95001, 950, 1, 701, 5, 0, 0)`).run();

        console.log('\n── A siege appearing does not crash the route ' + '─'.repeat(29));
        const siegeRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 5, starbase: 0, is_sieged: 1 }],
        });
        ok('sync succeeds (200), the new SIEGE_STARTED push does not throw', siegeRes.status === 200 && siegeRes.body.success, siegeRes.body);
        const sieged = db.prepare(`SELECT is_sieged FROM planets WHERE game_planet_id = 95001`).get();
        ok('is_sieged is now stored as 1', sieged.is_sieged === 1, sieged);

        console.log('\n── An enemy conquest carries the raw alliance tag without crashing ' + '─'.repeat(6));
        const conquestRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 702, name: 'Raider', alliance_tag: 'FOE' }, population: 3, starbase: 0, is_sieged: 0 }],
        });
        ok('sync succeeds — new_owner_alliance_tag field does not break anything', conquestRes.status === 200 && conquestRes.body.success, conquestRes.body);
        const conquered = db.prepare(`SELECT owner_id FROM planets WHERE game_planet_id = 95001`).get();
        ok('ownership actually transferred to the enemy', conquered.owner_id === 702, conquered);

        console.log('\n── System-secured transition, end to end through the real route ' + '─'.repeat(8));
        const retakeRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 701, name: 'Holder', alliance_tag: 'RAID' }, population: 4, starbase: 0, is_sieged: 0 }],
        });
        ok('re-taking the only planet succeeds', retakeRes.status === 200 && retakeRes.body.success, retakeRes.body);
        const securedRow = db.prepare(`SELECT is_secured FROM systems WHERE id = 950`).get();
        ok('the system is now marked secured — every real owner (just RAID) is friendly',
            securedRow.is_secured === 1, securedRow);

        console.log('\n── Losing it again clears the secured flag, silently ' + '─'.repeat(20));
        const loseRes = await request(server, 'POST', '/hub-api/sync/system', {
            system_id: 950,
            planets: [{ game_planet_id: 95001, planet_index: 1, owner: { id: 702, name: 'Raider', alliance_tag: 'FOE' }, population: 2, starbase: 0, is_sieged: 0 }],
        });
        ok('the enemy retaking it succeeds', loseRes.status === 200 && loseRes.body.success, loseRes.body);
        const unsecuredRow = db.prepare(`SELECT is_secured FROM systems WHERE id = 950`).get();
        ok('is_secured is cleared back to 0', unsecuredRow.is_secured === 0, unsecuredRow);
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
