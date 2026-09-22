// GET /hub-api/routes/jump-windows — which of our planets to launch from so the fleet
// lands while the target is away.
//
// src/utils/jump-windows.test.js covers the choice itself. What is checked here is what
// only the route can get wrong: being swallowed by `/routes/:id`, treating an ally's planet
// as somewhere we can launch from, planning against our own members, and rebuilding two
// weeks of login profiles every time somebody nudges the speed selector.
//
// Run with: node src/routes/routes-jump-windows.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-jump-windows-test-')), 'test.db');
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

console.log('routes-jump-windows.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Caveman' }; next(); });
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
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (80, 'Renegade Raiders', 'RAID')`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (81, 'Non-aggression partner', 'NAP')`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (82, 'Human Never United', 'HNU')`).run();

db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (1, 'Caveman', 80)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (2, 'Harpyie', 80)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (3, 'Napper', 81)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (4, 'Sleeper', 82)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (5, 'Insomniac', 82)`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (6, 'Unsampled')`).run();

// ownAllianceTags() reads the members carried in alliance_member_stats.
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (1)`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (2)`).run();

// The three jump points are placed one map unit apart from each other, which at energy 0
// makes their flight times 11.75h, 21.75h and 31.75h: three arrival hours spread around
// the clock with no gap wider than ten hours between them. The sleeper below is away for
// sixteen, so at least one of the three always lands inside the window — checked by
// running this geometry through hourProfile()/bestOriginNow() at all 96 quarter-hours of
// a day, not by reasoning about it: 0 misses.
//
// That property is the whole point of the arrangement. The first version of this fixture
// had two origins and a four-hour sleep window, which made the "it lands in the dark"
// assertion depend on the wall clock: it passed all afternoon and failed at 18:00 UTC on
// the merged branch, because at that hour neither of the two available arrival hours fell
// inside the window. The code was right — it picked the best arrival available — and the
// test was wrong to demand a specific one.
const system = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`);
system.run(1, 'HomeNear', 1, 0);
system.run(6, 'HomeMid', 2, 0);
system.run(2, 'HomeFar', 3, 0);
system.run(3, 'NapWorld', 5, 0);
system.run(4, 'TargetSpace', 0, 0);
system.run(5, 'NoCoords', null, null);

