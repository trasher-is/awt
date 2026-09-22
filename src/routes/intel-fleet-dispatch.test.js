// GET /hub-api/intel/fleet-dispatch — the shortlist drawn under the game's Fleets table.
//
// src/utils/fleet-dispatch.test.js covers the ranking. What is checked here is what only
// the route can get wrong: parsing the fleet list the page sends, which of the two defender
// signals wins and whether the panel is told which, and that a colony-ship fleet is offered
// free planets rather than battles it cannot fight.
//
// Run with: node src/routes/intel-fleet-dispatch.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-fleet-dispatch-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');
const { clearSleepProfileCache } = require('../utils/sleep-profiles');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-fleet-dispatch.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Caveman' }; next(); });
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

const HOUR = 3600 * 1000;
const NOW = Date.now();
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (60, 'Renegade Raiders', 'RAID')`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (61, 'Human Never United', 'HNU')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, energy, race_speed) VALUES (1, 'Caveman', 60, 0, 0)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (2, 'Ranked', 61)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (3, 'OnlyFought', 61)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (4, 'Unseen', 61)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (5, 'Giant', 61)`).run();
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (1)`).run();

const system = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`);
system.run(1, 'Home', 0, 0);
system.run(2, 'Ranked space', 1, 0);
system.run(3, 'Fought space', 1, 0);
system.run(4, 'Unseen space', 1, 0);
system.run(5, 'Giant space', 1, 0);
system.run(6, 'Empty space', 1, 0);

const planet = db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
planet.run(1, 1, 6, 1, 100, sqlTime(NOW));       // ours
planet.run(2, 2, 6, 2, 500, sqlTime(NOW));       // owner is in the rankings
planet.run(3, 3, 6, 3, 500, sqlTime(NOW));       // owner only ever seen in a battle
planet.run(4, 4, 6, 4, 500, sqlTime(NOW));       // owner never seen at all
planet.run(5, 5, 6, 5, 500, sqlTime(NOW));       // owner far stronger than us
planet.run(6, 6, 6, null, 0, sqlTime(NOW - 5 * HOUR));   // free, for a colony ship

// Two defender signals. 'Ranked' has both, and the rankings figure is the larger, so it
// must win and be named. 'OnlyFought' has just the battle figure.
db.prepare(`INSERT INTO strongest_fleet (player_id, rank, cv, updated_at) VALUES (2, 3, 40, ?)`).run(new Date(NOW - 2 * HOUR).toISOString());
db.prepare(`INSERT INTO strongest_fleet (player_id, rank, cv, updated_at) VALUES (5, 1, 9000, ?)`).run(new Date(NOW - 2 * HOUR).toISOString());
const report = db.prepare(`INSERT INTO battle_reports (id, started_at, att_player_id, att_combat_value, def_player_id, def_combat_value, att_has_won, att_pct_cv_lost, def_pct_cv_lost, att_lost_cv, def_lost_cv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
report.run(1, new Date(NOW - 50 * HOUR).toISOString(), 90, 25, 3, 30, 1, 40, 100, 10, 30);
// An archive with a "never lost from 1.6x" shape, so the route has a threshold to rank on.
// It is fought between two players who own nothing: using the target owners here would feed
// their own combat values back in as the "last seen fielding" estimate, which is how the
// first version of this fixture quietly made a 2.5x target look like an even fight.
db.prepare(`INSERT INTO players (id, name) VALUES (90, 'ArchiveAttacker')`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (91, 'ArchiveDefender')`).run();
let id = 100;
for (let i = 0; i < 20; i++) report.run(id++, new Date(NOW - 20 * HOUR).toISOString(), 90, 50, 91, 100, 0, 100, 20, 50, 20);
for (let i = 0; i < 12; i++) report.run(id++, new Date(NOW - 20 * HOUR).toISOString(), 90, 200, 91, 100, 1, 40, 100, 80, 100);

// Fourteen days of scans so the target owners have away profiles at all.
const sample = db.prepare(`INSERT INTO player_login_samples (player_id, total_logins, observed_at) VALUES (?, ?, ?)`);
let counter = 10;
for (let t = NOW - 14 * 24 * HOUR; t <= NOW; t += 20 * 60 * 1000) {
    counter += 1;
    for (const pid of [2, 3, 4, 5]) sample.run(pid, counter, sqlTime(t));
}

