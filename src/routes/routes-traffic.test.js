// GET /hub-api/routes/traffic — the moving-ships layer's data.
//
// src/utils/fleet-traffic.test.js covers the positions. This covers what only the route
// can get wrong: widening the route planner's visibility rule, drawing an enemy fleet as
// if it were ours, and being swallowed by `/routes/:id`.
//
// Run with: node src/routes/routes-traffic.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-routes-traffic-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const routesRouter = require('./routes');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('routes-traffic.test.js');

let sessionUserId = 10;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: sessionUserId, gameName: 'Caveman' }; next(); });
app.use('/hub-api', routesRouter);

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

const HOUR = 3600 * 1000;
const NOW = Date.now();
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (90, 'Renegade Raiders', 'RAID')`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (91, 'Human Never United', 'HNU')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (1, 'Caveman', 90)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (2, 'Enemy', 91)`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (1)`).run();

// A fresh database already seeds an `admin` row at id 1, so these take ids of their own.
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (10, 'Caveman', 'x', 'user')`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (11, 'Someone else', 'x', 'user')`).run();

const system = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`);
system.run(1, 'Home', 0, 0);
system.run(2, 'Waypoint', 10, 0);
system.run(3, 'Target', 10, 10);

// A two-leg alliance move, currently half way through its first leg.
const routeId = db.prepare(`
    INSERT INTO routes (author_id, title, planned_start_at, energy, race_speed, is_alliance_move, biology, visibility, expires_at)
    VALUES (10, 'Half way there', ?, 0, 0, 1, 0, 'alliance', ?)
`).run(new Date(NOW - 2 * HOUR).toISOString(), sqlTime(NOW + 48 * HOUR)).lastInsertRowid;
const leg = db.prepare(`
    INSERT INTO route_legs (route_id, leg_index, from_system_id, from_planet_index, to_system_id, to_planet_index, travel_seconds, distance, bio_needed, is_alliance_move)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
leg.run(routeId, 0, 1, 2, 2, 4, 4 * 3600, 10, 3, 1);
leg.run(routeId, 1, 2, 4, 3, 1, 2 * 3600, 10, 3, 1);

// A private route belonging to somebody else: the traffic layer must not widen the
// route planner's own visibility rule.
const privateId = db.prepare(`
    INSERT INTO routes (author_id, title, planned_start_at, energy, race_speed, is_alliance_move, biology, visibility, expires_at)
    VALUES (11, 'Not yours', ?, 0, 0, 0, 0, 'private', ?)
`).run(new Date(NOW - HOUR).toISOString(), sqlTime(NOW + 48 * HOUR)).lastInsertRowid;
leg.run(privateId, 0, 1, 1, 3, 1, 6 * 3600, 14, 4, 0);

const fleet = db.prepare(`
    INSERT INTO fleets (owner_id, system_id, planet_index, destroyers, combat_value, arrival_at)
    VALUES (?, ?, ?, ?, ?, ?)
`);
fleet.run(1, 3, 7, 23, 69, new Date(NOW + 90 * 60 * 1000).toISOString());   // ours, in the air
fleet.run(1, 2, 4, 5, 15, null);                                            // ours, parked
fleet.run(2, 3, 2, 40, 120, new Date(NOW + 30 * 60 * 1000).toISOString());  // theirs, in the air

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    const res = await getJson(server, '/hub-api/routes/traffic');
    ok('the URL reaches this handler, not the /routes/:id lookup', res.status === 200, { status: res.status, body: res.body });
    const body = res.body;
    ok('reports success', body && body.success === true);

    // --- Ships on known courses -------------------------------------------
    const ship = body.ships.find(s => s.id === routeId);
    ok('a route in flight is returned', !!ship && ship.status === 'flying', body.ships);
    ok('it is on its first leg', ship.legIndex === 0, ship);
    ok('half way through a four-hour leg puts it half way along the line',
        Math.abs(ship.position.x - 5) < 0.2 && Math.abs(ship.position.y) < 0.01, ship.position);
    ok('it carries an ETA for the leg it is on', ship.etaMs > 0 && ship.etaMs <= 2 * HOUR, ship.etaMs);
    ok('it carries both legs so the path can be drawn behind it', ship.legs.length === 2, ship.legs.length);
    ok('the legs carry system coordinates', Number.isFinite(ship.legs[0].from.x), ship.legs[0]);
    ok("somebody else's private route is not in the layer",
        !body.ships.some(s => s.id === privateId), body.ships.map(s => s.id));

    // --- Inbound sightings -------------------------------------------------
    ok('our own fleet still in the air is marked', body.inbound.length === 1, body.inbound);
    ok('the marker is at the destination it was seen heading for', body.inbound[0].system_id === 3, body.inbound[0]);
    ok('it carries a countdown', body.inbound[0].etaMs > 0, body.inbound[0]);
    ok('a parked fleet of ours is not an arrival', !body.inbound.some(f => f.planet_index === 4), body.inbound);
    ok("an enemy fleet is not in this layer — this is about coordinating OUR movement",
        !body.inbound.some(f => f.tag === 'HNU'), body.inbound);
    // The reason the two halves are separate shapes at all.
    ok('a sighted fleet is given no course, because the scrape never saw its origin',
        body.inbound.every(f => !('legs' in f) && !('from' in f)), Object.keys(body.inbound[0]));

    // The same member on another account sees their own private route and not ours.
    sessionUserId = 11;
    const theirs = await getJson(server, '/hub-api/routes/traffic');
    ok('another member sees their own private route', theirs.body.ships.some(s => s.id === privateId), theirs.body.ships.map(s => s.id));
    ok('and still sees the alliance-visible one', theirs.body.ships.some(s => s.id === routeId), theirs.body.ships.map(s => s.id));

    server.close();
    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
