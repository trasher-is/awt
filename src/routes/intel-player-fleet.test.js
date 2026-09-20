// Route-level coverage for the `fleet` field GET /hub-api/intel/player/:id now returns
// (war-tool groundwork, 2026-09-20) -- the profile injection's data source for the new
// Fleets card. The cross-match/enrichment logic itself has its own full coverage
// (fleets.test.js, intel-fleet-locations.test.js); this only confirms the wiring: the
// right player's match comes back, and a player with no strongest_fleet row gets `fleet:
// null` rather than an error or a stale row belonging to someone else.
//
// Run with: node src/routes/intel-player-fleet.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-player-fleet-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const fleetsRepo = require('../repositories/fleets');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-player-fleet.test.js');

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
        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'FOE', 'Enemies')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (901, 'kralgar', 1), (903, 'NeverRanked', 1)`).run();
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (900, 'Praepes', 0, 0)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (90001, 900, 6, 901)`).run();
        db.prepare(`INSERT INTO best_guarded (game_planet_id, cv, updated_at) VALUES (90001, '975', '2026-09-19T22:00:00.000Z')`).run();
        fleetsRepo.upsertStrongestFleet(901, 1, 325, 0, 0, 975, '2026-09-20T10:00:00.000Z');

        console.log('\n── a player with a matched fleet ' + '─'.repeat(42));
        let r = await getJson(server, '/hub-api/intel/player/901');
        ok('request succeeds', r.status === 200 && r.body.success, r.body);
        ok('fleet resolves home, to the right player, not someone else\'s row',
            r.body.fleet && r.body.fleet.player_id === 901 && r.body.fleet.location_status === 'home', r.body.fleet);

        console.log('\n── a player who has never been ranked ' + '─'.repeat(38));
        r = await getJson(server, '/hub-api/intel/player/903');
        ok('request succeeds', r.status === 200 && r.body.success, r.body);
        ok('fleet is null, not an error and not kralgar\'s row', r.body.fleet === null, r.body.fleet);
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
