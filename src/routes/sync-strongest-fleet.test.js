// Regression coverage for /sync/strongest-fleet (2026-09-20, war-tool groundwork; revised
// same day for durable history -- see database.js's strongest_fleet comment for the full
// reasoning behind the switch from wholesale-replace/rank-keyed to upsert/player-keyed).
//
// Four things this route exists specifically to get right:
// (1) upsert, not wholesale-replace -- a player missing from THIS sync keeps their
//     last-known row rather than being wiped, which is how the table ends up holding more
//     than one day's top-50 at once;
// (2) a player with two simultaneous fleets in one scrape is collapsed to their single
//     highest-cv row -- player_id can only ever hold one row now;
// (3) an owner who isn't a known player is skipped entirely, not kept with player_id NULL
//     -- there's no stable identity left to upsert against under the new schema;
// (4) anything untouched for 5+ days is purged before each sync, so a scraper gone quiet
//     doesn't leave stale rows looking current forever, and a genuinely-gone player
//     eventually drops out of the history this table now keeps.
//
// Run with: node src/routes/sync-strongest-fleet.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-strongest-fleet-test-')), 'test.db');
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

console.log('sync-strongest-fleet.test.js');

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
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (101, 'kralgar', 2), (102, 'Wearic', 2)`).run();

        console.log('\n── First sync: a player with two simultaneous fleets, plus an unknown owner ' + '─'.repeat(2));
        const firstRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', {
            rows: [
                { rank: 1, player_id: 101, cv: 975, destroyers: 325, cruisers: 0, battleships: 0 },
                { rank: 2, player_id: 102, cv: 99, destroyers: 33, cruisers: 0, battleships: 0 },
                { rank: 3, player_id: 102, cv: 93, destroyers: 31, cruisers: 0, battleships: 0 }, // Wearic, second/smaller fleet
                { rank: 4, player_id: 999999, cv: 51, destroyers: 17, cruisers: 0, battleships: 0 }, // unknown player
            ],
        });
        ok('sync succeeds', firstRes.status === 200 && firstRes.body.success, firstRes.body);

        const rowsAfterFirst = db.prepare(`SELECT rank, player_id, cv FROM strongest_fleet ORDER BY player_id`).all();
        ok('exactly 2 rows: the unknown owner was skipped, not kept with player_id NULL',
            rowsAfterFirst.length === 2, rowsAfterFirst);
        ok('Wearic\'s two simultaneous fleets collapsed to a single row at his HIGHER cv (99, not 93)',
            rowsAfterFirst.find(r => r.player_id === 102)?.cv === 99, rowsAfterFirst);
        ok('kralgar\'s single fleet is stored as-is', rowsAfterFirst.find(r => r.player_id === 101)?.cv === 975, rowsAfterFirst);

        console.log('\n── Second sync: kralgar\'s fleet grew; Wearic is absent this time ' + '─'.repeat(6));
        const secondRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', {
            rows: [
                { rank: 2, player_id: 101, cv: 1200, destroyers: 400, cruisers: 0, battleships: 0 }, // kralgar, grown, different rank
            ],
        });
        ok('second sync succeeds', secondRes.status === 200 && secondRes.body.success, secondRes.body);

        const rowsAfterSecond = db.prepare(`SELECT rank, player_id, cv, updated_at FROM strongest_fleet ORDER BY player_id`).all();
        ok('still 2 rows -- Wearic, absent from this scrape, was NOT wiped (this is the whole point of the upsert switch)',
            rowsAfterSecond.length === 2, rowsAfterSecond);
        ok('kralgar has exactly one row, UPDATED in place to his new cv/rank (not a second leftover row at 975)',
            rowsAfterSecond.filter(r => r.player_id === 101).length === 1 &&
            rowsAfterSecond.find(r => r.player_id === 101).cv === 1200 &&
            rowsAfterSecond.find(r => r.player_id === 101).rank === 2,
            rowsAfterSecond);
        ok('Wearic\'s row is untouched (still his first-sync cv of 99)',
            rowsAfterSecond.find(r => r.player_id === 102)?.cv === 99, rowsAfterSecond);

        console.log('\n── A row untouched for 5+ days is purged on the next sync, not carried forward ' + '─'.repeat(1));
        db.prepare(`UPDATE strongest_fleet SET updated_at = datetime('now', '-6 days') WHERE player_id = 102`).run();
        const thirdRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', { rows: [] });
        ok('an empty-payload sync still succeeds', thirdRes.status === 200 && thirdRes.body.success, thirdRes.body);
        const rowsAfterThird = db.prepare(`SELECT player_id FROM strongest_fleet`).all();
        ok('Wearic\'s 6-day-stale row is gone; kralgar\'s fresh row survives',
            rowsAfterThird.length === 1 && rowsAfterThird[0].player_id === 101, rowsAfterThird);
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
