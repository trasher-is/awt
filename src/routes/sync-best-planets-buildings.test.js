// Entirely synthetic Best Planets snapshots. Exercise the existing sync route, additive
// migration, and the read endpoint together so an older tab cannot retain stale leaders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const express = require('express');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-unicorn-buildings-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

// Simulate upgrading a real pre-feature schema without changing or capturing any game data.
const oldDb = new Database(process.env.AWT_DB_PATH);
oldDb.exec(`CREATE TABLE best_planets_snapshot (
    game_planet_id INTEGER PRIMARY KEY, rank INTEGER NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO best_planets_snapshot VALUES (9000, 1, '2026-09-01T12:00:00.000Z');`);
oldDb.close();

// No Discord calls are part of this test, including the existing coverage announcement.
require.cache[require.resolve('../discord_bot')] = { exports: {
    announceSystemChanges() {}, announceSystemMilestones() {},
    sendVariousChangeEmbed: async () => {},
} };
const db = require('../database');
const syncRouter = require('./sync');
const unicornRouter = require('./unicorn');

let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else {
        failed++;
        console.error(`  NOT OK - ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
    }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, role: 'user' }; next(); });
app.use('/hub-api', syncRouter, unicornRouter);

function request(server, rows) {
    return new Promise((resolve, reject) => {
        const sending = rows !== undefined;
        const payload = sending ? JSON.stringify({ rows }) : null;
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
            path: sending ? '/hub-api/sync/best-planets-snapshot' : '/hub-api/intel/unicorn',
            method: sending ? 'POST' : 'GET',
            headers: sending ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(raw); } catch (_) { /* body stays null */ }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function fullRanking() {
    return Array.from({ length: 50 }, (_, i) => ({
        game_planet_id: 10001 + i, rank: i + 1,
        buildings: { HF: i + 1, RF: i + 1, GC: 0, RL: 100 - i },
    }));
}

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const old = db.prepare('SELECT * FROM best_planets_snapshot WHERE game_planet_id = 9000').get();
        ok('migration preserves old ranking identity and timestamp with unknown buildings',
            old.rank === 1 && old.updated_at === '2026-09-01T12:00:00.000Z'
            && ['hf', 'rf', 'gc', 'rl'].every(field => old[field] === null), old);
        db.exec(`INSERT INTO systems (id, name, x, y) VALUES (7, 'Synthetic Leader Field', 1, 2);
            INSERT INTO planets (game_planet_id, system_id, planet_index) VALUES
                (10001, 7, 1), (10007, 7, 7);`);

        let rows = fullRanking();
        rows[6].buildings.HF = 200;
        rows[7].buildings.HF = 200;
        rows[6].buildings.RF = 300;
        rows[49].buildings.RL = 400;
        let response = await request(server, rows);
        ok('complete building snapshot is accepted', response.status === 200 && response.body.success, response);
        let data = (await request(server)).body;
        ok('a full 50-entry snapshot establishes all four category leaders', data.total === 50
            && data.leaders_status === 'complete' && data.leaders.length === 4
            && Object.values(data.leader_coverage).every(n => n === 50), data);
        const byKind = Object.fromEntries(data.leaders.map(leader => [leader.kind, leader]));
        ok('equal HF levels select the lower Best Planets rank deterministically',
            byKind.HF.level === 200 && byKind.HF.rank === 7 && byKind.HF.game_planet_id === 10007, byKind.HF);
        ok('one planet can lead several categories', byKind.RF.game_planet_id === byKind.HF.game_planet_id
            && byKind.RF.level === 300, byKind.RF);
        ok('zero is a valid level and the all-zero tie chooses rank 1',
            byKind.GC.level === 0 && byKind.GC.rank === 1, byKind.GC);
        ok('unmapped winners retain their ID but have no invented map location',
            byKind.RL.game_planet_id === 10050 && byKind.RL.system_id === null && byKind.RL.planet_index === null, byKind.RL);

        rows[0].buildings.HF = null;
        await request(server, rows);
        data = (await request(server)).body;
        ok('one unread HF removes only the HF claim, keeping independent complete categories',
            data.leaders_status === 'incomplete' && data.leaders.length === 3
            && !data.leaders.some(leader => leader.kind === 'HF') && data.leader_coverage.HF === 49, data);

        rows = fullRanking();
        rows[0].buildings = { HF: '900', RF: true, GC: -1, RL: 1000001 };
        await request(server, rows);
        data = (await request(server)).body;
        const invalid = db.prepare('SELECT hf, rf, gc, rl FROM best_planets_snapshot WHERE rank = 1').get();
        ok('string, boolean, negative and excessive levels become unknown, not numeric claims',
            Object.values(invalid).every(value => value === null)
            && data.leaders.length === 0 && data.leaders_status === 'incomplete'
            && Object.values(data.leader_coverage).every(n => n === 49), { invalid, data });
        rows[0].buildings = { HF: 1.5, RF: null, RL: 0 };
        rows[1].buildings = [];
        await request(server, rows);
        data = (await request(server)).body;
        ok('fractional, omitted, null and array-shaped observations fail closed',
            data.leader_coverage.HF === 48 && data.leader_coverage.RF === 48
            && data.leader_coverage.GC === 48 && data.leader_coverage.RL === 49 && data.leaders.length === 0, data);

        rows = fullRanking().slice(0, 20);
        await request(server, rows);
        data = (await request(server)).body;
        ok('20 complete rows do not masquerade as leaders of the whole Top 50', data.total === 20
            && data.leaders.length === 0 && data.leaders_status === 'incomplete'
            && Object.values(data.leader_coverage).every(n => n === 20), data);

        rows = fullRanking();
        rows[49].rank = 49;
        await request(server, rows);
        data = (await request(server)).body;
        ok('50 rows with a duplicate rank and a missing rank cannot establish winners',
            data.total === 50 && data.leaders.length === 0 && data.leaders_status === 'incomplete', data);

        await request(server, fullRanking());
        rows = fullRanking().map(({ buildings, ...row }) => row);
        response = await request(server, rows);
        data = (await request(server)).body;
        ok('legacy rank-and-ID clients remain compatible', response.status === 200
            && response.body.success && data.total === 50, response);
        ok('a later legacy snapshot clears every previously captured building value',
            db.prepare('SELECT COUNT(*) AS n FROM best_planets_snapshot WHERE hf IS NOT NULL OR rf IS NOT NULL OR gc IS NOT NULL OR rl IS NOT NULL').get().n === 0
            && data.leaders.length === 0 && data.leaders_status === 'unavailable'
            && Object.values(data.leader_coverage).every(n => n === 0), data);
    } catch (err) {
        failed++;
        console.error('  NOT OK - unexpected error:', err);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log(`\nsync-best-planets-buildings.test.js: ${failed ? 'FAILED' : 'all passed'} (${failed} failures)`);
    process.exitCode = failed ? 1 : 0;
})();
