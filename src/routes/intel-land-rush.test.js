// GET /hub-api/intel/land-rush — free planets left, the rate they are going at, and where.
//
// src/utils/land-rush.test.js covers the analysis. This covers what only the route can get
// wrong: counting a conquest as a colonisation (which would inflate the rate at which free
// land disappears), reading the event type by a hardcoded id, and measuring "near us" from
// the wrong place.
//
// Run with: node src/routes/intel-land-rush.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-land-rush-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const landRushRouter = require('./landRush');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-land-rush.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Caveman' }; next(); });
app.use('/hub-api', landRushRouter);

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
const DAY = 24 * HOUR;
const NOW = Date.now();
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const ownerChange = db.prepare(`SELECT id FROM event_types WHERE name = 'OWNER_CHANGE'`).get().id;
const popDrop = db.prepare(`SELECT id FROM event_types WHERE name = 'POP_DROP'`).get().id;

db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (70, 'Renegade Raiders', 'RAID')`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (71, 'Zodiac', 'ZOD')`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (72, 'Punks', 'PUNX')`).run();

db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (1, 'Caveman', 70)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (2, 'Zodder', 71)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (3, 'Punker', 72)`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (4, 'Loner')`).run();

// ownAllianceTags() derives "our" alliance from the members carried in alliance_member_stats.
db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (1)`).run();

// Home at (0,0), the frontier at (30,40) — 50 units away by the travel model's own measure.
const system = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`);
system.run(1, 'Home', 0, 0);
system.run(2, 'Frontier', 30, 40);
system.run(3, 'Contested', 3, 4);

const planet = db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, updated_at, population_observed_at)
    VALUES (?, ?, ?, ?, ?, ?)
`);
// Ours, so the origin has somewhere to be measured from.
planet.run(100, 1, 1, 1, sqlTime(NOW), null);
// Free and recently confirmed.
planet.run(101, 2, 1, null, sqlTime(NOW - 2 * HOUR), sqlTime(NOW - 2 * HOUR));
planet.run(102, 2, 2, null, sqlTime(NOW - 5 * HOUR), null);
// Free, but last looked at nine days ago — the observation the projection must not lean on.
planet.run(103, 3, 1, null, sqlTime(NOW - 9 * DAY), null);

const event = db.prepare(`
    INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
`);
// Ten colonisations a day for three whole days, alternating between two alliances.
for (let day = 1; day <= 3; day++) {
    for (let i = 0; i < 10; i++) {
        event.run(3, i + 1, ownerChange, null, i % 2 ? 2 : 3, sqlTime(NOW - day * DAY + i * 20 * 60 * 1000));
    }
}
// A conquest on the same day: a planet changing hands does NOT consume free land.
event.run(2, 5, ownerChange, 3, 2, sqlTime(NOW - 2 * DAY));
// A colonisation by a player in no alliance.
event.run(3, 11, ownerChange, '', 4, sqlTime(NOW - 2 * DAY));
// A population drop, which is not an owner change at all.
event.run(2, 1, popDrop, 500, 100, sqlTime(NOW - 2 * DAY));

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    const res = await getJson(server, '/hub-api/intel/land-rush?days=4&freshHours=72');
    ok('responds 200', res.status === 200, res.status);
    const body = res.body;
    ok('reports success', body && body.success === true);

    ok('every planet recorded free is counted', body.free.total === 3, body.free);
    ok('only the recently confirmed ones count toward the horizon', body.free.withinHorizon === 2, body.free);
    ok('the nine-day-old observation is reported as older, not silently dropped',
        body.free.older === 1, body.free);

    // The rate is the assertion this whole route exists to get right. Its arithmetic is
    // pinned in land-rush.test.js, where `now` can be injected; what is checked here is
    // which ROWS reach it, since that is the route's job and the expensive mistake.
    ok('a conquest is not counted as a claim on free land',
        body.rate.claims === 31, { claims: body.rate.claims, note: '30 colonisations + 1 unallied, conquest excluded' });
    ok('a population drop is not counted as an owner change at all',
        !body.rate.days.some(d => d.claims > 11), body.rate.days);
    ok('the rate is positive and rests on whole days', body.rate.claimsPerDay > 0 && body.rate.ratedOnDays >= 1, body.rate);

    ok('two projections are returned, not one',
        body.projection.onEverythingKnownFree && body.projection.onRecentlyConfirmed, body.projection);
    const perDay = body.rate.claimsPerDay;
    ok('the optimistic projection uses everything believed free',
        Math.abs(body.projection.onEverythingKnownFree.days - 3 / perDay) < 1e-6, body.projection.onEverythingKnownFree);
    ok('the honest projection uses only what was recently confirmed',
        Math.abs(body.projection.onRecentlyConfirmed.days - 2 / perDay) < 1e-6, body.projection.onRecentlyConfirmed);
    ok('the honest projection is the shorter of the two — staleness only ever flatters',
        body.projection.onRecentlyConfirmed.days < body.projection.onEverythingKnownFree.days, body.projection);
    ok('the projection states that it is a straight line', body.projection.onEverythingKnownFree.linear === true);

    const frontier = body.frontier;
    const bySystem = id => frontier.find(s => s.system_id === id);
    ok('the frontier lists the systems with free planets', bySystem(2).freePlanets === 2, bySystem(2));
    ok('distance is measured from where our own planets are',
        bySystem(2) && Math.abs(bySystem(2).distance - 50) < 1e-6, { distance: bySystem(2).distance, origin: body.origin });
    ok('the origin says what it was derived from', body.origin && body.origin.tags.includes('RAID') && body.origin.planets === 1, body.origin);
    ok('the system being settled names the alliances doing it',
        bySystem(3).claimingTags.map(t => t.tag).sort().join(',') === 'PUNX,ZOD', bySystem(3).claimingTags);
    ok('an unallied settler is counted apart rather than as an alliance',
        bySystem(3).unalliedClaims === 1, bySystem(3));
    ok('a system two alliances are settling is reported as contested',
        body.contested.some(s => s.system_id === 3), body.contested);

    ok('per-alliance expansion drift is returned', Array.isArray(body.drift), body.drift);
    ok('the conquest matrix is separate from the colonisation rate',
        body.conquests.some(c => c.from_tag === 'PUNX' && c.to_tag === 'ZOD' && c.planets === 1), body.conquests);

    // Junk in the query string must not produce junk in the answer.
    const junk = await getJson(server, '/hub-api/intel/land-rush?days=abc&freshHours=-4&limit=0');
    ok('a nonsense window falls back to the default', junk.body.windowDays === 7, junk.body.windowDays);
    ok('a negative freshness horizon is ignored rather than clamped to one hour',
        junk.body.freshHours === 72, junk.body.freshHours);
    ok('a zero limit still returns at least one row rather than an empty panel',
        junk.body.frontier.length >= 1, junk.body.frontier.length);

    server.close();
    console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
    process.exit(failed === 0 ? 0 : 1);
})();
