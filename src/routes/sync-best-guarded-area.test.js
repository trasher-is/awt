// Regression coverage for the Various Changes area-diff wired into /sync/best-guarded
// (2026-09-12): "all top50 in the area", not just #1/top10 -- the full Best Guarded
// snapshot gets filtered to planets owned by, or within BEST_GUARDED_AREA_RADIUS systems
// of, friendly territory, and only the entered/left diff against last time is worth
// announcing. Drives the REAL route end-to-end; DISCORD_TOKEN is unset so the announcer
// safely no-ops (client.isReady() false) -- what this test can observe is that the route
// never throws and best_guarded_area_watch ends up right. getBestGuardedInArea/
// diffAndReplaceBestGuardedAreaWatch have their own full unit coverage in systems.test.js.
//
// Run with: node src/routes/sync-best-guarded-area.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-best-guarded-test-')), 'test.db');
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

console.log('sync-best-guarded-area.test.js');

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
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (801, 'Holder', 1), (802, 'Neighbor', 2)`).run();
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (801)`).run(); // own-alliance detection
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (960, 'Our System', 0, 0), (961, 'Nearby System', 3, 0), (962, 'Far System', 200, 200)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase) VALUES
            (96001, 960, 1, 801, 5, 3),
            (96101, 961, 1, 802, 6, 4),
            (96201, 962, 1, 802, 7, 5)`).run();

        console.log('\n── First sync: everything in area is newly entered ' + '─'.repeat(20));
        const firstRes = await request(server, 'POST', '/hub-api/sync/best-guarded', {
            last_update: '2026-09-12T00:05:00Z',
            entries: [
                { planet_id: 96001, cv: '5K' }, // our own system
                { planet_id: 96101, cv: '9K' }, // 3 systems away — inside radius 6
                { planet_id: 96201, cv: '40K' }, // far away — outside radius
            ],
        });
        ok('sync succeeds', firstRes.status === 200 && firstRes.body.success && !firstRes.body.skipped, firstRes.body);

        const watchAfterFirst = db.prepare(`SELECT game_planet_id FROM best_guarded_area_watch ORDER BY game_planet_id`).all().map(r => r.game_planet_id);
        ok('the watch table holds exactly the two in-area planets, not the far one',
            JSON.stringify(watchAfterFirst) === JSON.stringify([96001, 96101]), watchAfterFirst);

        console.log('\n── Re-syncing the same last_update is skipped, not re-processed ' + '─'.repeat(6));
        const skipRes = await request(server, 'POST', '/hub-api/sync/best-guarded', {
            last_update: '2026-09-12T00:05:00Z',
            entries: [{ planet_id: 96001, cv: '5K' }],
        });
        ok('the sync reports skipped:true (same daily tick already processed)', skipRes.body.skipped === true, skipRes.body);

        console.log('\n── A later sync where the nearby planet drops off ' + '─'.repeat(24));
        const secondRes = await request(server, 'POST', '/hub-api/sync/best-guarded', {
            last_update: '2026-09-13T00:05:00Z',
            entries: [{ planet_id: 96001, cv: '5K' }],
        });
        ok('the second day\'s sync succeeds', secondRes.status === 200 && secondRes.body.success, secondRes.body);
        const watchAfterSecond = db.prepare(`SELECT game_planet_id FROM best_guarded_area_watch`).all().map(r => r.game_planet_id);
        ok('the watch table now reflects only what is still on the list', JSON.stringify(watchAfterSecond) === '[96001]', watchAfterSecond);
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
