// Route-level coverage for /sync/alliances-from-map — the receiver for the only bulk
// "every alliance" source that exists (Map/sectors has no dedicated alliance-list API).
// Drives the REAL route end-to-end (express app + http server + fetch) against a scratch
// sqlite database, mirroring sync-player-list.test.js's shape.
//
// Run with: node src/routes/sync-alliances-from-map.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-alliances-map-test-')), 'test.db');
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

console.log('sync-alliances-from-map.test.js');

const app = express();
app.use(express.json());
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
        console.log('\n── an empty/invalid payload is rejected ' + '─'.repeat(30));
        const bad = await postJson(server, '/hub-api/sync/alliances-from-map', { alliances: [] });
        ok('an empty array is a 400, not a silent no-op', bad.status === 400, bad);

        console.log('\n── real Map/sectors shape, mapped client-side first ' + '─'.repeat(18));
        // Real shape confirmed live (2026-08-30): {id, name, tag} — mapSectorAlliancesToSyncPayload
        // already stripped `color` and deduped by id before this hit the wire.
        const payload = { alliances: [{ id: 14, name: 'Alliance Orange', tag: 'AO' }, { id: 9, name: 'SSPX', tag: 'SSPX' }] };
        const res = await postJson(server, '/hub-api/sync/alliances-from-map', payload);
        ok('sync succeeds (200)', res.status === 200, res);
        ok('both alliances stored', res.body && res.body.count === 2, res.body);

        const orange = db.prepare('SELECT id, name, tag, full_name, member_count FROM alliances WHERE id = ?').get(14);
        ok('id/name/tag were written', orange && orange.name === 'Alliance Orange' && orange.tag === 'AO', orange);
        ok('full_name/member_count are left null — this source has no such data', orange.full_name === null && orange.member_count === null, orange);

        console.log('\n── does not clobber full_name/member_count set by a richer source ' + '─'.repeat(4));
        db.prepare(`UPDATE alliances SET full_name = 'The Orange Collective', member_count = 42 WHERE id = 14`).run();
        const resAgain = await postJson(server, '/hub-api/sync/alliances-from-map', payload);
        ok('re-syncing the same sector data succeeds', resAgain.status === 200, resAgain);
        const orangeAfter = db.prepare('SELECT full_name, member_count FROM alliances WHERE id = ?').get(14);
        ok('full_name survives a later Map/sectors sync untouched',
            orangeAfter.full_name === 'The Orange Collective', orangeAfter);
        ok('member_count survives too',
            orangeAfter.member_count === 42, orangeAfter);
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
