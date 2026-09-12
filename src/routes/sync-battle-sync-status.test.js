// Regression coverage for the battle-sync status the dashboard reads back (2026-09-12):
// since battle-sync.js now pulls once a day instead of every 30 min, a member needs a way
// to confirm the daily pull actually happened and how many reports it found, not just
// infer freshness from watermark staleness. /sync/battle-reports now records this on every
// successful sync; /sync/battle-reports-watermark exposes it alongside the watermark.
//
// Run with: node src/routes/sync-battle-sync-status.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-battle-status-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

const express = require('express');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-battle-sync-status.test.js');

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
        console.log('\n── Before any sync has ever run ' + '─'.repeat(43));
        const empty = await request(server, 'GET', '/hub-api/sync/battle-reports-watermark');
        ok('succeeds (200)', empty.status === 200, empty.body);
        ok('no watermark yet', empty.body.newest_started_at === null, empty.body);
        ok('no last_run_at yet', empty.body.last_run_at === null, empty.body);
        ok('no last_inserted_count yet', empty.body.last_inserted_count === null, empty.body);

        console.log('\n── After a sync that inserts new reports ' + '─'.repeat(34));
        const before = Date.now();
        const syncRes = await request(server, 'POST', '/hub-api/sync/battle-reports', {
            reports: [{
                id: 91001, startedAt: '2026-09-11T09:00:00Z',
                attacker: { playerName: 'Attacker', allianceTag: 'RAID' },
                defender: { playerName: 'Defender', allianceTag: 'ENEMY' },
                winner: 'attacker', killedPopulation: 5,
            }],
        });
        ok('sync succeeds', syncRes.status === 200 && syncRes.body.success, syncRes.body);
        const after = Date.now();

        const status = await request(server, 'GET', '/hub-api/sync/battle-reports-watermark');
        ok('last_run_at is now set, close to now', status.body.last_run_at !== null
            && Date.parse(status.body.last_run_at) >= before - 1000 && Date.parse(status.body.last_run_at) <= after + 1000,
            status.body);
        ok('last_inserted_count reflects the sync (1 new report)', status.body.last_inserted_count === 1, status.body);
        ok('watermark advanced to the new report\'s started_at', status.body.newest_started_at != null, status.body);

        console.log('\n── A re-sync of the same report inserts nothing, but still records the run ' + '─'.repeat(2));
        const resyncRes = await request(server, 'POST', '/hub-api/sync/battle-reports', {
            reports: [{
                id: 91001, startedAt: '2026-09-11T09:00:00Z',
                attacker: { playerName: 'Attacker', allianceTag: 'RAID' },
                defender: { playerName: 'Defender', allianceTag: 'ENEMY' },
                winner: 'attacker', killedPopulation: 5,
            }],
        });
        ok('re-sync succeeds', resyncRes.status === 200 && resyncRes.body.success, resyncRes.body);
        const afterResync = await request(server, 'GET', '/hub-api/sync/battle-reports-watermark');
        ok('last_inserted_count now reflects the re-sync (0 new)', afterResync.body.last_inserted_count === 0, afterResync.body);
        ok('last_run_at advanced past the first run', Date.parse(afterResync.body.last_run_at) >= Date.parse(status.body.last_run_at), afterResync.body);
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
