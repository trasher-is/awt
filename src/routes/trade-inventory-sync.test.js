// Hoard A$ + Astro Dollars sync (2026-09-20): POST /hub-api/sync/trade-inventory. Both
// values are read off the member's own /Game/Trade page — see trade-inventory-parser.js —
// and astro_dollars now overwrites the same column the Alliance member-sheet scrape used to
// own (deliberately: this alliance wants Planets + Trade as the only source, never
// /Game/Alliance). This file covers the one subtlety in that switch: astro_dollars must be
// optional in the request body, so an old tab still running the pre-2026-09-20 bundle (only
// sending hoarded_au, before it self-reloads — see version-watch.js) cannot zero out a real
// astro_dollars balance it never sent.
//
// Run with: node src/routes/trade-inventory-sync.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-trade-inv-sync-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const tradeRouter = require('./trade');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('trade-inventory-sync.test.js');

let sessionGameName = 'caveman';
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: sessionGameName }; next(); });
app.use('/hub-api', tradeRouter);

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', (c) => raw += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { /* non-JSON body */ }
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
    try {
        db.prepare(`INSERT INTO players (id, name) VALUES (401, 'caveman')`).run();

        console.log('\n── A full sync stores hoard + the exact astro dollars ' + '─'.repeat(21));
        let r = await request(server, 'POST', '/hub-api/sync/trade-inventory', { hoarded_au: 1352, astro_dollars: 7200.27 });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        let row = db.prepare('SELECT hoarded_au, astro_dollars FROM alliance_member_stats WHERE player_id = 401').get();
        ok('hoarded_au stored', row.hoarded_au === 1352, row);
        ok('astro_dollars stored at full precision, not rounded', row.astro_dollars === '7200.27', row);

        console.log('\n── An old tab\'s pre-2026-09-20 payload (no astro_dollars) never zeroes it ' + '─'.repeat(2));
        r = await request(server, 'POST', '/hub-api/sync/trade-inventory', { hoarded_au: 1400 });
        ok('sync still succeeds without astro_dollars in the body', r.status === 200 && r.body.success, r.body);
        row = db.prepare('SELECT hoarded_au, astro_dollars FROM alliance_member_stats WHERE player_id = 401').get();
        ok('hoarded_au still updates', row.hoarded_au === 1400, row);
        ok('astro_dollars is untouched, not reset to 0', row.astro_dollars === '7200.27', row);

        console.log('\n── An unmapped account is a soft no-op, not a 404/500 ' + '─'.repeat(21));
        sessionGameName = 'nobody-on-record';
        r = await request(server, 'POST', '/hub-api/sync/trade-inventory', { hoarded_au: 1, astro_dollars: 1 });
        ok('200 with stored:false', r.status === 200 && r.body.success && r.body.stored === false, r.body);
    } finally {
        server.close();
    }

    console.log('\n' + '─'.repeat(77));
    console.log(failed === 0 ? 'All checks passed' : `${failed} check(s) failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
