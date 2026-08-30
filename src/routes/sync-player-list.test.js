// Regression test for a real production crash (2026-08-30): the first ListPlayer bulk
// sync of a brand-new round threw `SqliteError: FOREIGN KEY constraint failed` from
// upsertPlayerFromApiList. players.alliance_id has a FOREIGN KEY to alliances(id), and
// unlike the single-player scan and system scan (both of which call
// alliancesRepo.upsertAllianceTagOnly before writing the player), /sync/player-list wrote
// straight through with no such guard — any player whose alliance the hub had never seen
// before failed the INSERT. Root cause on the client side too: aw-api.js's
// mapPlayersToSyncPayload dropped the ListPlayer API's own allianceTag field entirely, so
// even fixing the server route would have had no tag to seed the alliance row with.
// Drives the REAL /sync/player-list route end-to-end (express app + http server + fetch)
// against a scratch sqlite database with foreign_keys enforcement genuinely on, because the
// bug is specifically about FK enforcement order.
//
// Run with: node src/routes/sync-player-list.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-player-list-test-')), 'test.db');
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

console.log('sync-player-list.test.js');

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
    ok('foreign_keys enforcement is actually ON for this connection (or the test proves nothing)',
        db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1);

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── a player whose alliance the hub has never seen before ' + '─'.repeat(15));
        // Real shape: aw-api.js's mapPlayersToSyncPayload output, alliance_id 9001 not yet
        // in the alliances table (fresh round, first ListPlayer pull of the round).
        const payloadA = {
            players: [{
                id: 51, name: 'caveman', alliance_id: 9001, alliance_tag: 'RAID',
                level: 1, points: 0, rank: null, country: 'FI', is_active_player: true, joined: null,
            }],
        };
        const resA = await postJson(server, '/hub-api/sync/player-list', payloadA);
        ok('sync succeeds (200) instead of crashing with FOREIGN KEY constraint failed', resA.status === 200, resA);
        ok('exactly one player stored', resA.body && resA.body.count === 1, resA.body);

        const alliance = db.prepare('SELECT id, tag FROM alliances WHERE id = ?').get(9001);
        ok('the never-before-seen alliance was seeded so the FK could be satisfied',
            alliance && alliance.tag === 'RAID', alliance);

        const player = db.prepare('SELECT id, name, alliance_id FROM players WHERE id = ?').get(51);
        ok('the player row was actually written with the alliance id attached',
            player && player.alliance_id === 9001, player);

        console.log('\n── a player with no alliance at all ' + '─'.repeat(30));
        const payloadB = {
            players: [{
                id: 52, name: 'lonewolf', alliance_id: null, alliance_tag: null,
                level: 3, points: 10, rank: null, country: null, is_active_player: true, joined: null,
            }],
        };
        const resB = await postJson(server, '/hub-api/sync/player-list', payloadB);
        ok('a player with no alliance still succeeds (no FK to worry about)', resB.status === 200, resB);
        const noAllianceRow = db.prepare('SELECT alliance_id FROM players WHERE id = ?').get(52);
        ok('alliance_id stays null, not fabricated', noAllianceRow.alliance_id === null, noAllianceRow);

        console.log('\n── a second player joining that SAME already-seeded alliance ' + '─'.repeat(8));
        const payloadC = {
            players: [{
                id: 53, name: 'raider2', alliance_id: 9001, alliance_tag: 'RAID',
                level: 2, points: 5, rank: null, country: null, is_active_player: true, joined: null,
            }],
        };
        const resC = await postJson(server, '/hub-api/sync/player-list', payloadC);
        ok('a second member of an already-known alliance still succeeds', resC.status === 200, resC);
        ok('no duplicate alliance row was created', db.prepare('SELECT COUNT(*) as n FROM alliances WHERE id = 9001').get().n === 1);
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
