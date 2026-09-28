// Synthetic SQLite data only. The minimal schema deliberately permits duplicate planet
// locations to cover older/imported databases; normal planets.game_planet_id is UNIQUE.
const Database = require('better-sqlite3');
const express = require('express');
const http = require('http');
const db = new Database(':memory:');
db.exec(`
    CREATE TABLE systems (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE planets (game_planet_id INTEGER, system_id INTEGER, planet_index INTEGER);
    CREATE TABLE best_planets_snapshot (game_planet_id INTEGER PRIMARY KEY, rank INTEGER, updated_at TEXT,
        hf INTEGER, rf INTEGER, gc INTEGER, rl INTEGER);
`);
require.cache[require.resolve('../database')] = { exports: db };
const router = require('./unicorn');
const { blockGuestWrites } = require('./_middleware');

let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else {
        failed++;
        console.error(`  NOT OK - ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
    }
}

let session = null;
const app = express();
app.use((req, res, next) => { req.session = session; next(); });
app.use('/hub-api', blockGuestWrites, router);

function request(server, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
            path: '/hub-api/intel/unicorn', method }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                let body;
                try { body = JSON.parse(raw); } catch (_) { body = null; }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        let response = await request(server);
        ok('anonymous requests cannot read ranking intel', response.status === 401, response);

        session = { userId: 17, role: 'user' };
        response = await request(server);
        ok('an empty archive is empty, not a fabricated Top 50', response.status === 200
            && response.body.success === true && response.body.total === 0 && response.body.mapped === 0
            && response.body.rows.length === 0 && response.body.synced_at === null, response.body);

        const syncedAt = '2026-09-28T12:00:00.000Z';
        const insertRanking = db.prepare('INSERT INTO best_planets_snapshot (game_planet_id, rank, updated_at) VALUES (?, ?, ?)');
        for (const [planetId, rank] of [[7001, 1], [7002, 2], [7003, 3], [7004, 50],
            [7005, 51], [7006, 0], [7007, 1.5], [7008, 'not-a-rank'], [7009, -2],
            [7010, 4], [7011, 5], [7012, 6], [0, 7], [-1, 8]]) {
            insertRanking.run(planetId, rank, syncedAt);
        }
        db.exec(`
            INSERT INTO systems VALUES (7, 'Synthetic Meadow'), (8, 'Synthetic Orchard');
            INSERT INTO planets VALUES
                (7001, 7, 2),
                (7003, 7, 3), (7003, 8, 1),
                (7004, 8, 4),
                (7010, 99, 1),
                (7011, 7, 0),
                (7012, 7, 100);
        `);
        const snapshot = () => JSON.stringify({
            ranking: db.prepare('SELECT * FROM best_planets_snapshot ORDER BY game_planet_id').all(),
            planets: db.prepare('SELECT * FROM planets ORDER BY game_planet_id, system_id').all(),
        });
        const before = snapshot();
        response = await request(server);
        const data = response.body;
        ok('only positive planet IDs and integer ranks 1 through 50 are returned',
            data.total === 7 && data.rows.map(row => row.rank).join(',') === '1,2,3,4,5,6,50', data);
        ok('a partial ranking reports its actual count', data.total === data.rows.length && data.total !== 50);
        ok('synced_at reports the recorded sync time', data.synced_at === syncedAt, data.synced_at);
        ok('unique known locations map to the right planet rows', data.mapped === 2
            && data.rows[0].system_id === 7 && data.rows[0].planet_index === 2
            && data.rows[0].system_name === 'Synthetic Meadow'
            && data.rows[6].system_id === 8 && data.rows[6].planet_index === 4, data.rows);
        for (const [id, reason] of [[7002, 'never scanned'], [7003, 'ambiguous mapping'],
            [7010, 'missing system'], [7011, 'zero planet index'], [7012, 'invalid planet index']]) {
            const row = data.rows.find(item => item.game_planet_id === id);
            ok(`${reason} preserves the ranking without inventing a location`, row
                && row.system_id === null && row.planet_index === null && row.system_name === null, row);
        }
        ok('payload includes only ranking identity and location, no player information',
            data.rows.every(row => Object.keys(row).sort().join(',')
                === 'game_planet_id,planet_index,rank,system_id,system_name'));
        ok('building leaders are explicitly unavailable rather than inferred',
            Array.isArray(data.leaders) && data.leaders.length === 0 && data.leaders_status === 'unavailable');

        session = { userId: 18, role: 'guest' };
        response = await request(server);
        ok('authenticated guests retain the usual read-only intel access', response.status === 200
            && response.body.total === 7, response);
        session = { userId: 17, role: 'user' };
        response = await request(server, 'POST');
        ok('the endpoint exposes no write action', response.status === 404, response.status);
        ok('reading or attempting a write leaves stored observations untouched', snapshot() === before);
    } catch (err) {
        failed++;
        console.error('  NOT OK - unexpected error:', err);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
    console.log(`\nunicorn.test.js: ${failed ? 'FAILED' : 'all passed'} (${failed} failures)`);
    process.exitCode = failed ? 1 : 0;
})();