(async () => {
    clearSleepProfileCache();
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    // A fighting fleet, a colony-ship fleet, and one in a system nobody has indexed.
    const res = await getJson(server, '/hub-api/intel/fleet-dispatch?fleets=1:6:100:0,1:6:0:1,999:1:50:0&maxHours=48&limit=10');
    ok('responds 200', res.status === 200, res.status);
    const body = res.body;
    ok('reports success', body && body.success === true);
    ok('every fleet the page named comes back', body.fleets.length === 3, body.fleets.map(f => f.key));

    const fighter = body.fleets.find(f => f.cv === 100 && f.system_id === 1);
    const colonist = body.fleets.find(f => f.colonyShips === 1);
    const lost = body.fleets.find(f => f.system_id === 999);

    // --- The two defender signals -----------------------------------------
    const ranked = fighter.targets.find(t => t.player_name === 'Ranked');
    ok('a target whose owner is in the rankings uses that figure',
        ranked && ranked.defenderCv === 40 && ranked.defenderSource === 'rankings', ranked);
    const fought = fighter.targets.find(t => t.player_name === 'OnlyFought');
    ok('a target whose owner was only ever seen in a battle still gets an estimate',
        fought && fought.defenderCv === 30, fought);
    ok('and the panel is told that estimate came from a battle, not the rankings',
        fought && fought.defenderSource === 'battle', fought && fought.defenderSource);
    ok('the age of whichever observation was used is reported',
        fought && fought.defenderAgeHours > 40 && ranked.defenderAgeHours < 5,
        { fought: fought && fought.defenderAgeHours, ranked: ranked && ranked.defenderAgeHours });

    const unseen = fighter.targets.find(t => t.player_name === 'Unseen');
    ok('an owner nobody has ever seen is UNKNOWN, not undefended',
        unseen && unseen.verdict === 'unknown' && unseen.defenderCv === null, unseen);
    ok('a target we would lose to is left out of the suggestions',
        !fighter.targets.some(t => t.player_name === 'Giant'), fighter.targets.map(t => t.player_name));
    ok('but it is counted so the panel can say what is out there', fighter.riskyExcluded >= 1, fighter);

    ok('the beatable targets are marked clear',
        ranked.verdict === 'clear' && fought.verdict === 'clear', [ranked.verdict, fought.verdict]);
    ok('each carries the archive\'s own cost sentence, sample count included',
        /recorded battle/.test(ranked.cost || ''), ranked.cost);
    ok('the response says how big the archive behind those sentences is',
        body.archiveBattles >= 32 && body.alwaysWonFrom === 1.6, { battles: body.archiveBattles, from: body.alwaysWonFrom });

    // --- A fleet that cannot fight ----------------------------------------
    ok('a colony-ship fleet is offered no battles', colonist.targets.length === 0, colonist.targets);
    ok('and is told it cannot fight', colonist.canFight === false && colonist.canSettle === true, colonist);
    ok('it is offered a free planet instead',
        colonist.colonies.length === 1 && colonist.colonies[0].system_id === 6, colonist.colonies);
    ok('with the age of the observation that called it free',
        Math.abs(colonist.colonies[0].observedAgeHours - 5) < 0.2, colonist.colonies[0]);
    ok('a fighting fleet with no colony ship is offered no free planets',
        fighter.colonies.length === 0 && fighter.canSettle === false, fighter.colonies);

    // --- A fleet the hub cannot place -------------------------------------
    ok('a fleet in a system nobody has indexed is answered, not dropped', !!lost, body.fleets.map(f => f.key));
    ok('and is marked unplaceable rather than given suggestions from nowhere',
        lost.unplaceable === true && lost.targets.length === 0, lost);

    // --- The fleet list the page sends ------------------------------------
    const junk = await getJson(server, '/hub-api/intel/fleet-dispatch?fleets=1:6:100,notafleet,1:99:5:0,0:1:5:0,1:6:-3:0');
    ok('a three-part fleet still parses — the colony count is optional',
        junk.body.fleets.some(f => f.cv === 100), junk.body.fleets.map(f => f.key));
    ok('a malformed entry is dropped rather than guessed at', junk.body.fleets.length === 1, junk.body.fleets.map(f => f.key));
    const none = await getJson(server, '/hub-api/intel/fleet-dispatch');
    ok('no fleets at all is answered with a reason, not an error',
        none.status === 200 && none.body.fleets.length === 0 && !!none.body.reason, none.body);

    // --- The shared profile memo ------------------------------------------
    ok('the first call built the profiles', res.body.profilesCached === false, res.body.profilesCached);
    const again = await getJson(server, '/hub-api/intel/fleet-dispatch?fleets=1:6:100:0');
    ok('a second call reuses them', again.body.profilesCached === true, again.body.profilesCached);

    server.close();
    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
