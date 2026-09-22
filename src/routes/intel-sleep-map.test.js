// GET /hub-api/intel/sleep-map — the roster-wide activity profile (src/utils/sleep-map.js)
// served for every player the hub has scan samples for, with optional launch times for a
// given travel time.
//
// The logic itself is covered by src/utils/sleep-map.test.js. What is checked here is the
// part only the route can get wrong: the player grouping as samples stream past, the
// minSamples floor, the sort that decides what a member sees first, and that a travel time
// turns into launch times while its absence does not.
//
// Run with: node src/routes/intel-sleep-map.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-sleep-map-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-sleep-map.test.js');

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
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (90, 'Punks', 'PUNX')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, points) VALUES (1, 'Sleeper', 90, 500)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, points) VALUES (2, 'NightOwl', 90, 400)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, points) VALUES (3, 'BarelyScanned', 90, 300)`).run();

const insert = db.prepare(`INSERT INTO player_login_samples (player_id, total_logins, observed_at) VALUES (?, ?, ?)`);

// Ten days of scans every 15 minutes. Sleeper is away during UTC hours 0..5 and logs in
// the rest of the day; NightOwl is the exact opposite. BarelyScanned gets three samples,
// under the minSamples floor, and must not appear.
const NOW = Date.now();
const SCAN = 15 * 60 * 1000;
let counters = { 1: 100, 2: 200 };
for (let t = NOW - 10 * 24 * HOUR; t <= NOW; t += SCAN) {
    const hour = new Date(t).getUTCHours();
    const asleep = hour <= 5;
    if (!asleep) counters[1] += 1;
    if (asleep) counters[2] += 1;
    insert.run(1, counters[1], sqlTime(t));
    insert.run(2, counters[2], sqlTime(t));
}
for (let i = 0; i < 3; i++) insert.run(3, 10 + i, sqlTime(NOW - (3 - i) * HOUR));
// One sample is not an interval and can never be classified at all.
db.prepare(`INSERT INTO players (id, name, alliance_id, points) VALUES (4, 'SeenOnce', 90, 200)`).run();
insert.run(4, 7, sqlTime(NOW - HOUR));

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    const base = await getJson(server, '/hub-api/intel/sleep-map?days=10');
    ok('responds 200', base.status === 200, base.status);
    ok('reports success', base.body && base.body.success === true);

    const players = (base.body && base.body.players) || [];
    ok('both well-scanned players are profiled', players.length === 2, players.map(p => p.name));
    ok('a player under the minSamples floor is left out rather than guessed at',
        !players.some(p => p.name === 'BarelyScanned'), players.map(p => p.name));

    const sleeper = players.find(p => p.name === 'Sleeper');
    const owl = players.find(p => p.name === 'NightOwl');
    ok('samples are grouped to the right player — the two profiles are not the same',
        sleeper && owl && JSON.stringify(sleeper.scores) !== JSON.stringify(owl.scores));

    ok('Sleeper reads quiet across 00:00-04:00 UTC',
        sleeper && [0, 1, 2, 3, 4].every(h => sleeper.scores[h] > 0.8), sleeper && sleeper.scores);
    // 05:00 is NOT quiet, and that is the evidence rule doing its job: the scan at 05:45
    // and the one at 06:00 straddle the hour boundary, the counter moved between them, and
    // the login could have happened at 05:50. login-gaps.js refuses to call that hour quiet
    // and so does this. The first hour after a target wakes up is never proven quiet.
    ok('the hour a login lands in is active even when the login was near its edge',
        sleeper && sleeper.scores[5] < 0.2, sleeper && sleeper.scores[5]);
    ok('Sleeper reads active during the day',
        sleeper && [10, 14, 20].every(h => sleeper.scores[h] < 0.2), sleeper && sleeper.scores);
    ok('NightOwl is the mirror image', owl && owl.scores[3] < 0.2 && owl.scores[14] > 0.8, owl && owl.scores);

    ok('the trough names the quiet stretch', sleeper && sleeper.trough && sleeper.trough.hours >= 5, sleeper && sleeper.trough);
    ok('every hour of a ten-day window is observed on ten days', sleeper && sleeper.observed.every(o => o >= 9), sleeper && sleeper.observed);
    ok('the alliance tag rides along so the panel can filter by it', sleeper && sleeper.tag === 'PUNX', sleeper && sleeper.tag);
    ok('the roster carries no launch times when no travel time was given', sleeper && sleeper.launchWindows.length === 0);

    // The default sort is "who is quiet in the hour we are in right now" — that is the
    // question the panel opens on, and it must not be left to the client.
    const nowHour = new Date(base.body.generatedAt).getUTCHours();
    const quietNow = nowHour <= 5 ? 'Sleeper' : 'NightOwl';
    ok('the player quiet in the current hour sorts first', players[0].name === quietNow, { first: players[0].name, nowHour });
    ok('the response states the UTC hour it sorted on', base.body.nowHourUtc === nowHour, base.body.nowHourUtc);

    const withTravel = await getJson(server, '/hub-api/intel/sleep-map?days=10&travel=3.5');
    const travelSleeper = withTravel.body.players.find(p => p.name === 'Sleeper');
    ok('a travel time produces launch times', travelSleeper && travelSleeper.launchWindows.length === 3, travelSleeper && travelSleeper.launchWindows);
    ok('the launch times honour a fractional travel time',
        travelSleeper && travelSleeper.launchWindows.every(w => w.arriveAt - w.launchAt === 3.5 * HOUR),
        travelSleeper && travelSleeper.launchWindows);
    ok('every launch time is in the future',
        travelSleeper && travelSleeper.launchWindows.every(w => w.launchAt >= withTravel.body.generatedAt - 1000),
        travelSleeper && travelSleeper.launchWindows);
    ok('the arrivals land in the hours this target is away',
        travelSleeper && travelSleeper.launchWindows.every(w => w.arrivalHour <= 5),
        travelSleeper && travelSleeper.launchWindows);
    ok('the travel time is echoed back', withTravel.body.travelHours === 3.5, withTravel.body.travelHours);

    // Junk in the query string must not produce junk in the answer.
    const junk = await getJson(server, '/hub-api/intel/sleep-map?days=notanumber&travel=abc&minSamples=-5');
    ok('a nonsense days falls back to the default window', junk.status === 200 && junk.body.days === 14, junk.body && junk.body.days);
    ok('a nonsense travel time is treated as none given', junk.body && junk.body.travelHours === null, junk.body && junk.body.travelHours);
    // A caller may lower the floor — three samples is a caller's judgement call — but
    // never below two, because one sample is not an interval and classifies nothing.
    ok('a negative minSamples is clamped to two, not honoured',
        junk.body && junk.body.players.some(p => p.name === 'BarelyScanned'), junk.body && junk.body.players.map(p => p.name));
    ok('a player seen exactly once is never profiled',
        junk.body && !junk.body.players.some(p => p.name === 'SeenOnce'), junk.body && junk.body.players.map(p => p.name));

    const capped = await getJson(server, '/hub-api/intel/sleep-map?days=9999');
    ok('the window is capped at the 30 days of samples the hub keeps', capped.body && capped.body.days === 30, capped.body && capped.body.days);

    server.close();
    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
