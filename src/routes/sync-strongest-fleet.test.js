// Regression coverage for /sync/strongest-fleet (2026-09-20, war-tool groundwork; one row
// per fleet with its planet since 2026-10-08 -- see database.js's strongest_fleet comment).
//
// What this route exists to get right:
// (1) each listed player's rows are replaced, players missing from THIS sync keep theirs;
// (2) a player's simultaneous fleets are all kept, each at its own planet;
// (3) "System #N" resolves to a known system, and an unknown system keeps its text;
// (4) a row whose CV does not add up from its ships is rejected -- the 2026-10-04 layout
//     change shifted every column and was stored without complaint for four days;
// (5) an owner who isn't a known player is skipped;
// (6) anything untouched for 5+ days is purged before each sync.
//
// Run with: node src/routes/sync-strongest-fleet.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-strongest-fleet-test-')), 'test.db');
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

console.log('sync-strongest-fleet.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
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
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        const page = require('./fixtures/strongest-fleet-2026-10-08');
        const asRow = ([rank, player_id, , planet, cv, destroyers, cruisers, battleships]) =>
            ({ rank, player_id, planet, cv, destroyers, cruisers, battleships });

        db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'ZOD', 'Zodiac')`).run();
        const knownPlayers = [...new Map(page.map(r => [r[1], r[2]])).entries()];
        const addPlayer = db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (?, ?, 1)`);
        for (const [id, name] of knownPlayers) if (id !== 427) addPlayer.run(id, name); // BeanLow unknown to the hub
        const systemNames = [...new Set(page.map(r => r[3].replace(/\s*#\d+$/, '')))].filter(n => n !== 'Muliphen');
        const addSystem = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, 0, 0)`);
        systemNames.forEach((name, i) => addSystem.run(1000 + i, name));
        const sysId = name => db.prepare(`SELECT id FROM systems WHERE name = ?`).get(name).id;
        db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (1, ?, 4, 393)`).run(sysId('Beshgar Noctis'));

        console.log('\n── The real 2026-10-08 page ' + '─'.repeat(48));
        const firstRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', { rows: page.map(asRow) });
        ok('sync succeeds and rejects nothing -- every real row adds up', firstRes.status === 200 && firstRes.body.success && firstRes.body.rejected === 0, firstRes.body);

        const stored = db.prepare(`SELECT * FROM strongest_fleet ORDER BY rank`).all();
        ok('49 rows: every fleet except the unknown owner BeanLow', stored.length === 49, stored.length);
        const hypnos = stored.filter(r => r.player_id === 393);
        ok('all three of Hypnos\'s fleets are kept, each at its own planet',
            hypnos.length === 3 && hypnos.map(r => r.planet_label).join('|') === 'Beshgar Noctis #4|Beshgar Noctis #6|Praepes #9', hypnos);
        const moardin = stored.find(r => r.player_id === 19);
        ok('fields land in the right columns (Moardin25: 1482 CV = 142 DS / 29 CR / 6 BS at Kajam #8)',
            moardin.cv === 1482 && moardin.destroyers === 142 && moardin.cruisers === 29 && moardin.battleships === 6
            && moardin.system_id === sysId('Kajam') && moardin.planet_index === 8, moardin);
        ok('a non-ASCII system name resolves (Sazan at Altaïr #12)',
            stored.find(r => r.player_id === 107).system_id === sysId('Altaïr'), stored.find(r => r.player_id === 107));

        console.log('\n── Second sync: Hypnos down to one fleet, in an unscanned system; Wearic absent ' + '─'.repeat(1));
        const secondRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', {
            rows: [{ rank: 5, player_id: 393, planet: 'Muliphen #2', cv: 1200, destroyers: 400, cruisers: 0, battleships: 0 }],
        });
        ok('second sync succeeds', secondRes.status === 200 && secondRes.body.success, secondRes.body);
        const hypnosNow = db.prepare(`SELECT * FROM strongest_fleet WHERE player_id = 393`).all();
        ok('Hypnos\'s three old fleets are replaced by the one listed now',
            hypnosNow.length === 1 && hypnosNow[0].cv === 1200, hypnosNow);
        ok('an unscanned system keeps the printed text and planet number, with no system id',
            hypnosNow[0].system_id === null && hypnosNow[0].planet_index === 2 && hypnosNow[0].planet_label === 'Muliphen #2', hypnosNow[0]);
        ok('Wearic, absent from this scrape, keeps both his fleets',
            db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet WHERE player_id = 422`).get().n === 2);

        console.log('\n── A shifted layout is rejected, not stored ' + '─'.repeat(33));
        // What the pre-2026-10-08 scraper sent for Moardin25's row: Planet's number as cv, cv as destroyers.
        const shiftedRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', {
            rows: [{ rank: 4, player_id: 19, cv: 8, destroyers: 1482, cruisers: 142, battleships: 29 }],
        });
        ok('the sync reports the row as rejected', shiftedRes.status === 200 && shiftedRes.body.rejected === 1, shiftedRes.body);
        const moardinNow = db.prepare(`SELECT * FROM strongest_fleet WHERE player_id = 19`).all();
        ok('Moardin25\'s good row is untouched', moardinNow.length === 1 && moardinNow[0].cv === 1482, moardinNow);

        console.log('\n── A row untouched for 5+ days is purged on the next sync ' + '─'.repeat(17));
        db.prepare(`UPDATE strongest_fleet SET updated_at = datetime('now', '-6 days') WHERE player_id = 422`).run();
        const thirdRes = await request(server, 'POST', '/hub-api/sync/strongest-fleet', { rows: [] });
        ok('an empty-payload sync still succeeds', thirdRes.status === 200 && thirdRes.body.success, thirdRes.body);
        ok('Wearic\'s 6-day-stale rows are gone; Hypnos\'s fresh row survives',
            db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet WHERE player_id = 422`).get().n === 0
            && db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet WHERE player_id = 393`).get().n === 1);
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
