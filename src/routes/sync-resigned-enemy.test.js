// Regression coverage for the "resigned/returned enemy" check added to /sync/player-list
// (2026-09-12, Various Changes): scoped to players with a KNOWN non-friendly alliance —
// not random unaffiliated churn, which would be extremely noisy — and only fires on the
// actual 'N/A' transition (either direction), reusing the game's own resign signal.
//
// discord_bot.js's sendVariousChangeEmbed is mocked (same require.cache technique as
// sync-population.test.js / sync-friendly-fire.test.js) so this test can observe WHEN
// it's called.
//
// Run with: node src/routes/sync-resigned-enemy.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-resigned-enemy-test-')), 'test.db');
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

console.log('sync-resigned-enemy.test.js');

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
        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders'), (2, 'FOE', 'Enemies')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id, joined) VALUES
            (701, 'RaidMember', 1, '2026-01-01'),
            (702, 'EnemyOne', 2, '2026-01-01'),
            (703, 'Unaffiliated', NULL, '2026-01-01')`).run();
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (701)`).run(); // RAID = own alliance

        console.log('\n── An enemy resigning (joined -> N/A) is flagged ' + '─'.repeat(24));
        await request(server, 'POST', '/hub-api/sync/player-list', {
            players: [{ id: 702, name: 'EnemyOne', alliance_id: 2, joined: 'N/A' }],
        });
        const resignAlerts = () => calls.filter(c => c.title.includes('resigned'));
        ok('exactly one resign alert fires', resignAlerts().length === 1, calls);
        ok('names the enemy with their tag', /\[FOE\] EnemyOne/.test(resignAlerts()[0].description), calls);

        console.log('\n── The same enemy re-syncing as still N/A does not re-fire ' + '─'.repeat(14));
        calls.length = 0;
        await request(server, 'POST', '/hub-api/sync/player-list', {
            players: [{ id: 702, name: 'EnemyOne', alliance_id: 2, joined: 'N/A' }],
        });
        ok('no repeat alert for an unchanged N/A state', resignAlerts().length === 0, calls);

        console.log('\n── That same enemy rejoining (N/A -> real date) is flagged the other way ' + '─'.repeat(4));
        calls.length = 0;
        await request(server, 'POST', '/hub-api/sync/player-list', {
            players: [{ id: 702, name: 'EnemyOne', alliance_id: 2, joined: '2026-09-12' }],
        });
        const returnAlerts = () => calls.filter(c => c.title.includes('returned'));
        ok('exactly one return alert fires', returnAlerts().length === 1, calls);

        console.log('\n── A RAID (friendly) member resigning is NOT flagged ' + '─'.repeat(21));
        calls.length = 0;
        await request(server, 'POST', '/hub-api/sync/player-list', {
            players: [{ id: 701, name: 'RaidMember', alliance_id: 1, joined: 'N/A' }],
        });
        ok('no alert for a friendly resignation', calls.length === 0, calls);

        console.log('\n── An unaffiliated player resigning is NOT flagged (no known enemy alliance) ' + '─'.repeat(1));
        calls.length = 0;
        await request(server, 'POST', '/hub-api/sync/player-list', {
            players: [{ id: 703, name: 'Unaffiliated', joined: 'N/A' }],
        });
        ok('no alert for an unaffiliated player', calls.length === 0, calls);

        console.log('\n── A brand-new player row (never seen before) cannot fire (nothing to compare against) ' + '─'.repeat(1));
        calls.length = 0;
        await request(server, 'POST', '/hub-api/sync/player-list', {
            players: [{ id: 999, name: 'BrandNew', alliance_id: 2, joined: 'N/A' }],
        });
        ok('no alert on first-ever sight of a player', calls.length === 0, calls);
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
