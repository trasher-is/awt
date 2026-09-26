// Route-level coverage for the `fleetHistory` field GET /hub-api/intel/player/:id returns
// (war-tool groundwork, 2026-09-20; revised same day to a 5-day sighting history) -- the
// profile injection's data source for the Fleets card. getFleetSightingHistory itself has
// its own full coverage in fleets.test.js; this only confirms the wiring: the right
// player's history comes back, and a player with no sightings gets `fleetHistory: []`
// rather than an error or someone else's rows.
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
        // Relative to now, not calendar dates: the history reads a 5-day window back from the
        // real clock, so dates written on 2026-09-20 aged out on 2026-09-26 (same fix as #284
        // for repositories/fleets.test.js). Same 12h gap as before.
        const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
        db.prepare(`INSERT INTO best_guarded (game_planet_id, cv, updated_at) VALUES (90001, '975', ?)`).run(hoursAgo(24));
        fleetsRepo.upsertStrongestFleet(901, 1, 325, 0, 0, 975, hoursAgo(12));

        console.log('\n── a player with a matched fleet ' + '─'.repeat(42));
        let r = await getJson(server, '/hub-api/intel/player/901');
        ok('request succeeds', r.status === 200 && r.body.success, r.body);
        ok('fleetHistory has exactly the one rankings sighting, resolved home',
            Array.isArray(r.body.fleetHistory) && r.body.fleetHistory.length === 1
            && r.body.fleetHistory[0].source === 'rankings' && r.body.fleetHistory[0].location_status === 'home',
            r.body.fleetHistory);

        console.log('\n── a player who has never been ranked ' + '─'.repeat(38));
        r = await getJson(server, '/hub-api/intel/player/903');
        ok('request succeeds', r.status === 200 && r.body.success, r.body);
        ok('fleetHistory is an empty array, not an error and not kralgar\'s rows',
            Array.isArray(r.body.fleetHistory) && r.body.fleetHistory.length === 0, r.body.fleetHistory);
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
