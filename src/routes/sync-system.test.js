// Regression test for finding 1 of the "systems seed" final-review fix wave (2026-08-29):
// an out-of-vision seed (is_unknown: true) that still carries an *unseen* owner id used to
// throw SQLITE_CONSTRAINT_FOREIGNKEY on INSERT (planets.owner_id -> players.id), rolling
// back the whole system's transaction. Drives the REAL /sync/system route end-to-end
// (express app + http server + fetch) against a scratch sqlite database, because the bug
// only reproduces through the actual db.transaction()/FK-enforced INSERT path.
//
// Run with: node src/routes/sync-system.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-system-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
// Never attempt a real Discord login in a test process.
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const systemsRepo = require('../repositories/systems');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-system.test.js');

const app = express();
app.use(express.json());
// Stand-in for a logged-in session — requireAuth only checks req.session.userId.
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
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── (a) out-of-vision seed, unseen owner, no prior row ' + '─'.repeat(20));
        // System 100, planet index 1: never seen before, and the "owner" (player 999) has
        // never been seen either — no players row exists for id 999. Before the fix, this
        // threw SQLITE_CONSTRAINT_FOREIGNKEY inside the transaction, rolling back planet 2
        // (a normal, fully-visible planet in the SAME payload) along with it.
        const payloadA = {
            system_id: 100,
            planets: [
                {
                    planet_index: 1,
                    is_unknown: true,
                    owner: { id: 999, name: 'NeverSeen', alliance_id: null, alliance_tag: null },
                    population: 5000,
                    starbase: 3,
                },
                {
                    planet_index: 2,
                    is_unknown: false,
                    owner: null,
                    population: 0,
                    starbase: 0,
                },
            ],
            fleets: [],
        };
        const resA = await postJson(server, '/hub-api/sync/system', payloadA);
        ok('sync succeeds (200) instead of 500', resA.status === 200, resA);

        const rowA1 = db.prepare('SELECT owner_id FROM planets WHERE system_id = ? AND planet_index = ?').get(100, 1);
        ok('never-seen planet with an unseen owner gets owner_id = NULL, not the unseen id',
            rowA1 && rowA1.owner_id === null, rowA1);

        const rowA2 = db.prepare('SELECT * FROM planets WHERE system_id = ? AND planet_index = ?').get(100, 2);
        ok('the OTHER planet in the same system was not rolled back by the FK violation',
            !!rowA2, rowA2);

        ok('no players row was fabricated for the unseen owner id',
            db.prepare('SELECT 1 FROM players WHERE id = ?').get(999) === undefined);

        console.log('\n── (b) out-of-vision seed where a prior row DOES exist ' + '─'.repeat(18));
        // System 200/planet 1: seed a known owner first (a real players row + a confirmed
        // sighting), then send a later out-of-vision, unseen-owner payload for the SAME
        // planet. Behavior must be byte-identical to the original guard: fully preserve the
        // old row (owner/population/starbase/has_fleet/is_sieged), never touch the new
        // unseen owner id.
        const seedPayload = {
            system_id: 200,
            planets: [{
                planet_index: 1,
                is_unknown: false,
                owner: { id: 55, name: 'KnownOwner', alliance_id: null, alliance_tag: null },
                population: 1234,
                starbase: 7,
                has_fleet: 1,
                is_sieged: 0,
            }],
            fleets: [],
        };
        const seedRes = await postJson(server, '/hub-api/sync/system', seedPayload);
        ok('seed payload for system 200 succeeds', seedRes.status === 200, seedRes);

        const before = systemsRepo.getOldPlanet(200, 1);
        ok('prior row is set up as expected before the fog-of-war payload', before && before.owner_id === 55 && before.population === 1234);

        const fogPayload = {
            system_id: 200,
            planets: [{
                planet_index: 1,
                is_unknown: true,
                owner: { id: 999, name: 'NeverSeen', alliance_id: null, alliance_tag: null },
                population: 1,
                starbase: 0,
            }],
            fleets: [],
        };
        const fogRes = await postJson(server, '/hub-api/sync/system', fogPayload);
        ok('fog-of-war payload over an existing row succeeds', fogRes.status === 200, fogRes);

        const after = systemsRepo.getOldPlanet(200, 1);
        ok('owner_id preserved from before (old guard behavior unchanged)', after.owner_id === before.owner_id, { before, after });
        ok('population preserved from before (old guard behavior unchanged)', after.population === before.population, { before, after });
        ok('starbase preserved from before (old guard behavior unchanged)', after.starbase === before.starbase, { before, after });
        ok('has_fleet preserved from before (old guard behavior unchanged)', after.has_fleet === before.has_fleet, { before, after });
        ok('is_sieged preserved from before (old guard behavior unchanged)', after.is_sieged === before.is_sieged, { before, after });
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
