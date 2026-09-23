// GET /hub-api/intel/galaxy-stats — the galaxy dashboard (src/utils/galaxy-stats.js).
//
// Synthetic galaxy only. What is pinned here is the attribution that is easy to get subtly
// wrong: which ownership changes count as a gain or a loss for whom, which window a battle
// falls in, that only the winning attacker is credited with a conquest, and that the
// strongest-fleet board ignores rows left over from older snapshots.
//
// Run with: node src/routes/intel-galaxy-stats.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-galaxy-stats-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');
const { computeGalaxyStats } = require('../utils/galaxy-stats');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-galaxy-stats.test.js');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
// The game writes battle times with a +02:00 offset; store them that way.
const gameTime = ms => new Date(ms + 2 * HOUR).toISOString().slice(0, 19) + '+02:00';

db.prepare(`INSERT INTO alliances (id, name, tag, ranking, points_current) VALUES (1, 'Alpha', 'ALP', 1, 9)`).run();
db.prepare(`INSERT INTO alliances (id, name, tag, ranking, points_current) VALUES (2, 'Bravo', 'BRV', 2, 4)`).run();

const addPlayer = db.prepare(`INSERT INTO players (id, name, alliance_id, level, total_xp, last_activity_at, resigned_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
addPlayer.run(1, 'Ace', 1, 6, 900, new Date(NOW - 10 * 60 * 1000).toISOString(), null);   // active 10 min ago
addPlayer.run(2, 'Axe', 1, 4, 500, new Date(NOW - 5 * HOUR).toISOString(), null);         // active today
addPlayer.run(3, 'Bee', 2, 6, 950, new Date(NOW - 3 * 24 * HOUR).toISOString(), null);    // quiet for days
addPlayer.run(4, 'Lone', null, 1, 10, null, null);
addPlayer.run(5, 'Gone', 2, 9, 9999, new Date(NOW).toISOString(), '2026-09-20 00:00:00');   // resigned

const addSystem = db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`);
addSystem.run(10, 'Sol', 0, 0);
addSystem.run(11, 'Vega', 5, 5);
addSystem.run(12, 'Void', 9, 9);

