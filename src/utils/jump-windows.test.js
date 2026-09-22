// src/utils/jump-windows.js — choosing the launch planet so the fleet lands in the dark.
//
// The assertion this file exists for is the fourth one: with the launch time fixed at now,
// the best jump point is NOT always the nearest, and a module that quietly returned the
// nearest would look right in every other test here.
//
// Run with: node src/utils/jump-windows.test.js

const jump = require('./jump-windows');
const travelModel = require('../../public/js/utils/travel-model.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('jump-windows.test.js');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 22, 22, 0, 0);   // 22:00 UTC

// A target who is away 02:00-06:00 UTC and at the keyboard the rest of the day.
const asleepEarly = Array.from({ length: 24 }, (_, hour) => {
    const away = hour >= 2 && hour <= 5;
    return {
        hour, observedDays: 14,
        quietDays: away ? 13 : 1, activeDays: away ? 1 : 13,
        sleepScore: away ? 0.875 : 0.125,
    };
});

// Origins are placed so their flight times to the target are known and different. The
// travel formula is not re-implemented here — the distances are chosen, then the flight
// times are read back out of the model itself, which is the only copy of the rule.
const target = { player_id: 7, system_id: 500, planet_index: 6, x: 0, y: 0 };
const near = { system_id: 1, planet_index: 6, x: 1, y: 0 };
const mid = { system_id: 2, planet_index: 6, x: 2, y: 0 };
const far = { system_id: 3, planet_index: 6, x: 3, y: 0 };
const origins = [near, mid, far];

const flight = o => jump.travelHours(o, target, { energy: 0, raceSpeed: 0 });
console.log(`  (flight times: near ${flight(near).toFixed(2)}h, mid ${flight(mid).toFixed(2)}h, far ${flight(far).toFixed(2)}h)`);

// --- 1. The travel rule is the shared one, not a copy ------------------------
ok('travel time comes from the one travel model',
    Math.abs(jump.travelHours(near, target, { energy: 3, raceSpeed: 2 })
        - travelModel.calcTravelSeconds(1, 0, 6, 0, 0, 6, 3, 2, false) / 3600) < 1e-12);
ok('a higher energy level shortens the flight', flight(near) > jump.travelHours(near, target, { energy: 5 }));
// The halving is for moves to your own or an allied planet. Applying it to an attack would
// land the fleet hours early, in daylight, with the launch time still reading "correct".
ok('the alliance halving is never applied to a strike',
    Math.abs(jump.travelHours(near, target, {}) - travelModel.calcTravelSeconds(1, 0, 6, 0, 0, 6, 0, 0, false) / 3600) < 1e-12
    && jump.travelHours(near, target, {}) > travelModel.calcTravelSeconds(1, 0, 6, 0, 0, 6, 0, 0, true) / 3600);

// --- 2. Reading the arrival hour off the profile -----------------------------
ok('an arrival at 03:00 UTC is scored against the 03:00 bucket',
    jump.scoreAtArrival(asleepEarly, Date.UTC(2026, 8, 23, 3, 30, 0)).hour === 3);
ok('an arrival in the quiet hours scores high',
    jump.scoreAtArrival(asleepEarly, Date.UTC(2026, 8, 23, 4, 0, 0)).sleepScore === 0.875);
ok('an arrival at midday scores low',
    jump.scoreAtArrival(asleepEarly, Date.UTC(2026, 8, 23, 12, 0, 0)).sleepScore === 0.125);

// --- 3. Launch-now picks the jump point by ARRIVAL, not by distance ----------
const now = jump.bestOriginNow(origins, target, asleepEarly, { now: NOW });
ok('launching now returns a jump point', !!now, now);
ok('the chosen arrival lands in the target\'s quiet hours',
    now.arrivalHour >= 2 && now.arrivalHour <= 5, { hour: now.arrivalHour, from: now.origin.system_id });
ok('the chosen jump point is NOT the nearest one — distance is the arrival hour',
    now.origin.system_id !== near.system_id,
    { chosen: now.origin.system_id, nearest: near.system_id, chosenHours: now.travelHours, nearestHours: flight(near) });
ok('the nearest jump point would have landed the fleet awake',
    jump.scoreAtArrival(asleepEarly, NOW + flight(near) * HOUR).sleepScore < 0.5,
    { arrivesAt: new Date(NOW + flight(near) * HOUR).toISOString() });
ok('the launch time really is now', now.launchAt === NOW);
ok('the arrival respects the flight time of the origin it chose',
    Math.abs(now.arriveAt - (NOW + now.travelHours * HOUR)) < 1e-6);

// Two origins that both land in the quiet window: the shorter flight wins, because a fleet
// in space is a fleet that is visible and cannot be recalled.
const twins = [
    { system_id: 10, planet_index: 6, x: 2, y: 0 },
    { system_id: 11, planet_index: 6, x: -2, y: 0 },   // mirrored: identical distance
];
const tie = jump.bestOriginNow(twins, target, asleepEarly, { now: NOW });
ok('a tie on away-score is broken by the shorter flight',
    Math.abs(tie.travelHours - flight(mid)) < 1e-9, tie.travelHours);

// --- 4. The scheduled answer uses the nearest origin and names the launch time
const plan = jump.planStrike(origins, target, asleepEarly, { now: NOW, horizonHours: 48 });
ok('the scheduled plan exists', !!plan.scheduled, plan.scheduled);
ok('the scheduled plan flies from the NEAREST jump point',
    plan.scheduled.origin.system_id === near.system_id, plan.scheduled.origin);
ok('the scheduled plan lands in the quiet hours too',
    plan.scheduled.arrivalHour >= 2 && plan.scheduled.arrivalHour <= 5, plan.scheduled);
ok('the scheduled plan says how long to wait before launching',
    plan.scheduled.waitHours >= 0 && Math.abs(plan.scheduled.launchAt - (NOW + plan.scheduled.waitHours * HOUR)) < 1e-6,
    plan.scheduled);
ok('the scheduled launch is never in the past', plan.scheduled.launchAt >= NOW);
ok('launch-now and scheduled are kept apart rather than merged into one answer',
    plan.launchNow.origin.system_id !== plan.scheduled.origin.system_id, plan);

// --- 5. A target nobody sleeps through -------------------------------------
const alwaysOn = Array.from({ length: 24 }, (_, hour) => ({ hour, observedDays: 14, quietDays: 0, activeDays: 14, sleepScore: 0.067 }));
const hopeless = jump.bestOriginNow(origins, target, alwaysOn, { now: NOW });
ok('a target who is never away still returns a plan, at their real low score',
    hopeless.awayScore === 0.067, hopeless);
ok('for a target with no quiet hour the nearest jump point wins on the tiebreak',
    hopeless.origin.system_id === near.system_id, hopeless.origin);

// --- 6. Ranking ------------------------------------------------------------
const targets = [
    { player_id: 7, system_id: 500, planet_index: 6, x: 0, y: 0 },
    { player_id: 8, system_id: 501, planet_index: 6, x: 0, y: 1 },
    { player_id: 9, system_id: 502, planet_index: 6, x: 0, y: 2 },   // never sampled
    { player_id: 10, system_id: 503, planet_index: 6, x: null, y: null }, // no coordinates
];
const profiles = new Map([
    [7, { hours: asleepEarly, trough: { startHour: 2, endHour: 6, hours: 4, meanScore: 0.875 } }],
    [8, { hours: alwaysOn, trough: null }],
]);
const ranked = jump.rankTargets(origins, targets, profiles, { now: NOW });
ok('a target with no coordinates is skipped rather than drawn at the origin',
    !ranked.some(t => t.system_id === 503), ranked.map(t => t.system_id));
ok('an unsampled target is kept, not dropped', ranked.some(t => t.system_id === 502), ranked.map(t => t.system_id));
ok('an unsampled target is marked as unsampled', ranked.find(t => t.system_id === 502).sampled === false);
ok('an unsampled target sits at the 0.5 prior, never above a measured sleeper',
    ranked.find(t => t.system_id === 502).launchNow.awayScore === 0.5);
ok('the measured sleeper outranks both', ranked[0].system_id === 500, ranked.map(t => [t.system_id, t.launchNow.awayScore]));
ok('the always-awake target ranks last', ranked[ranked.length - 1].system_id === 501, ranked.map(t => t.system_id));
ok('the trough rides along for the tooltip', ranked[0].trough && ranked[0].trough.hours === 4, ranked[0].trough);

const filtered = jump.rankTargets(origins, targets, profiles, { now: NOW, minScore: 0.8 });
ok('a minimum score drops everything below it', filtered.length === 1 && filtered[0].system_id === 500,
    filtered.map(t => [t.system_id, t.launchNow.awayScore]));

// --- 7. Nothing to launch from ---------------------------------------------
ok('no jump points at all yields no plan rather than a crash',
    jump.bestOriginNow([], target, asleepEarly, { now: NOW }) === null);
ok('an origin with no coordinates cannot be launched from',
    jump.bestOriginNow([{ system_id: 99, planet_index: 1, x: null, y: null }], target, asleepEarly, { now: NOW }) === null);
ok('a target list with no origins ranks nothing', jump.rankTargets([], targets, profiles, { now: NOW }).length === 0);

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