const planet = db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (?, ?, ?, ?)`);
planet.run(1, 1, 6, 1);     // ours (the viewer's own)
planet.run(8, 6, 6, 2);     // ours (a team-mate's), the middle jump point
planet.run(2, 2, 6, 2);     // ours (a team-mate's)
planet.run(3, 3, 6, 3);     // an ally's — NOT a place we can launch from
planet.run(4, 4, 6, 4);     // Sleeper's planet
planet.run(5, 4, 7, 5);     // Insomniac's planet
planet.run(6, 4, 8, 6);     // an unsampled player's planet
planet.run(7, 5, 1, 4);     // Sleeper again, in a system with no coordinates

// Fourteen days of scans every 15 minutes. Sleeper is away 00:00-15:59 UTC, a window wide
// enough that one of the three arrival hours above always falls inside it; Insomniac is
// never away. Both get far more than the 20-sample floor.
const sample = db.prepare(`INSERT INTO player_login_samples (player_id, total_logins, observed_at) VALUES (?, ?, ?)`);
const NOW = Date.now();
let counters = { 4: 500, 5: 900 };
for (let t = NOW - 14 * 24 * HOUR; t <= NOW; t += 15 * 60 * 1000) {
    const hour = new Date(t).getUTCHours();
    if (hour >= 16) counters[4] += 1;
    counters[5] += 1;
    sample.run(4, counters[4], sqlTime(t));
    sample.run(5, counters[5], sqlTime(t));
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    // `/routes/:id` is registered in this same router and ':id' matches the literal string
    // 'jump-windows'. Registered in the wrong order, every request here answered the route
    // planner's own 404 — which is exactly what happened the first time.
    const res = await getJson(server, '/hub-api/routes/jump-windows?days=14');
    ok('the URL reaches this handler and not the /routes/:id lookup', res.status === 200, { status: res.status, body: res.body });
    const body = res.body;
    ok('reports success', body && body.success === true);

    // --- Jump points -------------------------------------------------------
    const originSystems = body.origins.map(o => o.system_id).sort();
    ok('our own planets are jump points', originSystems.includes(1) && originSystems.includes(2), originSystems);
    ok("an allied alliance's planet is NOT a jump point — a NAP is not somewhere we can put a fleet",
        !originSystems.includes(3), originSystems);
    ok("the viewer's own planet is marked as theirs",
        body.origins.find(o => o.system_id === 1).is_mine === true, body.origins);
    ok("a team-mate's planet is not marked as the viewer's",
        body.origins.find(o => o.system_id === 2).is_mine === false, body.origins);

    // --- Targets -----------------------------------------------------------
    const names = body.targets.map(t => t.player_name);
    ok('an enemy planet is a target', names.includes('Sleeper'), names);
    ok('our own members are never targets', !names.includes('Caveman') && !names.includes('Harpyie'), names);
    ok('a target in a system with no coordinates is skipped',
        !body.targets.some(t => t.system_id === 5), body.targets.map(t => t.system_id));
    ok('a player the hub has never sampled is still listed, marked unsampled',
        body.targets.some(t => t.player_name === 'Unsampled' && t.sampled === false), names);

    const sleeper = body.targets.find(t => t.player_name === 'Sleeper');
    const insomniac = body.targets.find(t => t.player_name === 'Insomniac');
    ok('the sleeper is profiled', sleeper && sleeper.sampled === true, sleeper);
    ok('the sleeper outranks the player who is never away',
        body.targets.indexOf(sleeper) < body.targets.indexOf(insomniac),
        body.targets.map(t => [t.player_name, t.launchNow.awayScore]));
    // Deterministic by the geometry above, not by luck: the three jump points are never
    // more than ten hours apart on the clock and the window is fourteen.
    ok('the launch-now plan lands in the hours the sleeper is away',
        sleeper.launchNow.arrivalHour >= 0 && sleeper.launchNow.arrivalHour <= 14,
        { hour: sleeper.launchNow.arrivalHour, from: sleeper.launchNow.origin_system_id });
    ok('the arrival hour is the hour the arrival instant actually falls in',
        sleeper.launchNow.arrivalHour === new Date(sleeper.launchNow.arriveAt).getUTCHours(),
        { hour: sleeper.launchNow.arrivalHour, at: new Date(sleeper.launchNow.arriveAt).toISOString() });
    ok('the launch-now plan names which planet to launch from, and whose it is',
        Number.isInteger(sleeper.launchNow.origin_system_id) && !!sleeper.launchNow.origin_owner, sleeper.launchNow);
    ok('the launch-now plan carries the origin coordinates for the map to draw an arc',
        Number.isFinite(sleeper.launchNow.origin_x) && Number.isFinite(sleeper.launchNow.origin_y), sleeper.launchNow);
    ok('the scheduled plan says when to launch, and it is not in the past',
        sleeper.scheduled && sleeper.scheduled.launchAt >= body.generatedAt - 1000, sleeper.scheduled);
    ok('the trough is reported so the tooltip can name the window',
        sleeper.trough && sleeper.trough.hours >= 3, sleeper.trough);
    ok('the player who is never away scores low rather than being hidden',
        insomniac.launchNow.awayScore < 0.3, insomniac.launchNow);

    // --- Parameters --------------------------------------------------------
    const fast = await getJson(server, '/hub-api/routes/jump-windows?energy=20&days=14');
    const fastSleeper = fast.body.targets.find(t => t.player_name === 'Sleeper');
    ok('a higher energy level shortens the flight',
        fastSleeper.launchNow.travelHours < sleeper.launchNow.travelHours,
        { slow: sleeper.launchNow.travelHours, fast: fastSleeper.launchNow.travelHours });
    ok('the parameters used are echoed back', fast.body.energy === 20, fast.body.energy);

    const filtered = await getJson(server, '/hub-api/routes/jump-windows?minScore=0.8&days=14');
    ok('a minimum away-score filters the list',
        filtered.body.targets.every(t => t.launchNow.awayScore >= 0.8), filtered.body.targets.map(t => t.launchNow.awayScore));

    const junk = await getJson(server, '/hub-api/routes/jump-windows?energy=nonsense&speed=99&minScore=7&days=0');
    ok('nonsense parameters fall back to the defaults rather than being clamped into range',
        junk.body.energy === 0 && junk.body.raceSpeed === 0 && junk.body.days === 14, junk.body);

    // --- The profile memo --------------------------------------------------
    ok('the first call builds the profiles', body.profilesCached === false, body.profilesCached);
    ok('changing only the speed reuses them — they cannot depend on it',
        fast.body.profilesCached === true, fast.body.profilesCached);
    routesRouter.__clearProfileCache();
    const rebuilt = await getJson(server, '/hub-api/routes/jump-windows?days=14');
    ok('clearing the memo rebuilds them', rebuilt.body.profilesCached === false, rebuilt.body.profilesCached);
    const otherWindow = await getJson(server, '/hub-api/routes/jump-windows?days=7');
    ok('a different window is a different memo, not a stale hit', otherWindow.body.profilesCached === false, otherWindow.body.profilesCached);

    server.close();
    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
