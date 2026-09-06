// GET /hub-api/intel/me/planets (issue #138): a member's own planets with the population the
// hub last saw, resolved from the account's game name the same way /me resolves playerId.
//
// Run with: node src/routes/intel-me-planets.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-me-planets-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-me-planets.test.js');

// The session user is switchable so one server can act as several members.
let sessionUserId = 1;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: sessionUserId }; next(); });
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
        // A fresh database already holds the bootstrap admin as user 1 (no players row).
        usersRepo.createUser('OwnerOne', 'not-a-real-hash', 'user', null);
        const owner = usersRepo.getUserByGameName('OwnerOne');
        ok('test member created', owner && owner.id > 1, owner);

        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (7, 'Meboula', 10, 20), (9, 'Kessel', 30, 40)`).run();
        // Case differs from the account's game name on purpose: the bridge join is LOWER() on both sides.
        db.prepare(`INSERT INTO players (id, name) VALUES (301, 'ownerone'), (302, 'Neighbour')`).run();
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, name, updated_at)
                    VALUES (7001, 7, 1, 301, 7, 'Home', datetime('now', '-2 hours')),
                           (7002, 7, 3, 301, 5, 'Second', datetime('now', '-30 hours')),
                           (9001, 9, 2, 301, 7, NULL, datetime('now', '-1 hour')),
                           (7003, 7, 2, 302, 9, 'Theirs', datetime('now'))`).run();

        console.log('\n── The member\'s own planets ' + '─'.repeat(47));
        sessionUserId = owner.id;
        let r = await getJson(server, '/hub-api/intel/me/planets');
        ok('200 and success', r.status === 200 && r.body && r.body.success === true, r.body);
        ok('resolves the player id through the game name, case-insensitively', r.body.playerId === 301, r.body.playerId);
        const planets = r.body.planets;
        ok('returns exactly the three planets owned by that player, none of the neighbour\'s', Array.isArray(planets) && planets.length === 3 && planets.every(p => p.name !== 'Theirs'), planets);
        ok('ordered by system then planet index', planets.map(p => `${p.system_id}:${p.planet_index}`).join(',') === '7:1,7:3,9:2');
        ok('each row carries population and updated_at, plus the system name for display',
            planets.every(p => Number.isInteger(p.population) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(p.updated_at) && typeof p.system_name === 'string'), planets[0]);
        ok('a planet without a name is still returned (name null)', planets.some(p => p.game_planet_id === 9001 && p.name === null));

        console.log('\n── An account the hub cannot map to a player ' + '─'.repeat(30));
        sessionUserId = 1;
        r = await getJson(server, '/hub-api/intel/me/planets');
        ok('answers success:false with a reason, not a 404 or 500', r.status === 200 && r.body && r.body.success === false && /No player on record/.test(r.body.error), r.body);
        ok('and carries no planets', !Array.isArray(r.body.planets));

        console.log('\n── A mapped player with no planets on record ' + '─'.repeat(30));
        usersRepo.createUser('Newcomer', 'not-a-real-hash', 'user', null);
        db.prepare(`INSERT INTO players (id, name) VALUES (303, 'Newcomer')`).run();
        sessionUserId = usersRepo.getUserByGameName('Newcomer').id;
        r = await getJson(server, '/hub-api/intel/me/planets');
        ok('success with an empty array', r.body && r.body.success === true && Array.isArray(r.body.planets) && r.body.planets.length === 0, r.body);
    } catch (err) {
        failed++;
        console.error('  NOT OK - unexpected error:', err);
    } finally {
        server.close();
    }

    console.log(`\n${failed === 0 ? 'ok' : 'FAILED'} - intel-me-planets.test.js (${failed} failure${failed === 1 ? '' : 's'})`);
    process.exit(failed === 0 ? 0 : 1);
})();