const addPlanet = db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, is_sieged) VALUES (?, ?, ?, ?, ?, ?)`);
addPlanet.run(101, 10, 1, 1, 20, 0);
addPlanet.run(102, 10, 2, 1, 10, 1);
addPlanet.run(103, 10, 3, 2, 5, 0);
addPlanet.run(104, 11, 1, 3, 30, 0);
addPlanet.run(105, 11, 2, null, 0, 0);
addPlanet.run(106, 12, 1, null, 0, 0);

const ownerChangeType = db.prepare(`SELECT id FROM event_types WHERE name = 'OWNER_CHANGE'`).get().id;
const addEvent = db.prepare(`INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp) VALUES (10, 1, ?, ?, ?, ?)`);
addEvent.run(ownerChangeType, null, 1, sqlTime(NOW - 2 * HOUR));        // Alpha colonises (24h)
addEvent.run(ownerChangeType, 3, 2, sqlTime(NOW - 3 * HOUR));           // Alpha takes from Bravo (24h)
addEvent.run(ownerChangeType, 1, 2, sqlTime(NOW - 4 * HOUR));           // Alpha -> Alpha: not a change
addEvent.run(ownerChangeType, 1, 3, sqlTime(NOW - 3 * 24 * HOUR));      // Bravo takes from Alpha (7d only)
addEvent.run(ownerChangeType, 3, null, sqlTime(NOW - 2 * 24 * HOUR));   // Bravo planet dies (7d only)
addEvent.run(ownerChangeType, null, 3, sqlTime(NOW - 9 * 24 * HOUR));   // outside 7d
addEvent.run(ownerChangeType, 2, null, sqlTime(NOW - 30 * HOUR));       // lost, but outside 24h

const addBattle = db.prepare(`INSERT INTO battle_reports (id, started_at, conquered_planet, att_alliance_tag, att_has_won, def_alliance_tag, def_has_won) VALUES (?, ?, ?, ?, ?, ?, ?)`);
addBattle.run(1, gameTime(NOW - 1 * HOUR), 1, 'ALP', 1, 'BRV', 0);           // Alpha conquers (24h)
addBattle.run(2, gameTime(NOW - 30 * HOUR), 1, 'brv', 0, 'ALP', 1);          // failed attack; lower-case tag
addBattle.run(3, gameTime(NOW - 3 * 24 * HOUR), 0, 'BRV', 1, 'ALP', 0);      // Bravo wins, no conquest
addBattle.run(4, gameTime(NOW - 10 * 24 * HOUR), 1, 'ALP', 1, 'BRV', 0);     // chart only, not the 7d table
addBattle.run(5, gameTime(NOW - 20 * 24 * HOUR), 1, 'ALP', 1, 'BRV', 0);     // outside the chart

const addFleet = db.prepare(`INSERT INTO strongest_fleet (player_id, rank, destroyers, cruisers, battleships, cv, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)`);
addFleet.run(1, 1, 100, 300, '2026-09-23T05:00:00.000Z');
addFleet.run(3, 2, 50, 150, '2026-09-23T05:00:00.000Z');
addFleet.run(2, 1, 900, 2700, '2026-09-21T05:00:00.000Z'); // stale: shot down since, not on today's board

const s = computeGalaxyStats(db, { now: NOW });
const h = s.headline;
const alpha = s.alliances.find(a => a.tag === 'ALP');
const bravo = s.alliances.find(a => a.tag === 'BRV');
const none = s.alliances.find(a => a.id === null);

ok('planet totals: 6 planets, 4 owned, 2 free, 1 sieged', h.planets === 6 && h.ownedPlanets === 4 && h.freePlanets === 2 && h.siegedPlanets === 1, h);
ok('2 of 3 systems occupied', h.systems === 3 && h.occupiedSystems === 2, h);
ok('resigned players are not counted', h.players === 4, h.players);
ok('activity: 1 in the last hour, 2 in the last day', h.active1h === 1 && h.active24h === 2, h);
ok('alliance holdings come from the planets table', alpha.planets === 3 && alpha.population === 35 && bravo.planets === 1, [alpha, bravo]);
ok('share is of owned planets', alpha.share === 75 && bravo.share === 25, [alpha.share, bravo.share]);
ok('members exclude the resigned', alpha.members === 2 && bravo.members === 1, [alpha.members, bravo.members]);
ok('unaligned players get their own row', none && none.members === 1, none);

ok('24h: Alpha gained 2 (colonise + take), intra-alliance move ignored', alpha.gained24h === 2 && alpha.lost24h === 0, alpha);
ok('24h: Bravo lost the planet Alpha took', bravo.gained24h === 0 && bravo.lost24h === 1, bravo);
ok('7d: includes older changes, excludes the 9-day-old one', alpha.gained7d === 2 && alpha.lost7d === 2 && bravo.gained7d === 1 && bravo.lost7d === 2, [alpha, bravo]);
ok('owner changes in 24h counts every event, including internal moves', h.ownerChanges24h === 3, h.ownerChanges24h);
ok('24h breakdown: settled free planet is colonised, player-to-player is taken', h.changes24h.colonised === 1 && h.changes24h.taken === 2 && h.changes24h.lost === 0, h.changes24h);

ok('battles in 24h: 1, with 1 conquest', h.battles24h === 1 && h.conquests24h === 1, h);
ok('7d battle record per alliance, tag match is case-insensitive', alpha.battles7d === 3 && alpha.won7d === 2 && alpha.lostBattles7d === 1 && bravo.battles7d === 3 && bravo.won7d === 1, [alpha, bravo]);
ok('only a winning attacker is credited with a conquest', alpha.conquests7d === 1 && bravo.conquests7d === 0, [alpha.conquests7d, bravo.conquests7d]);
ok('chart covers 14 days: 4 battles bucketed hourly', s.battlesHourly.reduce((n, b) => n + b.battles, 0) === 4, s.battlesHourly);
ok('chart buckets are whole UTC hours', s.battlesHourly.every(b => b.t % HOUR === 0), s.battlesHourly);
ok('latest battle is reported as an instant', h.latestBattleAt === NOW - HOUR, h.latestBattleAt);

ok('fleet board uses only the latest snapshot', s.top.fleet.length === 2 && s.top.fleet[0].name === 'Ace' && !s.top.fleet.some(f => f.id === 2), s.top.fleet);
ok('level board skips the resigned and breaks ties on xp', s.top.level[0].name === 'Bee' && s.top.level[1].name === 'Ace' && !s.top.level.some(p => p.name === 'Gone'), s.top.level);
ok('population board sums planets per owner; a tie goes to more planets', s.top.population[0].name === 'Ace' && s.top.population[0].planets === 2 && s.top.population[0].population === 30 && s.top.population[1].name === 'Bee', s.top.population);

// --- the route ---
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Caveman' }; next(); });
app.use('/hub-api', intelRouter);

const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    http.get({ hostname: '127.0.0.1', port, path: '/hub-api/intel/galaxy-stats' }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
            let body = null;
            try { body = JSON.parse(raw); } catch (_) { /* leave null */ }
            ok('route answers 200 with success', res.statusCode === 200 && body && body.success, raw.slice(0, 200));
            ok('route carries headline, alliances, chart and boards', body && body.headline && Array.isArray(body.alliances) && Array.isArray(body.battlesHourly) && body.top && Array.isArray(body.top.fleet), body && Object.keys(body));
            ok('route carries the own/friendly tag lists for highlighting', body && Array.isArray(body.ownTags) && Array.isArray(body.friendlyTags), body && [body.ownTags, body.friendlyTags]);
            server.close();
            if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
            console.log('\nall passed');
        });
    }).on('error', err => { console.error(err); process.exit(1); });
});
