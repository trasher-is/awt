// My Savings (2026-09-18): GET /hub-api/my-planets, POST /hub-api/sync/my-planets, and the
// per-planet banking toggle. "Own" is resolved the same way /intel/me/planets resolves it.
//
// Run with: node src/routes/myPlanets.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

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

        console.log('\n── "Update my data": how old each part is ' + '─'.repeat(33));
        const memberDataSyncsRepo = require('../repositories/memberDataSyncs');
        sessionUserId = owner.id;
        r = await request(server, 'GET', '/hub-api/my-data-status');
        ok('200 and success', r.status === 200 && r.body.success, r.body);
        ok('the planet syncs above stamped Planets', Number.isInteger(r.body.synced.planets) && Date.now() - r.body.synced.planets < 60 * 1000, r.body.synced);
        ok('Science and Trade were never read: null, not 0', r.body.synced.science === null && r.body.synced.trade === null, r.body.synced);
        memberDataSyncsRepo.stamp(301, 'science', 1760000000000);
        r = await request(server, 'GET', '/hub-api/my-data-status');
        ok('a Science read shows up with its own time', r.body.synced.science === 1760000000000, r.body.synced);
        sessionUserId = neighbour.id;
        r = await request(server, 'GET', '/hub-api/my-data-status');
        ok('another member sees only their own times', r.body.success && r.body.synced.science === null, r.body);
        sessionUserId = 1;
        r = await request(server, 'GET', '/hub-api/my-data-status');
        ok('an account with no player on record gets success:false, not an error', r.status === 200 && r.body.success === false, r.body);
        let threw = false;
        try { memberDataSyncsRepo.stamp(301, 'galaxy'); } catch (e) { threw = true; }
        ok('only the three known kinds can be stamped', threw);

        console.log('\n── A planet that changed owner does not block the new owner\'s sync ' + '─'.repeat(5));
        db.prepare(`INSERT INTO players (id, name) VALUES (304, 'ConquerorA'), (305, 'ConquerorB')`).run();
        usersRepo.createUser('ConquerorA', 'not-a-real-hash', 'user', null);
        usersRepo.createUser('ConquerorB', 'not-a-real-hash', 'user', null);
        const memberA = usersRepo.getUserByGameName('ConquerorA');
        const memberB = usersRepo.getUserByGameName('ConquerorB');
        const planet = (id, pp = 10) => ({ game_planet_id: id, system_id: 7, name: `Synthetic #${id}`, population: 2, production_pp: pp, production_rate: 1.5 });
        const syncAs = (user, planets) => { sessionUserId = user.id; return request(server, 'POST', '/hub-api/sync/my-planets', { planets }); };
        const planetsOf = async (user) => {
            sessionUserId = user.id;
            const res = await request(server, 'GET', '/hub-api/my-planets');
            return res.body.planets;
        };
        const idsOf = (planets) => JSON.stringify(planets.map(p => p.game_planet_id).sort((x, y) => x - y));

        await syncAs(memberA, [planet(92001), planet(92002)]);
        await syncAs(memberB, [planet(92003), planet(92004)]);
        sessionUserId = memberA.id;
        await request(server, 'POST', '/hub-api/my-planets/92001/banking', { banking: true });
        sessionUserId = memberB.id;
        await request(server, 'POST', '/hub-api/my-planets/92003/banking', { banking: true });
        memberDataSyncsRepo.stamp(305, 'planets', 1760000000000);

        // B conquers 92001. A has not synced since, so A's row still holds it.
        r = await syncAs(memberB, [planet(92001, 50), planet(92003, 60), planet(92004, 70)]);
        ok('the conqueror\'s sync succeeds while the previous owner\'s row still holds the planet', r.status === 200 && r.body.success, r.body);
        let planetsB = await planetsOf(memberB);
        ok('the conquered planet is now on the conqueror\'s list', idsOf(planetsB) === '[92001,92003,92004]', planetsB);
        ok('it is gone from the previous owner\'s list, before they sync', idsOf(await planetsOf(memberA)) === '[92002]');
        ok('the previous owner\'s banking flag does not come with it', planetsB.find(p => p.game_planet_id === 92001).banking === 0, planetsB);
        ok('the conqueror keeps the flag on a planet they already held', planetsB.find(p => p.game_planet_id === 92003).banking === 1, planetsB);
        ok('the rest of the sync ran: production_points is the conqueror\'s new total', Number(db.prepare('SELECT production_points FROM alliance_member_stats WHERE player_id = 305').get().production_points) === 180);
        ok('the rest of the sync ran: the Planets age is fresh', Date.now() - memberDataSyncsRepo.getForPlayer(305).planets < 60 * 1000);

        // Each member takes a planet from the other before either has synced: each list
        // holds a planet still on the other's row, so whoever syncs first must not be blocked.
        await syncAs(memberA, [planet(92011)]);
        await syncAs(memberB, [planet(92012)]);
        r = await syncAs(memberA, [planet(92012)]);
        ok('a swap: the first member to sync succeeds', r.status === 200 && r.body.success, r.body);
        r = await syncAs(memberB, [planet(92011)]);
        ok('a swap: the second member to sync succeeds', r.status === 200 && r.body.success, r.body);
        ok('a swap: each member ends up with the planet they hold now', idsOf(await planetsOf(memberA)) === '[92012]' && idsOf(await planetsOf(memberB)) === '[92011]');

        console.log('\n── An open Planets tab does not keep re-sending its list ' + '─'.repeat(17));
        const parserSource = fs.readFileSync(path.join(__dirname, '../../public/js/utils/my-planets-parser.js'), 'utf8')
            .replace(/^import .*$/gm, '')
            .replace(/^export /gm, '');
        const cell = (text, sort) => ({ textContent: text, getAttribute: () => sort ?? null, querySelector: () => null });
        const pageRow = (id, pp) => ({
            getAttribute: () => String(id),
            querySelectorAll: () => [cell('', '7'), cell('Synthetic'), cell('2'), cell(''), cell('1'), cell(String(pp), String(pp)), cell('1')],
        });
        let pageRows = [pageRow(92021, 10)];
        let clock = 1760000000000;
        let hubAnswersOk = true;
        const posts = [];
        const page = vm.createContext({
            AWNumber: require('../../public/js/utils/parse-number.js'),
            document: { querySelectorAll: () => pageRows },
            Date: { now: () => clock },
            fetch: async (url, options) => { posts.push({ url, options }); return { ok: hubAnswersOk }; },
        });
        vm.runInContext(parserSource, page);
        const scrape = () => vm.runInContext('scrapeMyPlanets()', page);
        const MINUTE = 60 * 1000;

        await scrape();
        ok('the first read of the page is sent', posts.length === 1 && posts[0].url === '/hub-api/sync/my-planets', posts);
        clock += 17 * 60 * MINUTE;
        await scrape();
        ok('an unchanged list the hub stored is not sent again, even hours later', posts.length === 1, posts.length);
        pageRows = [pageRow(92021, 11)];
        await scrape();
        ok('a list that changed in the page is sent right away', posts.length === 2, posts.length);
        pageRows = [pageRow(92021, 12)];
        hubAnswersOk = false;
        await scrape();
        ok('a changed list is sent even when the hub then refuses it', posts.length === 3, posts.length);
        clock += 30 * 1000;
        await scrape();
        ok('a refused list is not retried within the minute', posts.length === 3, posts.length);
        clock += MINUTE;
        hubAnswersOk = true;
        await scrape();
        ok('a refused list is retried after a minute', posts.length === 4, posts.length);
        clock += 2 * MINUTE;
        await scrape();
        ok('once stored, that list is not sent again either', posts.length === 4, posts.length);
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
