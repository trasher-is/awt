// Route-level coverage for GET /hub-api/intel/system/:id — specifically the `system` field
// added alongside two client-facing fixes (2026-08-31): the sidebar's "System Data - #{id}
// {name}" header, and the out-of-vision proxy's synthetic page heading. Both need the
// system's own name/coords, which this route did not return before.
//
// Run with: node src/routes/intel-system.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-system-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-system.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', intelRouter);

function getJson(server, urlPath) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        }).on('error', reject);
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── a system that has never been indexed ' + '─'.repeat(30));
        const missing = await getJson(server, '/hub-api/intel/system/999999');
        ok('request still succeeds', missing.status === 200, missing);
        ok('system is null, not an error, when the system is unknown', missing.body.system === null, missing.body);

        console.log('\n── a real, indexed system ' + '─'.repeat(44));
        db.prepare(`INSERT INTO systems (id, name, full_name, x, y) VALUES (4, 'Meboula', NULL, 3, -3)`).run();
        const found = await getJson(server, '/hub-api/intel/system/4');
        ok('request succeeds', found.status === 200, found);
        ok('system carries id/name/x/y', found.body.system
            && found.body.system.id === 4 && found.body.system.name === 'Meboula'
            && found.body.system.x === 3 && found.body.system.y === -3, found.body.system);
        ok('the existing planets/fleets/history/plans fields are still present alongside it',
            Array.isArray(found.body.planets) && Array.isArray(found.body.fleets)
            && Array.isArray(found.body.history) && Array.isArray(found.body.plans), found.body);
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
