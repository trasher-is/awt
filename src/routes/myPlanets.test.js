// My Savings (2026-09-18): GET /hub-api/my-planets, POST /hub-api/sync/my-planets, and the
// per-planet banking toggle. "Own" is resolved the same way /intel/me/planets resolves it.
//
// Run with: node src/routes/myPlanets.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-my-planets-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const myPlanetsRouter = require('./myPlanets');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('myPlanets.test.js');

let sessionUserId = 1;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: sessionUserId }; next(); });
app.use('/hub-api', myPlanetsRouter);

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
        // Case differs from the account's game name on purpose: the bridge join is LOWER() on both sides.
        usersRepo.createUser('OwnerOne', 'not-a-real-hash', 'user', null);
        const owner = usersRepo.getUserByGameName('OwnerOne');
        db.prepare(`INSERT INTO players (id, name) VALUES (301, 'ownerone'), (302, 'Neighbour')`).run();
        usersRepo.createUser('Neighbour', 'not-a-real-hash', 'user', null);
        const neighbour = usersRepo.getUserByGameName('Neighbour');

        console.log('\n── An account the hub cannot map to a player ' + '─'.repeat(30));
        sessionUserId = 1;
        let r = await request(server, 'GET', '/hub-api/my-planets');
        ok('GET answers success:false with a reason, not a 404/500', r.status === 200 && r.body.success === false && /No player on record/.test(r.body.error), r.body);
        r = await request(server, 'POST', '/hub-api/sync/my-planets', { planets: [] });
        ok('POST sync 404s for an unmapped account', r.status === 404, r.body);

        console.log('\n── An invalid sync payload is rejected ' + '─'.repeat(36));
        sessionUserId = owner.id;
        r = await request(server, 'POST', '/hub-api/sync/my-planets', {});
        ok('missing planets is a 400', r.status === 400, r.body);

        console.log('\n── First sync: planets stored, banking defaults to false ' + '─'.repeat(15));
        r = await request(server, 'POST', '/hub-api/sync/my-planets', {
            planets: [
                { game_planet_id: 18292, system_id: 40, name: 'Minchir #5', population: 11, population_progress: 104, growth_rate: 11.8, production_pp: 445, production_rate: 24.8 },
                { game_planet_id: 18281, system_id: 43, name: 'Alrescha #10', population: 3, production_pp: 9, production_rate: 11.8 },
            ],
        });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        r = await request(server, 'GET', '/hub-api/my-planets');
        ok('both planets come back', r.body.success && r.body.planets.length === 2, r.body);
        ok('banking defaults to 0 (still building) for a never-toggled planet', r.body.planets.every(p => p.banking === 0), r.body.planets);
        const withGrowthData = r.body.planets.find(p => p.game_planet_id === 18292);
        ok('population_progress and growth_rate round-trip', withGrowthData.population_progress === 104 && withGrowthData.growth_rate === 11.8, withGrowthData);
        const withoutGrowthData = r.body.planets.find(p => p.game_planet_id === 18281);
        ok('an omitted growth_rate/population_progress stays null, not 0', withoutGrowthData.population_progress === null && withoutGrowthData.growth_rate === null, withoutGrowthData);
        // 2026-09-20: the sync also totals production_pp across every planet into
        // alliance_member_stats.production_points, replacing the Alliance member-sheet's
        // coarser figure for this member's own row — see myPlanets.js's own comment.
        let statsRow = db.prepare('SELECT production_points FROM alliance_member_stats WHERE player_id = 301').get();
        ok('production_points is the sum of every synced planet\'s production_pp (445 + 9)', Number(statsRow.production_points) === 454, statsRow);

        console.log('\n── Toggling banking on ' + '─'.repeat(53));
        r = await request(server, 'POST', '/hub-api/my-planets/18292/banking', { banking: true });
        ok('toggle succeeds', r.status === 200 && r.body.success, r.body);
        r = await request(server, 'GET', '/hub-api/my-planets');
        const toggled = r.body.planets.find(p => p.game_planet_id === 18292);
        const untouched = r.body.planets.find(p => p.game_planet_id === 18281);
        ok('the toggled planet now reports banking', toggled.banking === 1, toggled);
        ok('the other planet is untouched', untouched.banking === 0, untouched);

        console.log('\n── A resync preserves banking, drops missing planets, adds new ones ' + '─'.repeat(3));
        r = await request(server, 'POST', '/hub-api/sync/my-planets', {
            planets: [
                { game_planet_id: 18292, system_id: 40, name: 'Minchir #5', population: 11, production_pp: 460, production_rate: 25.1 },
                { game_planet_id: 18267, system_id: 42, name: 'Alshemali #12', population: 8, production_pp: 396, production_rate: 21.6 },
            ],
        });
        ok('resync succeeds', r.status === 200 && r.body.success, r.body);
        r = await request(server, 'GET', '/hub-api/my-planets');
        const ids = r.body.planets.map(p => p.game_planet_id).sort();
        ok('the dropped planet (18281) is gone and the new one (18267) is present', JSON.stringify(ids) === JSON.stringify([18267, 18292]), ids);
        const stillBanking = r.body.planets.find(p => p.game_planet_id === 18292);
        const freshPlanet = r.body.planets.find(p => p.game_planet_id === 18267);
        ok('the surviving planet keeps its banking flag across the resync', stillBanking.banking === 1, stillBanking);
        ok('the freshly-seen planet defaults to still-building', freshPlanet.banking === 0, freshPlanet);
        ok('the resync also refreshed the production numbers', stillBanking.production_pp === 460 && stillBanking.production_rate === 25.1, stillBanking);
        statsRow = db.prepare('SELECT production_points FROM alliance_member_stats WHERE player_id = 301').get();
        ok('production_points follows the resync too (460 + 396)', Number(statsRow.production_points) === 856, statsRow);

        console.log('\n── A toggle cannot reach another account\'s planet ' + '─'.repeat(26));
        sessionUserId = neighbour.id;
        r = await request(server, 'POST', '/hub-api/my-planets/18292/banking', { banking: true });
        ok('404s rather than silently touching someone else\'s planet', r.status === 404, r.body);
        sessionUserId = owner.id;
        r = await request(server, 'GET', '/hub-api/my-planets');
        ok('the owner\'s planet is unaffected by the other account\'s attempt', r.body.planets.find(p => p.game_planet_id === 18292).banking === 1);

        console.log('\n── Toggle input validation ' + '─'.repeat(47));
        r = await request(server, 'POST', '/hub-api/my-planets/18292/banking', { banking: 'yes' });
        ok('a non-boolean banking value is a 400', r.status === 400, r.body);
        r = await request(server, 'POST', '/hub-api/my-planets/not-a-number/banking', { banking: true });
        ok('a non-integer planet id is a 400', r.status === 400, r.body);

        console.log('\n── TR outlook: projected population-10 crossings, alliance-wide ' + '─'.repeat(6));
        // Membership for the outlook join is alliance_member_stats, same as Board. 301
        // already has a row (the sync above now also writes production_points into it —
        // see the assertions above), so this only needs to add 302.
        db.prepare(`INSERT OR IGNORE INTO alliance_member_stats (player_id) VALUES (301), (302)`).run();
        db.prepare(`INSERT INTO players (id, name) VALUES (303, 'NoPlanetsYet')`).run();
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (303)`).run();
        // ownerone (301): one qualified planet already, one at pop 9 close to qualifying,
        // one at pop 8 further out, one at pop 5 with no observed growth rate (unknown —
        // must not count as "never" and sort last, nor as "now").
        db.prepare(`DELETE FROM planet_banking WHERE player_id = 301`).run();
        db.prepare(`
            INSERT INTO planet_banking (game_planet_id, player_id, population, population_progress, growth_rate, banking)
            VALUES (91001, 301, 10, 0, 5, 0),
                   (91002, 301, 9, 300, 15, 0),
                   (91003, 301, 8, 200, 20, 0),
                   (91004, 301, 5, NULL, NULL, 0)
        `).run();
        sessionUserId = owner.id;
        r = await request(server, 'GET', '/hub-api/trade-agreements/tr-outlook');
        ok('200 and success', r.status === 200 && r.body.success, r.body);
        const mine = r.body.members.find(m => m.name.toLowerCase() === 'ownerone');
        ok('one planet already qualifies (population 10+)', mine.qualified_now === 1, mine);
        // pop 9, 300/813 banked, +15/h -> (813-300)/15 = 34.2h. pop 8, 200/1464 (651+813), +20/h -> (1464-200)/20 = 63.2h.
        ok('the soonest crossing is the pop-9 planet, ~34.2h out', Math.abs(mine.next_hours - 34.2) < 0.01, mine);
        ok('the second crossing is the pop-8 planet, ~63.2h out', Math.abs(mine.next2_hours - 63.2) < 0.01, mine);
        ok('the unknown-growth-rate planet is neither counted nor invented as a third crossing', mine.next_hours < mine.next2_hours && Object.keys(mine).length === 4, mine);

        ok('a member who has never opened My Savings has no entry at all (not a 0%)', !r.body.members.some(m => m.name.toLowerCase() === 'noplanetsyet'), r.body.members);
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
