// Issue #164: a missing profile Origin must not erase a recorded origin, and one changed
// origin must not delete fleet intel. A reset caused by the existing login-counter drop
// remains meaningful. Everything below is synthetic and drives the real HTTP receiver.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-player-origin-'));
process.env.AWT_DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const players = require('../repositories/players');
const fleets = require('../repositories/fleets');
let resets = 0, fleetClears = 0;
const resetPlayer = players.resetPlayerOnRestart;
const clearFleets = fleets.deleteFleetsByOwner;
players.resetPlayerOnRestart = id => { resets++; return resetPlayer(id); };
fleets.deleteFleetsByOwner = id => { fleetClears++; return clearFleets(id); };
const router = require('./sync');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const snapshot = id => db.prepare(`SELECT origin_system, logins, level, points, total_planets,
    biology, race_speed, has_intel, intel_updated_at FROM players WHERE id = ?`).get(id);
const fleetRows = () => db.prepare('SELECT * FROM fleets ORDER BY owner_id').all();
db.exec(`
    INSERT INTO systems (id, name, x, y) VALUES (10, 'Synthetic origin A', 0, 0), (20, 'Synthetic origin B', 5, 5);
    INSERT INTO players (id, name, origin_system, logins, level, points, total_planets,
        biology, race_speed, has_intel, intel_updated_at)
    VALUES (101, 'Synthetic navigator', 10, 200, 20, 10000, 10, 30, 2, 1, '2098-01-01 00:00:00'),
           (102, 'Synthetic other owner', 10, 200, 20, 10000, 10, 30, 2, 1, '2098-01-01 00:00:00');
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (1001, 10, 1, 101);
`);
const publicProfile = extra => ({ id: 101, name: 'Synthetic navigator', origin_system: 10,
    logins: 200, level: 20, points: 10000, total_planets: 10, has_intel: 0, ...extra });
function seed() {
    db.exec(`UPDATE players SET origin_system=10, logins=200, level=20, points=10000, total_planets=10 WHERE id=101;
        DELETE FROM fleets;
        INSERT INTO fleets (owner_id, system_id, planet_index, destroyers) VALUES (101, 10, 1, 300), (102, 20, 1, 200);`);
    resets = 0;
    fleetClears = 0;
}
let port;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', router);
function sync(payload) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/hub-api/sync/player',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (err) { reject(err); } });
        });
        req.on('error', reject);
        req.end(data);
    });
}

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
    try {
        // The direct nulling path: before the fix no reset fired here, yet upsert still
        // replaced the recorded origin with NULL. This is separate from the issue's
        // speculative link between an origin-change restart and missing roster members.
        for (const origin of [null, undefined, 0, '', 'N/A', -1, 2.5, true, false, {}, [], '12oops', Number.MAX_SAFE_INTEGER + 1]) {
            seed();
            const before = fleetRows();
            const r = await sync(publicProfile({ origin_system: origin }));
            ok(`missing or invalid origin ${JSON.stringify(origin)} keeps the last positive origin`, r.status === 200 && snapshot(101).origin_system === 10, snapshot(101));
            ok('missing-origin sync neither triggers reset nor changes recorded fleets', resets === 0 && fleetClears === 0 && same(before, fleetRows()));
        }
        seed();
        const before = fleetRows();
        const oldIntel = snapshot(101);
        let r = await sync(publicProfile({ origin_system: 20 }));
        ok('a single changed positive origin is accepted without destructive restart', r.status === 200 && snapshot(101).origin_system === 20
            && resets === 0 && fleetClears === 0, snapshot(101));
        ok('origin-only change preserves recorded fleets and existing intel', same(before, fleetRows())
            && snapshot(101).biology === oldIntel.biology && snapshot(101).race_speed === oldIntel.race_speed
            && snapshot(101).intel_updated_at === oldIntel.intel_updated_at);
        r = await sync(publicProfile({ origin_system: 20 }));
        ok('repeating the new origin alone still does not delete intel', r.status === 200 && resets === 0 && same(before, fleetRows()));
        r = await sync(publicProfile({ origin_system: 10 }));
        ok('a transient differing origin can return without losing fleets', r.status === 200 && snapshot(101).origin_system === 10 && resets === 0 && same(before, fleetRows()));
        r = await sync(publicProfile({ origin_system: '20' }));
        ok('an integer system id string is normalized consistently', r.status === 200 && snapshot(101).origin_system === 20 && resets === 0);

        for (const logins of [199, 100, 0, undefined]) {
            seed();
            r = await sync(publicProfile({ origin_system: 20, logins }));
            ok(`origin change with counter ${JSON.stringify(logins)} alone does not clear fleets`, r.status === 200 && resets === 0 && fleetRows().length === 2);
        }
        seed();
        db.prepare('UPDATE players SET logins=5 WHERE id=101').run();
        r = await sync(publicProfile({ origin_system: 20, logins: 1 }));
        ok('the old low-counter noise threshold remains', r.status === 200 && resets === 0 && fleetRows().length === 2);

        seed();
        r = await sync(publicProfile({ origin_system: 20, logins: 2, level: 1, points: 10, total_planets: 1 }));
        ok('significant observed login drop still resets the profile once', r.status === 200 && resets === 1 && fleetClears === 1);
        ok('a real reset removes only that player fleet intel and stores the supplied new origin', snapshot(101).origin_system === 20
            && snapshot(101).level === 1 && snapshot(101).points === 10 && snapshot(101).total_planets === 1
            && fleetRows().length === 1 && fleetRows()[0].owner_id === 102);
        ok('the reset does not erase intel-derived sciences or race picks', snapshot(101).biology === 30 && snapshot(101).race_speed === 2
            && snapshot(101).has_intel === 1 && snapshot(101).intel_updated_at === '2098-01-01 00:00:00');
        ok('restart handling never rewrites observed planet ownership', db.prepare('SELECT owner_id FROM planets WHERE system_id=10 AND planet_index=1').get().owner_id === 101);

        seed();
        r = await sync(publicProfile({ origin_system: null, logins: 2, level: 1, points: 10, total_planets: 1 }));
        ok('login reset with no new origin does not resurrect the previous origin', r.status === 200 && resets === 1 && snapshot(101).origin_system === null);
        r = await sync(publicProfile({ origin_system: null, logins: 3, level: 1, points: 10, total_planets: 1 }));
        ok('a later hidden-origin profile remains unknown after a genuine reset', r.status === 200 && snapshot(101).origin_system === null && resets === 1);
        r = await sync(publicProfile({ origin_system: 20, logins: 4, level: 1, points: 10, total_planets: 1 }));
        ok('the next visible origin repopulates the restarted profile', r.status === 200 && snapshot(101).origin_system === 20 && resets === 1);

        r = await sync(publicProfile({ id: 103, name: 'Synthetic new profile', origin_system: null, logins: 1 }));
        ok('a never-observed origin stays unknown for a new player', r.status === 200 && snapshot(103).origin_system === null);
        r = await sync(publicProfile({ id: 104, name: 'Synthetic invalid profile', origin_system: true, logins: 1 }));
        ok('invalid input cannot invent an origin for a new player', r.status === 200 && snapshot(104).origin_system === null);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${pass} checks passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
