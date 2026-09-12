// Regression coverage for /sync/best-planets-snapshot (2026-09-12, Various Changes) --
// deliberately separate from the SECRET bonus-goals ranking_match mechanism even though
// both watch /Ranking/BestPlanets. This is public and aggregate-only: "how many of the
// current snapshot are friendly-owned", resolved via our own synced ownership, never the
// ranking page's own owner text.
//
// Run with: node src/routes/sync-best-planets-coverage.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-best-planets-test-')), 'test.db');
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

console.log('sync-best-planets-coverage.test.js');

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
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (811, 'Holder', 1), (812, 'Neighbor', 2)`).run();
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (811)`).run();
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (970, 'A', 0, 0), (971, 'B', 1, 1)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES
            (97001, 970, 1, 811, 5), (97101, 971, 1, 812, 6)`).run();

        console.log('\n── An invalid payload is rejected ' + '─'.repeat(41));
        const badRes = await request(server, 'POST', '/hub-api/sync/best-planets-snapshot', {});
        ok('missing rows is a 400', badRes.status === 400, badRes.body);

        console.log('\n── First snapshot: coverage recomputed and stored ' + '─'.repeat(24));
        const firstRes = await request(server, 'POST', '/hub-api/sync/best-planets-snapshot', {
            rows: [{ rank: 1, game_planet_id: 97001 }, { rank: 2, game_planet_id: 97101 }],
        });
        ok('sync succeeds', firstRes.status === 200 && firstRes.body.success, firstRes.body);
        const snapshotRows = db.prepare(`SELECT COUNT(*) as n FROM best_planets_snapshot`).get().n;
        ok('both rows are stored', snapshotRows === 2, snapshotRows);

        console.log('\n── A re-sync with unchanged coverage does not throw ' + '─'.repeat(22));
        const secondRes = await request(server, 'POST', '/hub-api/sync/best-planets-snapshot', {
            rows: [{ rank: 1, game_planet_id: 97001 }, { rank: 2, game_planet_id: 97101 }],
        });
        ok('re-sync still succeeds (idempotent, no dedup gate needed)', secondRes.status === 200 && secondRes.body.success, secondRes.body);

        console.log('\n── Coverage changing when a planet is added to the snapshot ' + '─'.repeat(12));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (972, 'C', 2, 2)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (97201, 972, 1, 811, 4)`).run();
        const thirdRes = await request(server, 'POST', '/hub-api/sync/best-planets-snapshot', {
            rows: [{ rank: 1, game_planet_id: 97001 }, { rank: 2, game_planet_id: 97101 }, { rank: 3, game_planet_id: 97201 }],
        });
        ok('sync with a new friendly-owned entry succeeds', thirdRes.status === 200 && thirdRes.body.success, thirdRes.body);
        const snapshotAfterThird = db.prepare(`SELECT COUNT(*) as n FROM best_planets_snapshot`).get().n;
        ok('the snapshot now has all three rows', snapshotAfterThird === 3, snapshotAfterThird);

        const lastAnnounced = db.prepare(`SELECT value FROM app_settings WHERE key = 'best_planets_friendly_count_last_announced'`).get();
        ok('the last-announced friendly count was recorded (2 RAID-owned planets)', lastAnnounced && lastAnnounced.value === '2', lastAnnounced);
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
