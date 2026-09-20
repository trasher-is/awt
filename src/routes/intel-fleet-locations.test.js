// Route-level coverage for GET /hub-api/intel/fleet-locations (war-tool groundwork,
// 2026-09-20) — confirms the route actually merges in the two extra sources on top of
// fleetsRepo.getFleetLocationMatches (which has its own full unit coverage in
// fleets.test.js): transports/colony_ships from the player's latest ship-detail battle
// report, and last_battle_seen from the same source !lastseen uses.
//
// Run with: node src/routes/intel-fleet-locations.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-fleet-locations-test-')), 'test.db');
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

console.log('intel-fleet-locations.test.js');

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
        console.log('\n── empty table ' + '─'.repeat(60));
        let r = await getJson(server, '/hub-api/intel/fleet-locations');
        ok('request succeeds with an empty table', r.status === 200 && r.body.success, r);
        ok('fleets is an empty array', Array.isArray(r.body.fleets) && r.body.fleets.length === 0, r.body);

        console.log('\n── merging composition + last-seen onto a matched fleet ' + '─'.repeat(15));
        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'FOE', 'Enemies')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (901, 'kralgar', 1)`).run();
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (900, 'Praepes', 0, 0)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (90001, 900, 6, 901)`).run();
        db.prepare(`INSERT INTO best_guarded (game_planet_id, cv, updated_at) VALUES (90001, '975', '2026-09-19T22:00:00.000Z')`).run();
        fleetsRepo.upsertStrongestFleet(901, 1, 325, 0, 0, 975, '2026-09-20T10:00:00.000Z');

        // A ship-detail-scraped battle report (source of transports/colony_ships).
        db.prepare(`
            INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, att_destroyers, att_transports, att_colony_ships)
            VALUES (7001, '2026-09-18T08:00:00Z', 901, 902, 300, 20, 1)
        `).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (902, 'Victim', 1)`).run();
        // A located battle (source of last_battle_seen) — a different, more recent one.
        db.prepare(`
            INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
            VALUES (7002, '2026-09-19T12:00:00Z', 901, 902, 900, 6)
        `).run();

        r = await getJson(server, '/hub-api/intel/fleet-locations');
        ok('request succeeds', r.status === 200 && r.body.success, r);
        const kralgar = r.body.fleets.find(f => f.player_id === 901);
        ok('the fleet still resolves home, via the untouched cross-match logic',
            kralgar && kralgar.location_status === 'home', kralgar);
        ok('transports/colony_ships are merged in from the battle report, not from strongest_fleet',
            kralgar.transports === 20 && kralgar.colony_ships === 1, kralgar);
        ok('composition_at carries the REPORT\'s own timestamp, not the fleet row\'s updated_at',
            kralgar.composition_at === '2026-09-18T08:00:00Z', kralgar);
        ok('last_battle_seen resolves to the located report, with a readable system name',
            kralgar.last_battle_seen
                && kralgar.last_battle_seen.system_id === 900
                && kralgar.last_battle_seen.system_name === 'Praepes'
                && kralgar.last_battle_seen.planet_index === 6, kralgar);

        console.log('\n── a fleet with no player_id skips both merges cleanly, not a crash ' + '─'.repeat(5));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (910, 'Orphan', 5, 5)`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index) VALUES (91001, 910, 1)`).run();
        db.prepare(`INSERT INTO best_guarded (game_planet_id, cv, updated_at) VALUES (91001, '42', '2026-09-19T22:00:00.000Z')`).run();
        // No matching strongest_fleet row for player-less data is possible (player_id is
        // the table's PK and NOT NULL in practice — see database.js's table comment), so
        // this branch is instead exercised by confirming the merge guards on `f.player_id
        // != null` don't throw for a fleet whose match legitimately has none to look up.
        r = await getJson(server, '/hub-api/intel/fleet-locations');
        ok('a second request with more best_guarded noise still succeeds', r.status === 200 && r.body.success, r);
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
