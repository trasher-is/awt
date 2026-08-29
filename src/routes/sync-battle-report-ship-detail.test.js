// Regression test for finding 6 of the final-review fix wave (2026-08-29): POST
// /sync/battle-report-ship-detail passed the request body straight into
// battleReportsRepo.updateShipDetail with no per-field coercion, so a string value could
// bind directly into an INTEGER column. Drives the REAL route end-to-end (express app +
// http server + fetch) against a scratch sqlite database, exactly like sync-system.test.js.
//
// Run with: node src/routes/sync-battle-report-ship-detail.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-brsd-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
// Never attempt a real Discord login in a test process.
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-battle-report-ship-detail.test.js');

const app = express();
app.use(express.json());
// Stand-in for a logged-in session — requireAuth only checks req.session.userId.
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);

function postJson(server, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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
        req.write(data);
        req.end();
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        // Seed a bare battle_reports row so the UPDATE has something to touch.
        db.prepare('INSERT INTO battle_reports (id, started_at) VALUES (?, ?)').run(9001, '2026-08-29T00:00:00Z');

        console.log('\n── malformed payload: strings/garbage instead of integers ' + '─'.repeat(10));
        const res = await postJson(server, '/hub-api/sync/battle-report-ship-detail', {
            id: 9001,
            att_destroyers: '100; DROP TABLE battle_reports;',
            att_destroyers_lost: 5,
            def_starbases_lost: 1.5,
            win_chance: '62.5',
        });
        ok('sync succeeds (200)', res.status === 200, res);

        const row = db.prepare('SELECT * FROM battle_reports WHERE id = ?').get(9001);
        ok('non-integer att_destroyers coerced to NULL, not stored as a string',
            row.att_destroyers === null, row);
        ok('valid integer att_destroyers_lost passes through untouched',
            row.att_destroyers_lost === 5, row);
        ok('non-integer (float) def_starbases_lost coerced to NULL',
            row.def_starbases_lost === null, row);
        ok('non-numeric win_chance string coerced to NULL',
            row.win_chance === null, row);
        ok('the table still exists (no injection through an uncoerced field)',
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='battle_reports'").get() !== undefined);

        console.log('\n── well-formed payload passes through ' + '─'.repeat(20));
        const res2 = await postJson(server, '/hub-api/sync/battle-report-ship-detail', {
            id: 9001,
            att_destroyers: 100,
            att_destroyers_lost: 10,
            def_starbases: 3,
            def_starbases_lost: 1,
            win_chance: 62.5,
        });
        ok('sync succeeds (200)', res2.status === 200, res2);
        const row2 = db.prepare('SELECT * FROM battle_reports WHERE id = ?').get(9001);
        ok('valid integers and win_chance stored as-is',
            row2.att_destroyers === 100 && row2.def_starbases === 3 && row2.win_chance === 62.5, row2);
    } finally {
        server.close();
    }

    console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
    process.exit(failed ? 1 : 0);
})();
