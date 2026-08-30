// Route-level coverage for the player API-scan claim/status pair added alongside the
// "Deep scan" button (2026-08-30): /sync/player-scan-claim hands out stale player ids and
// bumps last_api_scan_at (an optimistic claim, not a reservation — see that route's own
// comment), and /sync/player-scan-status is its read-only counterpart that feeds the
// button's status line. This test exists mainly to confirm the two never disagree: the
// stale count status reports must always match what a claim of the same size would
// actually hand out, since a status line that lied about "how many left" would be worse
// than no status line at all.
//
// Run with: node src/routes/sync-player-scan.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-player-scan-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const playersRepo = require('../repositories/players');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-player-scan.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);

function request(server, method, urlPath) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── status before anything is on record ' + '─'.repeat(20));
        const emptyStatus = await request(server, 'GET', '/hub-api/sync/player-scan-status');
        ok('status succeeds (200) with an empty players table', emptyStatus.status === 200, emptyStatus);
        ok('total is 0 with no players', emptyStatus.body.total === 0, emptyStatus.body);
        ok('stale is 0 with no players (nothing to claim)', emptyStatus.body.stale === 0, emptyStatus.body);
        ok('last_scan_at is null with no players', emptyStatus.body.last_scan_at === null, emptyStatus.body);

        console.log('\n── claim reduces the stale count status reports next ' + '─'.repeat(10));
        playersRepo.upsertPlayerFromApiList(801, 'Alpha', null, 5, 100, null, null, 1, null);
        playersRepo.upsertPlayerFromApiList(802, 'Beta', null, 5, 100, null, null, 1, null);
        playersRepo.upsertPlayerFromApiList(803, 'Gamma', null, 5, 100, null, null, 1, null);

        const statusBefore = await request(server, 'GET', '/hub-api/sync/player-scan-status');
        ok('status reports total=3 after seeding 3 players', statusBefore.body.total === 3, statusBefore.body);
        ok('status reports all 3 as stale (never scanned)', statusBefore.body.stale === 3, statusBefore.body);

        const claimRes = await request(server, 'POST', '/hub-api/sync/player-scan-claim?limit=2');
        ok('claim succeeds (200)', claimRes.status === 200, claimRes);
        ok('claim hands out exactly 2 of the 3 stale ids (limit respected)', claimRes.body.ids.length === 2, claimRes.body);

        const statusAfter = await request(server, 'GET', '/hub-api/sync/player-scan-status');
        ok('status total unchanged by a claim', statusAfter.body.total === 3, statusAfter.body);
        ok('status stale count dropped by exactly the number claimed — status and claim never disagree',
            statusAfter.body.stale === 3 - claimRes.body.ids.length, statusAfter.body);
        ok('status now reports a non-null last_scan_at (the claim just bumped one)',
            statusAfter.body.last_scan_at != null, statusAfter.body);

        console.log('\n── a second claim picks up the remaining stale id, not the just-claimed ones ' + '─'.repeat(2));
        const claimRes2 = await request(server, 'POST', '/hub-api/sync/player-scan-claim?limit=10');
        ok('second claim only gets the 1 still-stale id, not all 3 again', claimRes2.body.ids.length === 1, claimRes2.body);
        ok('the still-stale id is the one NOT in the first claim',
            !claimRes.body.ids.includes(claimRes2.body.ids[0]), { first: claimRes.body.ids, second: claimRes2.body.ids });

        const statusFinal = await request(server, 'GET', '/hub-api/sync/player-scan-status');
        ok('status stale count reaches 0 once every player has been claimed', statusFinal.body.stale === 0, statusFinal.body);
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
