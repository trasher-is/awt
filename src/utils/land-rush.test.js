// src/utils/land-rush.js — what is left of the free galaxy and how fast it is going.
//
// The assertions that matter are the ones about honesty rather than arithmetic: a stale
// observation must not be counted as current evidence, a rate must come from events rather
// than from differencing snapshots, and a galaxy nobody is colonising must produce no
// deadline instead of an infinite one.
//
// Run with: node src/utils/land-rush.test.js

const landRush = require('./land-rush');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('land-rush.test.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// --- Timestamps -------------------------------------------------------------
ok('a SQLite timestamp is read as UTC, not as local time',
    landRush.toMs('2026-09-22 12:00:00') === Date.UTC(2026, 8, 22, 12, 0, 0), landRush.toMs('2026-09-22 12:00:00'));
ok('an ISO timestamp with an offset keeps its offset',
    landRush.toMs('2026-09-22T14:00:00+02:00') === Date.UTC(2026, 8, 22, 12, 0, 0));
ok('an unparseable timestamp is null, not NaN masquerading as a time', landRush.toMs('not a date') === null);

// --- Freshness --------------------------------------------------------------
const free = [
    { system_id: 1, planet_index: 1, observed_at: sqlTime(NOW - 2 * HOUR) },
    { system_id: 1, planet_index: 2, observed_at: sqlTime(NOW - 30 * HOUR) },
    { system_id: 2, planet_index: 3, observed_at: sqlTime(NOW - 100 * HOUR) },
    { system_id: 2, planet_index: 4, observed_at: sqlTime(NOW - 40 * DAY) },
    { system_id: 3, planet_index: 1, observed_at: null },
];
const fresh = landRush.freshnessBuckets(free, { now: NOW });
ok('a planet seen two hours ago is in the 24-hour bucket', fresh.buckets[0].planets === 1, fresh.buckets);
ok('a planet seen 30 hours ago falls to the 72-hour bucket', fresh.buckets[1].planets === 1, fresh.buckets);
ok('a planet seen 100 hours ago falls to the week bucket', fresh.buckets[2].planets === 1, fresh.buckets);
ok('a planet seen 40 days ago is counted as older, not dropped', fresh.older.planets === 1, fresh.older);
ok('a planet with no observation time is counted as unknown', fresh.unknown === 1, fresh.unknown);
ok('every free planet is accounted for somewhere',
    fresh.buckets.reduce((n, b) => n + b.planets, 0) + fresh.older.planets + fresh.unknown === fresh.total, fresh);

ok('the projection horizon counts only what was seen inside it', landRush.freeWithin(free, 72, { now: NOW }) === 2,
    landRush.freeWithin(free, 72, { now: NOW }));
ok('a planet with no observation time never counts as recently seen', landRush.freeWithin(free, 100000, { now: NOW }) === 4);

// --- The claim rate ---------------------------------------------------------
// NOW is 12:00 UTC, so a nine-day window opens mid-way through 13 September and closes
// mid-way through the 22nd: those two calendar days are partial, the eight between them
// are whole. Ten claims on each whole day, three on each partial one. Averaging the
// partial days in would read as 8.6 a day when the observed rate is 10.
const events = [];
const claimsOn = (dayIso, count, hourFrom) => {
    for (let i = 0; i < count; i++) {
        events.push({
            system_id: 10 + (i % 3),
            timestamp: `${dayIso} ${String(hourFrom + i).padStart(2, '0')}:00:00`,
            alliance_tag: i % 2 ? 'ZOD' : 'HNU',
        });
    }
};
claimsOn('2026-09-13', 3, 13);                       // partial: window opens at 12:00
for (let day = 14; day <= 21; day++) claimsOn(`2026-09-${day}`, 10, 1);   // whole days
claimsOn('2026-09-22', 3, 8);                        // partial: window closes at 12:00

const rate = landRush.claimRate(events, { now: NOW, windowDays: 9 });
ok('the rate is computed from whole days only', Math.abs(rate.claimsPerDay - 10) < 1e-9, rate.claimsPerDay);
ok('the partial days are still reported, just not averaged in',
    rate.days.length === 10 && rate.ratedOnDays === 8, { days: rate.days.length, rated: rate.ratedOnDays });
ok('every claim inside the window is still counted', rate.claims === 86, rate.claims);
// Whole days are decided by the calendar, not by position in the list. "Drop the first and
// last entry" gets this wrong the moment the busiest day happens to be first, or the last
// day of the window has no events at all and so never appears in the list to be dropped.
const sparse = landRush.claimRate([
    { system_id: 1, timestamp: sqlTime(NOW - 3 * DAY) },
    { system_id: 1, timestamp: sqlTime(NOW - 3 * DAY + HOUR) },
], { now: NOW, windowDays: 5 });
ok('a day inside the window with no claims counts as a real zero',
    Math.abs(sparse.claimsPerDay - (2 / 4)) < 1e-9, sparse);
ok('the whole days the rate rests on are listed, so the average can be checked by hand',
    rate.ratedDays.length === rate.ratedOnDays && rate.partialDaysExcluded === true, rate.ratedDays);
ok('events outside the window are ignored',
    landRush.claimRate(events, { now: NOW, windowDays: 2 }).claims < events.length);
ok('a future-dated event cannot inflate the rate',
    landRush.claimRate([{ timestamp: sqlTime(NOW + DAY), system_id: 1 }], { now: NOW, windowDays: 7 }).claims === 0);
ok('no events at all is a rate of zero, not a division by zero',
    landRush.claimRate([], { now: NOW }).claimsPerDay === 0);

// --- The projection ---------------------------------------------------------
const projection = landRush.projectExhaustion(100, 10, { now: NOW });
ok('100 planets at 10 a day is ten days', Math.abs(projection.days - 10) < 1e-9, projection.days);
ok('the projection returns the instant, not just a count', projection.at === NOW + 10 * DAY);
ok('the projection admits to being linear', projection.linear === true);
ok('a galaxy nobody is colonising has no deadline', landRush.projectExhaustion(100, 0, { now: NOW }) === null);
ok('a galaxy with nothing left has no deadline either', landRush.projectExhaustion(0, 10, { now: NOW }) === null);

// --- The frontier -----------------------------------------------------------
const systems = [
    { id: 1, name: 'Home', x: 0, y: 0 },
    { id: 2, name: 'Far', x: 30, y: 40 },
    { id: 3, name: 'Unindexed-elsewhere', x: 3, y: 4 },
    { id: 10, name: 'Busy', x: 6, y: 8 },
];
const frontier = landRush.systemFrontier(free, events, systems, { now: NOW, windowDays: 9, origin: { x: 0, y: 0 } });
const bySystem = id => frontier.find(s => s.system_id === id);

ok('a system with two free planets reports two', bySystem(1).freePlanets === 2, bySystem(1));
ok('the system name comes along for the ride', bySystem(2).name === 'Far', bySystem(2));
ok('the oldest observation in a system is what the row is honest about',
    Math.round(bySystem(2).oldestObservationHours) === 40 * 24, bySystem(2).oldestObservationHours);
ok('the newest observation is reported too, so a mixed system is visible',
    Math.round(bySystem(2).newestObservationHours) === 100, bySystem(2).newestObservationHours);
ok('straight-line distance is measured from the origin given',
    Math.abs(bySystem(2).distance - 50) < 1e-9, bySystem(2).distance);
ok('a system with recent claims but no free planets still appears — it is where the land went',
    bySystem(10) && bySystem(10).freePlanets === 0 && bySystem(10).recentClaims > 0, bySystem(10));
ok('the alliances claiming there are named, most active first',
    bySystem(10).claimingTags.length === 2 && bySystem(10).claimingTags[0].claims >= bySystem(10).claimingTags[1].claims,
    bySystem(10).claimingTags);
ok('a system the hub has never indexed still lists its free planets, with a null name',
    landRush.systemFrontier([{ system_id: 99, planet_index: 1, observed_at: sqlTime(NOW) }], [], systems, { now: NOW })[0].name === null);
ok('no origin means no distances rather than distances from (0,0)',
    landRush.systemFrontier(free, [], systems, { now: NOW }).every(s => s.distance === null));
ok('the most free planets sort first', frontier[0].freePlanets >= frontier[frontier.length - 1].freePlanets, frontier.map(s => s.freePlanets));

// --- Contested systems ------------------------------------------------------
const contested = landRush.contestedSystems(frontier);
ok('a system two alliances are both settling is contested', contested.length === 3, contested.map(s => s.system_id));
ok('a system only one alliance is settling is not',
    landRush.contestedSystems(landRush.systemFrontier([], [
        { system_id: 5, timestamp: sqlTime(NOW - HOUR), alliance_tag: 'HNU' },
        { system_id: 5, timestamp: sqlTime(NOW - 2 * HOUR), alliance_tag: 'HNU' },
    ], systems, { now: NOW })).length === 0);
ok('claims by an unallied player are counted, just not as an alliance',
    landRush.systemFrontier([], [
        { system_id: 5, timestamp: sqlTime(NOW - HOUR), alliance_tag: 'HNU' },
        { system_id: 5, timestamp: sqlTime(NOW - 2 * HOUR), alliance_tag: null },
    ], systems, { now: NOW })[0].unalliedClaims === 1);
ok('claims by an unallied player do not invent a second alliance',
    landRush.contestedSystems(landRush.systemFrontier([], [
        { system_id: 5, timestamp: sqlTime(NOW - HOUR), alliance_tag: 'HNU' },
        { system_id: 5, timestamp: sqlTime(NOW - 2 * HOUR), alliance_tag: null },
    ], systems, { now: NOW })).length === 0);

// --- Expansion drift --------------------------------------------------------
// Early claims at (0,0), later ones at (30,40): a front that moved 50 units.
const drifting = [
    { system_id: 1, timestamp: sqlTime(NOW - 12 * DAY), alliance_tag: 'ZOD' },
    { system_id: 1, timestamp: sqlTime(NOW - 10 * DAY), alliance_tag: 'ZOD' },
    { system_id: 2, timestamp: sqlTime(NOW - 2 * DAY), alliance_tag: 'ZOD' },
    { system_id: 2, timestamp: sqlTime(NOW - 1 * DAY), alliance_tag: 'ZOD' },
];
const drift = landRush.expansionDrift(drifting, systems, { now: NOW, windowDays: 14 });
ok('a front that moved is measured', Math.abs(drift.moved - 50) < 1e-9, drift);
ok('both halves report how many claims they rest on', drift.early.claims === 2 && drift.late.claims === 2, drift);
ok('one half empty means no drift rather than a line through one point',
    landRush.expansionDrift(drifting.slice(0, 2), systems, { now: NOW, windowDays: 14 }) === null);
ok('claims in systems with no coordinates cannot move a front',
    landRush.expansionDrift([{ system_id: 404, timestamp: sqlTime(NOW - DAY) }], systems, { now: NOW }) === null);

// --- Nothing at all ---------------------------------------------------------
ok('an empty galaxy produces empty answers, not exceptions',
    landRush.systemFrontier([], [], [], { now: NOW }).length === 0
    && landRush.freshnessBuckets([], { now: NOW }).total === 0);

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
