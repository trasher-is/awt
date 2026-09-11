// Route-level coverage for the bonus-goals sync endpoints added to sync.js
// (/sync/bonus-goals/ranking-targets, /sync/bonus-goals/ranking-snapshot) and for the hook
// into /sync/battle-report-ship-detail that evaluates a report against active
// ranking_match goals once its location is known. The engine's own logic (tier math,
// dedupe, scoping) has thorough unit coverage in bonusGoals.test.js; this file exists to
// confirm the routes actually wire it up correctly.
//
// Run with: node src/routes/sync-bonus-goals.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-bonus-goals-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const bonusGoalsRepo = require('../repositories/bonusGoals');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-bonus-goals.test.js');

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
        console.log('\n── ranking-targets: which enabled goals need a re-scrape ' + '─'.repeat(10));
        const emptyTargets = await request(server, 'GET', '/hub-api/sync/bonus-goals/ranking-targets');
        ok('succeeds (200) with no goals at all', emptyTargets.status === 200 && emptyTargets.body.targets.length === 0, emptyTargets.body);

        const goal = bonusGoalsRepo.createGoal({
            type: 'ranking_match', name: 'route test',
            config: { ranking_path: '/Ranking/Fake', tier_size: 5, tier_start_points: 100, tier_step: -5, max_rank: 50 },
            enabled: true,
        });
        const withTarget = await request(server, 'GET', '/hub-api/sync/bonus-goals/ranking-targets');
        ok('a newly-created enabled goal with no snapshot yet shows up as a target',
            withTarget.body.targets.some(t => t.goal_id === goal.id), withTarget.body);
        ok('the target carries its config (so the client knows what page to fetch)',
            withTarget.body.targets.find(t => t.goal_id === goal.id).config.ranking_path === '/Ranking/Fake', withTarget.body);

        console.log('\n── ranking-snapshot: ingest + resolve ' + '─'.repeat(20));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (700, 'Sync Test System', 2, 2)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, name) VALUES (55001, 700, 1, 'RouteTestPlanet')`).run();

        const snapRes = await request(server, 'POST', '/hub-api/sync/bonus-goals/ranking-snapshot', {
            goal_id: goal.id,
            rows: [
                { rank: 1, game_planet_id: 55001, owner_name: 'Someone', owner_alliance_tag: 'TAG' },
                { rank: 2 }, // malformed (no game_planet_id) — must be dropped, not crash the whole batch
            ],
        });
        ok('snapshot sync succeeds', snapRes.status === 200 && snapRes.body.success, snapRes.body);
        ok('only the well-formed row was stored (the malformed one dropped silently)', snapRes.body.count === 1, snapRes.body);

        const stored = db.prepare(`SELECT * FROM ranking_snapshot_rows WHERE goal_id = ?`).get(goal.id);
        ok('the stored row resolved system_id/planet_index from game_planet_id',
            stored.system_id === 700 && stored.planet_index === 1, stored);

        const targetsAfterSnapshot = await request(server, 'GET', '/hub-api/sync/bonus-goals/ranking-targets');
        ok('the goal no longer needs a re-scrape right after a fresh snapshot',
            !targetsAfterSnapshot.body.targets.some(t => t.goal_id === goal.id), targetsAfterSnapshot.body);

        const badPayload = await request(server, 'POST', '/hub-api/sync/bonus-goals/ranking-snapshot', { goal_id: 'not-a-number', rows: [] });
        ok('a non-integer goal_id is rejected (400)', badPayload.status === 400, badPayload);

        console.log('\n── ship-detail sync triggers goal evaluation once location is known ' + '─'.repeat(4));
        db.prepare(`INSERT INTO players (id, name) VALUES (800, 'ShipDetailAttacker')`).run();
        db.prepare(`
            INSERT INTO battle_reports (id, started_at, att_player_id, att_player_name, def_lost_cv, killed_population)
            VALUES (77001, '2026-09-11T09:00:00Z', 800, 'ShipDetailAttacker', 300, 8)
        `).run();

        const shipDetailRes = await request(server, 'POST', '/hub-api/sync/battle-report-ship-detail', {
            id: 77001,
            system_id: 700, planet_index: 1, // matches the ranked planet from the snapshot above
            att_destroyers: 5, att_destroyers_lost: 1,
        });
        ok('ship-detail sync itself still succeeds', shipDetailRes.status === 200 && shipDetailRes.body.success, shipDetailRes.body);

        const award = db.prepare(`SELECT * FROM bonus_goal_awards WHERE goal_id = ? AND source_key = ?`).get(goal.id, 'br:77001');
        ok('the ship-detail sync triggered goal evaluation and credited the rank-1 tier (100 pts)',
            award && award.player_id === 800 && award.points === 100, award);
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
