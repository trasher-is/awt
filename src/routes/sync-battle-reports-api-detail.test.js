// The game's BattleReport change puts the planet (solarSystemId/planetIndex) and per-side
// shipTypeStats/starbaseStats on the search response itself. /sync/battle-reports stores
// them so the detail sweep does not have to fetch /About/BattleReport/{id} for those
// reports — and falls back to that page fetch whenever the API's detail is incomplete.
// Drives the REAL route against a scratch sqlite database. Synthetic data only.
//
// Run with: node src/routes/sync-battle-reports-api-detail.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-br-api-detail-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
// Never attempt a real Discord login in a test process.
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-battle-reports-api-detail.test.js');

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

const side = (over = {}) => ({
    playerId: null, playerName: null, allianceId: null, allianceTag: null, hasWon: false,
    combatValue: 100, survivedCombatValue: 50, lostCombatValue: 50, ...over,
});
const report = (id, over = {}) => ({
    id, startedAt: `2026-09-2${id % 10}T00:00:00Z`, isPublic: true, winner: 'x', conqueredPlanet: false,
    killedPopulation: 0, randomNumber: 42.5, attacker: side({ hasWon: true }), defender: side(), ...over,
});
const row = id => db.prepare('SELECT * FROM battle_reports WHERE id = ?').get(id);

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        // Report 8003 was already scraped from its page before this sync re-pulls it.
        db.prepare(`INSERT INTO battle_reports (id, started_at, att_destroyers, system_id, planet_index,
            win_chance, ship_detail_scraped_at) VALUES (8003, '2026-09-20T00:00:00Z', 77, 5, 5, 42, CURRENT_TIMESTAMP)`).run();

        const res = await postJson(server, '/hub-api/sync/battle-reports', { reports: [
            // full detail — spelling variants on purpose, cruisers/transports omitted
            report(8001, {
                solarSystemId: 12, planetIndex: 7, planetId: 999, planetName: 'Sample #7',
                attacker: side({ hasWon: true, shipTypeStats: [
                    { shipType: 'Destroyer', amount: 30, lost: 4, survived: 26 },
                    { shipType: 'Battleships', amount: 2, lost: 0, survived: 2 },
                    { shipType: 'ColonyShip', amount: 1, lost: 1, survived: 0 },
                ] }),
                defender: side({ shipTypeStats: [{ shipType: 'Colony Ship', amount: 3, lost: 3, survived: 0 }],
                    starbaseStats: { amount: 2, lost: 1, survived: 1 } }),
            }),
            // location fine, but a ship type we do not know
            report(8002, {
                solarSystemId: 13, planetIndex: 2,
                attacker: side({ hasWon: true, shipTypeStats: [{ shipType: 'Dreadnought', amount: 1, lost: 0, survived: 1 }] }),
                defender: side({ shipTypeStats: [] }),
            }),
            // already page-scraped: must not be overwritten
            report(8003, {
                solarSystemId: 99, planetIndex: 9,
                attacker: side({ hasWon: true, shipTypeStats: [{ shipType: 'Destroyer', amount: 1, lost: 0, survived: 1 }] }),
                defender: side({ shipTypeStats: [{ shipType: 'Destroyer', amount: 1, lost: 1, survived: 0 }] }),
            }),
            // the live API before the change: none of the new fields
            report(8004),
        ] });
        ok('sync succeeds', res.status === 200 && res.body.success, res);
        ok('detail_from_api counts only the report filled completely from the API', res.body.detail_from_api === 1, res.body);

        console.log('\n── (a) complete API detail replaces the page fetch ' + '─'.repeat(20));
        const a = row(8001);
        ok('planet location stored', a.system_id === 12 && a.planet_index === 7, a);
        ok('ship counts/losses stored, spelling variants matched',
            a.att_destroyers === 30 && a.att_destroyers_lost === 4 && a.att_battleships === 2
            && a.att_colony_ships === 1 && a.att_colony_ships_lost === 1 && a.def_colony_ships === 3, a);
        ok('a type the API leaves out is 0, as the page shows it', a.att_cruisers === 0 && a.def_transports === 0, a);
        ok('defender starbases come from starbaseStats', a.def_starbases === 2 && a.def_starbases_lost === 1, a);
        ok('attacker starbases stay NULL (blank on the page)', a.att_starbases === null, a);
        ok('win_chance is not invented (random_number already holds the dice roll)', a.win_chance === null && a.random_number === 42.5, a);
        ok('marked done, so the page sweep will not claim it', a.ship_detail_scraped_at != null, a);

        console.log('\n── (b) incomplete detail keeps the page fetch ' + '─'.repeat(25));
        const b = row(8002);
        ok('location is still taken from the API', b.system_id === 13 && b.planet_index === 2, b);
        ok('ship columns untouched, report not marked done', b.att_destroyers === null && b.ship_detail_scraped_at === null, b);

        console.log('\n── (c) a page-scraped report is never overwritten ' + '─'.repeat(20));
        const c = row(8003);
        ok('page values kept', c.att_destroyers === 77 && c.system_id === 5 && c.win_chance === 42, c);

        console.log('\n── (d) old API shape: nothing changes ' + '─'.repeat(33));
        const d = row(8004);
        ok('no location, not marked done', d.system_id === null && d.ship_detail_scraped_at === null, d);

        const claim = await postJson(server, '/hub-api/sync/battle-report-ship-detail-claim', { limit: 50 });
        const ids = claim.body.ids;
        ok('the page sweep claims exactly the incomplete and old-shape reports',
            ids.includes(8002) && ids.includes(8004) && !ids.includes(8001) && !ids.includes(8003), ids);

        console.log('\n── (e) a later page scrape of a location-only report still fills its ships ' + '─'.repeat(2));
        await postJson(server, '/hub-api/sync/battle-report-ship-detail', { id: 8002, att_destroyers: 5, system_id: 13, planet_index: 2 });
        ok('ships from the page land', row(8002).att_destroyers === 5, row(8002));
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
    console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('Test run crashed:', err); process.exit(1); });
