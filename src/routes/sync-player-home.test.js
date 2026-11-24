// A profile only lists the planets its viewer can see. A scrape by a member without sight of
// a player's system must not erase or replace the home another member recorded — that made
// the Science page's launch times hours wrong (2026-11-23). Drives the real HTTP receiver.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-player-home-'));
process.env.AWT_DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const players = require('../repositories/players');
const router = require('./sync');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
db.exec(`
    INSERT INTO systems (id, name, x, y) VALUES (4, 'Home system', 4, -1), (9, 'Elsewhere', 20, 20);
    INSERT INTO players (id, name, origin_system, logins) VALUES (501, 'Synthetic settler', 4, 17);
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES
        (7011, 4, 11, 501), (7012, 4, 12, 501), (9003, 9, 3, 501);
`);
const HOME = { home_planet_id: 7011, home_system_id: 4, home_planet_index: 11 };
const at = (system_id, planet_index) => ({ system_id, planet_index });
const payload = extra => ({ id: 501, name: 'Synthetic settler', origin_system: 4, logins: 17, has_intel: 0, ...extra });
const home = () => {
    const r = db.prepare('SELECT home_planet_id, home_system_id, home_planet_index, possible_homes FROM players WHERE id=501').get();
    return `${r.home_planet_id}|${r.home_system_id}|${r.home_planet_index}|${r.possible_homes}`;
};
const ORIGINAL = '7011|4|11|[{"system_id":4,"planet_index":12}]';
function seed() {
    db.exec(`UPDATE players SET origin_system=4, logins=17, home_planet_id=7011, home_system_id=4, home_planet_index=11,
        possible_homes='[{"system_id":4,"planet_index":12}]' WHERE id=501;
        UPDATE planets SET owner_id=501 WHERE game_planet_id=7011;`);
}
let port;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', router);
function sync(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/hub-api/sync/player',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
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
        seed();
        let status = await sync(payload({ visible_planets: [] }));
        ok('a viewer who sees none of the planets keeps the stored home', status === 200 && home() === ORIGINAL, home());
        status = await sync(payload({}));
        ok('the same from an older tab that does not send visible_planets', status === 200 && home() === ORIGINAL, home());
        const origin = players.getPlayerLaunchOrigin(501);
        ok('so launch times still start from the real home planet', origin.system_id === 4 && origin.planet_index === 11, origin);

        seed();
        await sync(payload({ home_planet_id: 9003, home_system_id: 9, home_planet_index: 3, visible_planets: [at(9, 3)] }));
        ok('the biggest planet in a partial view does not replace a home out of sight', home() === ORIGINAL, home());

        seed();
        await sync(payload({ home_planet_id: 7012, home_system_id: 4, home_planet_index: 12, possible_homes: [],
            visible_planets: [at(4, 12), at(4, 11)] }));
        ok('a viewer who sees the old home too can move it', home() === '7012|4|12|[]', home());

        seed();
        db.exec('UPDATE planets SET owner_id=NULL WHERE game_planet_id=7011');
        await sync(payload({ home_planet_id: 9003, home_system_id: 9, home_planet_index: 3, visible_planets: [at(9, 3)] }));
        ok('a home the hub no longer records as theirs is replaced', home() === '9003|9|3|[]', home());

        seed();
        await sync(payload({ home_planet_id: 9003, home_system_id: 9, home_planet_index: 3 }));
        ok('an older tab\'s non-empty pick is accepted as before', home() === '9003|9|3|[]', home());

        seed();
        await sync(payload({ origin_system: 9, visible_planets: [] }));
        ok('a changed origin does not carry the old home over', home() === 'null|null|null|[]', home());

        seed();
        db.prepare('UPDATE players SET logins=200 WHERE id=501').run();
        await sync(payload({ logins: 2, visible_planets: [] }));
        ok('a restart still clears the home', home() === 'null|null|null|[]', home());

        await sync(payload({ ...HOME, visible_planets: [at(4, 11)] }));
        ok('the first sighting after that sets it', home() === '7011|4|11|[]', home());
        for (const junk of ['x', 5, {}, [null, 3, 'a']]) {
            seed();
            status = await sync(payload({ ...HOME, visible_planets: junk }));
            ok(`malformed visible_planets ${JSON.stringify(junk)} is harmless`, status === 200 && home().startsWith('7011|4|11|'), home());
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${pass} checks passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
