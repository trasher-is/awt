// Regression coverage for /sync/strongest-fleet (2026-09-20, war-tool groundwork).
//
// Three things this route exists specifically to get right, per the design discussion:
// (1) a player can hold more than one fleet in the same top-50 snapshot at once, so rows
//     are keyed by rank, not owner -- re-syncing must never produce two rows for someone
//     whose fleet just moved planet or grew (e.g. "yesterday's 300 destroyers and today's
//     400 as separate rows" is exactly the bug this table's wholesale-replace avoids);
// (2) an owner who isn't a known player yet gets player_id stored as NULL, not dropped;
// (3) anything untouched for 5+ days is purged before each sync, so a scraper gone quiet
//     doesn't leave stale rows looking current forever.
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

        console.log('\n── First sync: two fleets for the same player, plus an unknown owner ' + '─'.repeat(4));
        const firstRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', {
            rows: [
                { rank: 1, player_id: 101, cv: 975, destroyers: 325, cruisers: 0, battleships: 0 },
                { rank: 2, player_id: 102, cv: 99, destroyers: 33, cruisers: 0, battleships: 0 },
                { rank: 3, player_id: 102, cv: 93, destroyers: 31, cruisers: 0, battleships: 0 }, // same player, second fleet
                { rank: 4, player_id: 999999, cv: 51, destroyers: 17, cruisers: 0, battleships: 0 }, // unknown player
            ],
        });
        ok('sync succeeds', firstRes.status === 200 && firstRes.body.success, firstRes.body);

        const rowsAfterFirst = db.prepare(`SELECT rank, player_id, cv FROM strongest_fleet ORDER BY rank`).all();
        ok('all 4 rows land, including both of Wearic\'s fleets', rowsAfterFirst.length === 4, rowsAfterFirst);
        ok('the two same-player rows both keep their own rank/cv, not deduped away',
            rowsAfterFirst[1].player_id === 102 && rowsAfterFirst[1].cv === 99 &&
            rowsAfterFirst[2].player_id === 102 && rowsAfterFirst[2].cv === 93,
            rowsAfterFirst);
        ok('the unknown owner is stored with player_id NULL, not dropped',
            rowsAfterFirst[3].player_id === null && rowsAfterFirst[3].cv === 51, rowsAfterFirst[3]);

        console.log('\n── Second sync: kralgar\'s fleet grew and moved rank -- no leftover old row ' + '─'.repeat(2));
        const secondRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', {
            rows: [
                { rank: 1, player_id: 102, cv: 480, destroyers: 160, cruisers: 0, battleships: 0 },
                { rank: 2, player_id: 101, cv: 1200, destroyers: 400, cruisers: 0, battleships: 0 }, // kralgar, grown, different rank
            ],
        });
        ok('second sync succeeds', secondRes.status === 200 && secondRes.body.success, secondRes.body);

        const rowsAfterSecond = db.prepare(`SELECT rank, player_id, cv FROM strongest_fleet ORDER BY rank`).all();
        ok('exactly 2 rows exist -- the wholesale replace left no trace of the old 4',
            rowsAfterSecond.length === 2, rowsAfterSecond);
        ok('kralgar has exactly one row, at his new cv, not a second leftover at 975',
            rowsAfterSecond.filter(r => r.player_id === 101).length === 1 &&
            rowsAfterSecond.find(r => r.player_id === 101).cv === 1200,
            rowsAfterSecond);

        console.log('\n── A row untouched for 5+ days is purged on the next sync, not carried forward ' + '─'.repeat(1));
        db.prepare(`INSERT INTO strongest_fleet (rank, player_id, destroyers, cruisers, battleships, cv, updated_at)
                    VALUES (50, 101, 1, 0, 0, 3, datetime('now', '-6 days'))`).run();
        // clearStrongestFleet() would already wipe this on any sync, so to prove the
        // staleness purge itself (not just the wholesale replace) fire it against a table
        // it does NOT otherwise touch: delete the trigger row it would leave behind is
        // pointless to assert directly -- instead confirm the repository function alone
        // removes it, independent of a sync ever running.
        require('../repositories/fleets').deleteStrongestFleetOlderThan5Days();
        const staleGone = db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet WHERE rank = 50`).get().n;
        ok('the 6-day-old row is gone after the staleness purge', staleGone === 0, staleGone);
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
