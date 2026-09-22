// src/utils/fleet-dispatch.js — what to send the fleet you are looking at against.
//
// The assertions that matter most are the ones about what the hub does NOT know. "Their
// strongest fleet was 200 CV yesterday" and "we have never seen a fleet of theirs" are
// completely different facts, and a shortlist that presented the second as an open door
// would get a fleet killed. So: unknown is its own verdict, it never ranks above a target
// we can actually beat, and a target we would lose to is left out of the list but counted.
//
// Run with: node src/utils/fleet-dispatch.test.js

const dispatchUtil = require('./fleet-dispatch');
const battleLedger = require('./battle-ledger');
const travelModel = require('../../public/js/utils/travel-model.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('fleet-dispatch.test.js');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

// A hand-built archive with the shape the real one has: certain above 1.6x, hopeless below
// parity. No captured report is copied into this repository.
const battle = (att, def, won, attPct) => ({
    att_combat_value: att, def_combat_value: def, att_has_won: won ? 1 : 0,
    att_pct_cv_lost: attPct, def_pct_cv_lost: won ? 100 : 20,
    att_lost_cv: Math.round(att * attPct / 100), def_lost_cv: won ? def : Math.round(def * 0.2),
});
const rows = [];
for (let i = 0; i < 20; i++) rows.push(battle(50, 100, false, 100));    // 0.5x
for (let i = 0; i < 12; i++) rows.push(battle(200, 100, true, 40));     // 2.0x
for (let i = 0; i < 12; i++) rows.push(battle(500, 100, true, 20));     // 5.0x
const curve = battleLedger.costCurve(rows);
ok('the fixture archive has a "never lost from" threshold to rank against',
    battleLedger.thresholds(curve).alwaysWonFrom === 1.6, battleLedger.thresholds(curve));

// The hour the fleet below actually lands in, taken from the travel model rather than
// assumed. Writing "away 00:00-11:59" and hoping the arrival falls inside it makes the
// test depend on what time NOW happens to be — the same mistake that made the jump-window
// route test pass all afternoon and fail at 18:00 UTC.
const ONE_HOP_HOURS = travelModel.calcTravelSeconds(0, 0, 6, 1, 0, 6, 0, 0, false) / 3600;
const LANDS_AT_HOUR = new Date(NOW + ONE_HOP_HOURS * HOUR).getUTCHours();

// One owner who is away exactly when the fleet would arrive, and one who never is.
const profileFor = (awayWhen) => ({
    hours: Array.from({ length: 24 }, (_, hour) => {
        const away = awayWhen(hour);
        return { hour, observedDays: 14, quietDays: away ? 13 : 1, activeDays: away ? 1 : 13, sleepScore: away ? 0.875 : 0.125 };
    }),
    trough: { startHour: LANDS_AT_HOUR, endHour: (LANDS_AT_HOUR + 1) % 24, hours: 1, meanScore: 0.875 },
});
const profiles = new Map([
    [1, profileFor(h => h === LANDS_AT_HOUR)],
    [2, profileFor(() => false)],
]);

const fleet = { key: 'f1', cv: 300, system_id: 10, planet_index: 6, x: 0, y: 0 };
const at = (x, y, extra) => ({ x, y, planet_index: 6, population: 1000, ...extra });

// --- One fleet against one target -------------------------------------------
{
    const seen = dispatchUtil.assess(fleet, at(1, 0, { player_id: 1, defender_cv: 100, defender_seen_at: new Date(NOW - 3 * HOUR).toISOString() }),
        profiles.get(1).hours, curve, { now: NOW });
    ok('the flight time is the shared travel model, not a copy',
        Math.abs(seen.travelHours - travelModel.calcTravelSeconds(0, 0, 6, 1, 0, 6, 0, 0, false) / 3600) < 1e-12, seen.travelHours);
    ok('the arrival is the flight time from now', Math.abs(seen.arriveAt - (NOW + seen.travelHours * HOUR)) < 1e-6);
    ok('the away score is read at the hour the fleet lands',
        seen.arrivalHour === new Date(seen.arriveAt).getUTCHours(), seen);
    ok('and it is the quiet hour this owner was built around, whatever time the suite runs',
        seen.arrivalHour === LANDS_AT_HOUR && seen.awayScore === 0.875, { hour: seen.arrivalHour, score: seen.awayScore });
    ok('300 against 100 is a 3x ratio', Math.abs(seen.ratio - 3) < 1e-9, seen.ratio);
    ok('and the archive calls that clear', seen.verdict === dispatchUtil.CLEAR, seen.verdict);
    ok('the cost sentence comes from the ledger, with its sample count',
        /recorded battle/.test(seen.cost), seen.cost);
    ok('the age of the defender observation is reported, not just the number',
        Math.abs(seen.defenderAgeHours - 3) < 0.01, seen.defenderAgeHours);
}

// --- What the hub does not know ---------------------------------------------
{
    const unknown = dispatchUtil.assess(fleet, at(1, 0, { player_id: 1 }), profiles.get(1).hours, curve, { now: NOW });
    ok('an owner who has never appeared in the rankings is UNKNOWN, not undefended',
        unknown.verdict === dispatchUtil.UNKNOWN, unknown.verdict);
    ok('and carries no ratio to be misread as one', unknown.ratio === null, unknown.ratio);
    ok('and no cost sentence either', unknown.cost === null, unknown.cost);

    const zero = dispatchUtil.assess(fleet, at(1, 0, { player_id: 1, defender_cv: 0 }), profiles.get(1).hours, curve, { now: NOW });
    ok('a recorded strongest fleet of zero is still UNKNOWN, not a free planet', zero.verdict === dispatchUtil.UNKNOWN, zero.verdict);

    const never = dispatchUtil.assess(fleet, at(1, 0, { player_id: 99, defender_cv: 100 }), null, curve, { now: NOW });
    ok('a target nobody has sampled reports no away score rather than a confident one',
        never.awayScore === null && never.sampled === false, never);
}

// --- A fight we would lose ---------------------------------------------------
{
    const losing = dispatchUtil.assess({ ...fleet, cv: 50 }, at(1, 0, { player_id: 1, defender_cv: 100 }), profiles.get(1).hours, curve, { now: NOW });
    ok('half their strength is risky, not clear', losing.verdict === dispatchUtil.RISKY, losing.verdict);
    ok('and the archive says so in words', /1\.8%|attacker won/.test(losing.cost || ''), losing.cost);
}

// --- Ranking one fleet's shortlist ------------------------------------------
{
    const targets = [
        at(1, 0, { player_id: 1, system_id: 1, defender_cv: 100, population: 500 }),    // beatable, sleeper
        at(1, 0, { player_id: 2, system_id: 2, defender_cv: 100, population: 900 }),    // beatable, always awake
        at(1, 0, { player_id: 1, system_id: 3 }),                                       // unknown defender
        at(1, 0, { player_id: 1, system_id: 4, defender_cv: 5000 }),                    // would lose
        at(40, 0, { player_id: 1, system_id: 5, defender_cv: 100 }),                    // far away
        { player_id: 1, system_id: 6, planet_index: 6, x: null, y: null, defender_cv: 100 }, // no coordinates
    ];
    const ranked = dispatchUtil.rankForFleet(fleet, targets, profiles, curve, { now: NOW, maxHours: 24, limit: 6 });

    ok('a fight we would lose is not offered as a suggestion',
        !ranked.targets.some(t => t.system_id === 4), ranked.targets.map(t => t.system_id));
    ok('but it is counted, so the panel can say what is out there', ranked.riskyExcluded === 1, ranked);
    ok('a target beyond the range limit is left out and counted separately',
        !ranked.targets.some(t => t.system_id === 5) && ranked.outOfRange === 1, ranked);
    ok('a target with no coordinates is skipped entirely, not counted as considered',
        ranked.considered === 5, ranked.considered);

    ok('a target we can beat outranks one we know nothing about',
        ranked.targets.findIndex(t => t.verdict === dispatchUtil.CLEAR) < ranked.targets.findIndex(t => t.verdict === dispatchUtil.UNKNOWN),
        ranked.targets.map(t => [t.system_id, t.verdict]));

    const clear = ranked.targets.filter(t => t.verdict === dispatchUtil.CLEAR);
    ok('among targets we can beat, the one likely to be unattended comes first',
        clear[0].system_id === 1 && clear[0].awayScore > clear[1].awayScore,
        clear.map(t => [t.system_id, t.awayScore]));

    ok('every suggestion carries what it is based on: flight, arrival, away, defender, cost',
        ranked.targets.every(t => Number.isFinite(t.travelHours) && Number.isFinite(t.arriveAt)
            && 'awayScore' in t && 'defenderCv' in t && 'cost' in t), Object.keys(ranked.targets[0]));
}

// --- Several fleets at once --------------------------------------------------
{
    const targets = [at(1, 0, { player_id: 1, system_id: 1, defender_cv: 100 })];
    const fleets = [
        { key: 'a', cv: 300, system_id: 10, planet_index: 6, x: 0, y: 0 },
        { key: 'b', cv: 10, system_id: 11, planet_index: 6, x: 0, y: 0 },   // too weak for the same target
    ];
    const all = dispatchUtil.dispatch(fleets, targets, profiles, curve, { now: NOW, maxHours: 24, limit: 6 });
    ok('every fleet gets its own answer', all.length === 2 && all[0].key === 'a' && all[1].key === 'b', all.map(f => f.key));
    ok('the strong fleet is offered the target', all[0].targets.length === 1, all[0]);
    ok('the weak fleet is offered nothing, and told why', all[1].targets.length === 0 && all[1].riskyExcluded === 1, all[1]);
    ok('each answer repeats the fleet it belongs to', all[0].cv === 300 && all[1].cv === 10);
}

// --- Empty inputs ------------------------------------------------------------
ok('no targets at all is an empty shortlist, not a crash',
    dispatchUtil.rankForFleet(fleet, [], profiles, curve, { now: NOW }).targets.length === 0);
ok('no fleets at all is an empty answer', dispatchUtil.dispatch([], [], profiles, curve, { now: NOW }).length === 0);
ok('an empty archive cannot call anything clear',
    dispatchUtil.assess(fleet, at(1, 0, { player_id: 1, defender_cv: 1 }), null, battleLedger.costCurve([]), { now: NOW }).verdict
    === dispatchUtil.RISKY);

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
