// src/utils/sleep-map.js — the roster-wide activity profile behind the Sleep Map panel.
//
// The load-bearing assertion in here is the first one: sleep-map.js reclassifies the same
// scan intervals login-gaps.js does, by a different (linear) route, and the two must agree
// cell for cell. If they ever stop agreeing, the panel is quietly telling the alliance
// something the profile card contradicts, and the profile card is the one with the
// published rule.
//
// Run with: node src/utils/sleep-map.test.js

const sleepMap = require('./sleep-map');
const gaps = require('../../public/js/utils/login-gaps.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sleep-map.test.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// A scan every 12 minutes for 6 days. The player logs in during UTC hours 8..22 and never
// between 02:00 and 06:00 — except once, on the third day at 03:00, which is exactly the
// single stray login that makes login-gaps.js drop 03:00 as a proven window and that this
// module is built to keep as "quiet 5 days out of 6".
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const SCAN_MS = 12 * 60 * 1000;

function buildSamples({ strayLogin = true } = {}) {
    const out = [];
    let counter = 1000;
    for (let t = NOW - 6 * DAY; t <= NOW; t += SCAN_MS) {
        const hour = new Date(t).getUTCHours();
        const dayIndex = Math.floor((t - (NOW - 6 * DAY)) / DAY);
        const awake = hour >= 8 && hour <= 22;
        const stray = strayLogin && dayIndex === 2 && hour === 3;
        if (awake || stray) counter += 1;
        out.push({ t: new Date(t).toISOString(), n: counter });
    }
    return out;
}

const samples = buildSamples();

// --- 1. Same classification as login-gaps.js, cell for cell -------------------
// gaps.analyze()'s grid is anchored on calendar days and this module's on the rolling
// window, so the comparison runs over the cells the grid actually produced, skipping the
// partial cell at each end where the two windows start and stop at different instants.
const reference = gaps.analyze(samples, { now: NOW, tzOffsetMin: 0, days: 6 });
const mine = sleepMap.classifyHourCells(samples, { now: NOW, days: 6 });

let compared = 0, disagreed = [];
for (const row of reference.rows) {
    for (let hour = 0; hour < 24; hour++) {
        const cellStart = row.dayStartUtc + hour * HOUR;
        if (cellStart <= NOW - 6 * DAY + HOUR) continue;  // partial oldest cell
        if (cellStart + HOUR > NOW) continue;             // the hour in progress / the future
        const theirs = row.cells[hour];
        if (theirs === 'future') continue;
        const ours = mine.cells.get(Math.floor(cellStart / HOUR)) || 'unknown';
        compared++;
        if (theirs !== ours) disagreed.push({ cellStart: new Date(cellStart).toISOString(), theirs, ours });
    }
}
ok('compared a meaningful number of hour cells against login-gaps.grid()', compared > 100, { compared });
ok('every hour cell is classified exactly as login-gaps.js classifies it', disagreed.length === 0, disagreed.slice(0, 5));

// --- 2. The counting rule keeps what the proof rule discards ------------------
const profile = sleepMap.hourProfile(samples, { now: NOW, days: 6 });
const h3 = profile.hours[3];
ok('03:00 was observed on every day of the window', h3.observedDays === 6, h3);
ok('03:00 counted the one stray login as active', h3.activeDays === 1, h3);
ok('03:00 counted the other five days as quiet', h3.quietDays === 5, h3);
ok('login-gaps.js drops 03:00 entirely — one login disqualifies a proven window',
    !gaps.analyze(samples, { now: NOW, tzOffsetMin: 0, days: 6 }).windows.some(w => w.startHour <= 3 && 3 < w.startHour + w.hours),
    reference.windows);

const noStray = sleepMap.hourProfile(buildSamples({ strayLogin: false }), { now: NOW, days: 6 });
ok('without the stray login 03:00 is quiet on every observed day', noStray.hours[3].activeDays === 0, noStray.hours[3]);

// --- 3. The Laplace prior ----------------------------------------------------
ok('an hour quiet on 5 of 6 days scores (5+1)/(6+2)', Math.abs(h3.sleepScore - 6 / 8) < 1e-9, h3.sleepScore);
ok('an hour active every day scores below a half', profile.hours[12].sleepScore < 0.5, profile.hours[12]);
const unobserved = sleepMap.hourProfile([], { now: NOW, days: 6 });
ok('an hour nobody observed sits at the prior, not at certainty', unobserved.hours[4].sleepScore === 0.5, unobserved.hours[4]);
ok('a single quiet observation scores 0.67, not 1.0 — it cannot outrank a well-observed hour',
    Math.abs(sleepMap.hourProfile([
        { t: NOW - 3 * HOUR, n: 5 }, { t: NOW - 2 * HOUR, n: 5 },
    ], { now: NOW, days: 6 }).hours[new Date(NOW - 3 * HOUR).getUTCHours()].sleepScore - 2 / 3) < 1e-9);

// --- 4. The trough window ----------------------------------------------------
const trough = sleepMap.troughWindow(profile.hours, { threshold: 0.7, minObserved: 3 });
ok('the trough is found inside the quiet stretch', !!trough && (trough.startHour >= 23 || trough.startHour <= 3), trough);
ok('the trough covers the hours nobody logs in', trough && trough.hours >= 4, trough);

// A profile whose quiet run crosses midnight must come back as ONE window, not two.
const wrapped = Array.from({ length: 24 }, (_, hour) => ({
    hour, observedDays: 10,
    quietDays: (hour >= 22 || hour <= 4) ? 10 : 0,
    activeDays: (hour >= 22 || hour <= 4) ? 0 : 10,
    sleepScore: (hour >= 22 || hour <= 4) ? 0.92 : 0.08,
}));
const wrappedTrough = sleepMap.troughWindow(wrapped, { threshold: 0.8, minObserved: 3 });
ok('a quiet run across midnight is one window, not two', wrappedTrough && wrappedTrough.hours === 7, wrappedTrough);
ok('the window across midnight starts at 22:00', wrappedTrough && wrappedTrough.startHour === 22, wrappedTrough);
ok('the window across midnight ends at 05:00', wrappedTrough && wrappedTrough.endHour === 5, wrappedTrough);

const alwaysOn = Array.from({ length: 24 }, (_, hour) => ({ hour, observedDays: 10, quietDays: 0, activeDays: 10, sleepScore: 0.08 }));
ok('a player who is never away has no trough at all', sleepMap.troughWindow(alwaysOn) === null);

const neverSeen = Array.from({ length: 24 }, (_, hour) => ({ hour, observedDays: 1, quietDays: 1, activeDays: 0, sleepScore: 0.67 }));
ok('one lucky observation per hour is not a trough — minObserved gates it',
    sleepMap.troughWindow(neverSeen, { threshold: 0.6, minObserved: 3 }) === null);

// --- 5. Launch windows -------------------------------------------------------
// The join the hub could not make before: arrival, not departure, is what has to land in
// the quiet hours.
const launches = sleepMap.bestLaunchWindows(wrapped, { now: NOW, travelHours: 5, horizonHours: 24, top: 3 });
ok('launch windows are returned', launches.length === 3, launches.length);
ok('every proposed launch is in the future', launches.every(l => l.launchAt >= NOW), launches);
ok('every proposed arrival respects the travel time', launches.every(l => l.arriveAt - l.launchAt === 5 * HOUR), launches);
ok('every proposed arrival lands in the quiet run', launches.every(l => l.arrivalHour >= 22 || l.arrivalHour <= 4), launches);
ok('the best launch is the quietest, ties broken by the sooner launch',
    launches[0].sleepScore >= launches[1].sleepScore && launches[0].launchAt <= launches[launches.length - 1].launchAt, launches);

const immediate = sleepMap.bestLaunchWindows(wrapped, { now: NOW, travelHours: 0, horizonHours: 6, top: 10 });
ok('a zero travel time still only proposes launches from now on', immediate.every(l => l.launchAt >= NOW), immediate[0]);

// A fleet so slow that the whole horizon is one arrival hour still gets an answer.
const slow = sleepMap.bestLaunchWindows(wrapped, { now: NOW, travelHours: 100, horizonHours: 1, top: 5 });
ok('a very slow fleet still gets arrival candidates', slow.length >= 1, slow.length);
ok('a very slow fleet launches immediately or later, never in the past', slow.every(l => l.launchAt >= NOW), slow);

// --- 6. The whole-player analysis --------------------------------------------
const analysis = sleepMap.analysePlayer(samples, { now: NOW, days: 6, travelHours: 2 });
ok('analysePlayer reports the hour we are in right now', analysis.currentHour.hour === new Date(NOW).getUTCHours(), analysis.currentHour);
ok('analysePlayer carries the quiet-since fact from login-gaps.js', analysis.quietSince && analysis.quietSince.confirmedQuietMs >= 0, analysis.quietSince);
ok('analysePlayer proposes launches when a travel time is given', analysis.launchWindows.length > 0);
ok('analysePlayer proposes none when the travel time is unknown',
    sleepMap.analysePlayer(samples, { now: NOW, days: 6 }).launchWindows.length === 0);
ok('coverage reflects how much of the window scans actually classified', analysis.coverage > 0.9, analysis.coverage);

// A player with no samples at all must not crash the roster query.
const empty = sleepMap.analysePlayer([], { now: NOW, days: 6, travelHours: 3 });
ok('a player with no samples yields a flat prior and no trough', empty.trough === null && empty.coverage === 0, empty.coverage);
ok('a player with no samples still yields launch windows, all at the prior',
    empty.launchWindows.every(l => l.sleepScore === 0.5), empty.launchWindows[0]);

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
