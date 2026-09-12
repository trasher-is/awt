// All observations here are invented. No captured player data or fixture edits.
const { inferBattleRace, VERSION, MODEL_NOT_BEFORE } = require('./battle-race-inference');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const ALL_PICKS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SHIPS = ['destroyers', 'cruisers', 'battleships'];
const CV = [3, 24, 60];

function report(overrides = {}) {
    const row = {
        id: 101, started_at: '2026-09-01T12:00:00Z', is_public: 1,
        att_player_id: 11, def_player_id: 22, winner: 'Attacker',
        att_has_won: 1, def_has_won: 0,
        att_destroyers: 1000, att_destroyers_lost: 769,
        att_cruisers: 0, att_cruisers_lost: 0,
        att_battleships: 0, att_battleships_lost: 0,
        def_destroyers: 400, def_destroyers_lost: 400,
        def_cruisers: 0, def_cruisers_lost: 0,
        def_battleships: 0, def_battleships_lost: 0,
    };
    for (const side of ['att', 'def']) {
        for (const type of ['transports', 'colony_ships', 'starbases']) {
            row[`${side}_${type}`] = row[`${side}_${type}_lost`] = 0;
        }
    }
    Object.assign(row, overrides);
    for (const side of ['att', 'def']) {
        row[`${side}_combat_value`] = SHIPS.reduce((sum, type, i) => sum + row[`${side}_${type}`] * CV[i], 0);
        row[`${side}_lost_cv`] = SHIPS.reduce((sum, type, i) => sum + row[`${side}_${type}_lost`] * CV[i], 0);
        row[`${side}_survived_cv`] = row[`${side}_combat_value`] - row[`${side}_lost_cv`];
    }
    return row;
}
const infer = (rows, options) => inferBattleRace(11, rows, options);
function skipped(name, row, reason, options) {
    const result = infer([row], options);
    ok(name, result.skipped[reason] === 1 && result.eligible_report_count === 0
        && equal(result.defense.candidates, ALL_PICKS), result);
}

console.log('── Conservative battle race compatibility ──');
const malus = infer([report()]);
ok('a high-loss winning observation can constrain DEF to -4 under the model',
    malus.status === 'compatible' && equal(malus.defense.candidates, [-4])
    && malus.eligible_report_count === 1 && equal(malus.used_report_ids, [101]), malus);
ok('ATK remains unknown even when DEF has one compatible pick',
    malus.attack.status === 'insufficient' && equal(malus.attack.candidates, ALL_PICKS));
ok('percent ranges describe race bonuses, not confidence probabilities',
    equal(malus.attack.bonus_percent_range, { min: -32, max: 32 })
    && equal(malus.defense.bonus_percent_range, { min: -48, max: -48 }));
ok('the result declares conditional compatibility and supported race range',
    malus.version === VERSION && malus.assumptions.some(text => /not a probability/.test(text))
    && malus.assumptions.some(text => /supported -4 to \+4/.test(text)));

const interval = infer([report({ att_destroyers_lost: 600 })]);
ok('losses can leave multiple compatible picks without ranking them',
    equal(interval.defense.candidates, [-4, -3]) && !('probability' in interval.defense)
    && equal(interval.defense.bonus_percent_range, { min: -48, max: -36 }), interval);
const weak = infer([report({ att_destroyers_lost: 200 })]);
ok('good survival cannot prove a positive race bonus with unknown historical Mathematics',
    weak.status === 'insufficient' && weak.eligible_report_count === 1
    && equal(weak.defense.candidates, ALL_PICKS)
    && equal(weak.defense.bonus_percent_range, { min: -48, max: 48 }), weak);

const conflict = infer([report({ att_destroyers_lost: 950 })]);
ok('a model contradiction is reported without selecting a closest race',
    conflict.status === 'conflicting' && conflict.defense.status === 'conflicting'
    && conflict.defense.candidates.length === 0 && conflict.defense.bonus_percent_range === null, conflict);

const frozen = report({ physics: 999, mathematics: 0, level: 999, race_defense: 4, has_intel: 1 });
const before = JSON.stringify(frozen);
Object.freeze(frozen);
ok('current science, level and intel-shaped extra fields do not change inference',
    equal(infer([frozen]), malus));
ok('input report objects and bio-shaped fields are never mutated', JSON.stringify(frozen) === before);
ok('all results are JSON-safe', equal(JSON.parse(JSON.stringify(malus)), malus));

const reverse = report({
    att_player_id: 22, def_player_id: 11, winner: 'Defender', att_has_won: 0, def_has_won: 1,
    att_destroyers: 400, att_destroyers_lost: 400, def_destroyers: 1000, def_destroyers_lost: 769,
});
ok('the defender uses its own losses and the attacker CV', equal(infer([reverse]).defense.candidates, [-4]));

console.log('\n── Eligibility and data-integrity gates ──');
skipped('unpublished observations cannot be used as finalized losses', report({ is_public: 0 }), 'unpublished_report');
skipped('a losing player does not inherit survivor-model bounds', report({
    winner: 'Defender', att_has_won: 0, def_has_won: 1,
}), 'not_confirmed_winner');
skipped('contradictory winner flags are rejected', report({ def_has_won: 1 }), 'not_confirmed_winner');
ok('free-text winner names are not mistaken for missing winner evidence',
    equal(infer([report({ winner: 'Synthetic Winner' })]).defense, malus.defense));
ok('a missing free-text winner label does not override the per-side API flags',
    equal(infer([report({ winner: null })]).defense, malus.defense));
skipped('unknown winner flags are not treated as false', report({ def_has_won: null }), 'not_confirmed_winner');
skipped('missing zero counts stay unknown', report({ att_cruisers: null }), 'missing_ship_counts');
skipped('unknown auxiliary counts stay unknown', report({ def_starbases: null }), 'missing_ship_counts');
skipped('negative initial counts are rejected', report({ def_cruisers: -1 }), 'missing_ship_counts');
skipped('numeric strings are not coerced into evidence', report({ att_destroyers: '1000' }), 'missing_ship_counts');
skipped('a starbase count is never guessed to be a level', report({ def_starbases: 1 }), 'unsupported_ship_composition');
skipped('civilian-fleet mechanics are excluded', report({ att_transports: 1 }), 'unsupported_ship_composition');
skipped('invalid report IDs cannot become stored evidence', report({ id: null }), 'invalid_report_id');
skipped('the same player on both sides is ambiguous', report({ def_player_id: 11 }), 'ambiguous_player_side');
skipped('a fleet with fewer than four ships is excluded', report({ att_destroyers: 3, att_destroyers_lost: 2 }), 'too_small_or_unopposed');
skipped('unopposed flights contain no battle evidence', report({ def_destroyers: 0, def_destroyers_lost: 0 }), 'too_small_or_unopposed');
skipped('losses greater than initial ships are rejected', report({ att_destroyers_lost: 1001 }), 'invalid_ship_losses');
skipped('missing loss counts stay unknown', report({ att_destroyers_lost: null }), 'invalid_ship_losses');
skipped('annihilated winners do not establish a race malus', report({ att_destroyers_lost: 1000 }), 'annihilated_fleet');
skipped('zero losses are below rounding resolution', report({ att_destroyers_lost: 0 }), 'losses_below_rounding_resolution');
skipped('one ship lost does not support a precise multiplier', report({ att_destroyers_lost: 1 }), 'losses_below_rounding_resolution');
skipped('CV mismatches catch incomplete or shifted ship tables', { ...report(), def_combat_value: 1300 }, 'inconsistent_combat_value');
skipped('loss totals must agree with individual ship types', { ...report(), att_lost_cv: 123 }, 'inconsistent_loss_totals');
skipped('survivor totals must agree with individual ship types', { ...report(), att_survived_cv: null }, 'inconsistent_loss_totals');
skipped('incompatible per-type loss fractions cannot constrain a race', report({
    att_cruisers: 100, att_cruisers_lost: 10,
}), 'inconsistent_loss_fractions');

console.log('\n── Version, identity and stable aggregation ──');
skipped('pre-v6 battles use different defence multipliers', report({ started_at: '2026-08-27T23:59:59Z' }), 'unsupported_rules_date');
skipped('the unknown patch deployment time excludes the whole patch day', report({ started_at: '2026-08-28T23:59:59Z' }), 'unsupported_rules_date');
ok('the first unambiguous v6 UTC day is supported', infer([report({ started_at: MODEL_NOT_BEFORE })]).eligible_report_count === 1);
skipped('invalid battle dates never default to a current timestamp', report({ started_at: 'yesterday' }), 'invalid_battle_date');
skipped('a missing battle timestamp is rejected', report({ started_at: null }), 'invalid_battle_date');
skipped('impossible calendar dates do not silently roll into the next month', report({ started_at: '2026-09-31T12:00:00Z' }), 'invalid_battle_date');
skipped('24-hour timestamps do not silently roll into the next day', report({ started_at: '2026-09-01T24:00:00Z' }), 'invalid_battle_date');
skipped('offset-less ISO input is not interpreted in local time', report({ started_at: '2026-09-01T12:00:00' }), 'invalid_battle_date');
skipped('reports before the current identity cutoff cannot infer a former race', report(), 'before_current_player', { notBefore: '2026-09-02T00:00:00Z' });
skipped('an invalid identity cutoff blocks inference', report(), 'invalid_player_cutoff', { notBefore: 'unknown' });
skipped('RedZone combat artefacts do not silently use standard rules', report(), 'unsupported_ruleset', { universe: 'redzone' });
ok('SQLite timestamps and explicit offsets identify the same encounter',
    equal(infer([report({ started_at: '2026-09-01 12:00:00' })]),
        infer([report({ started_at: '2026-09-01T14:00:00+02:00' })])));
const reports = [report({ id: 103, att_destroyers_lost: 600 }), report({ id: 102 })];
ok('evidence order does not change the assessment', equal(infer(reports), infer([...reports].reverse())));
const refined = infer(reports);
ok('additional informative battles can narrow a percentage interval',
    refined.defense.bonus_percent_range.max < interval.defense.bonus_percent_range.max);
ok('uninformative additional battles never force a narrower interval',
    equal(infer([...reports, report({ id: 104, att_destroyers_lost: 200 })]).defense.bonus_percent_range,
        refined.defense.bonus_percent_range));
const duplicate = infer([report(), report()]);
ok('duplicate rows do not inflate evidence counts', duplicate.eligible_report_count === 1
    && duplicate.skipped.duplicate_report === 1 && equal(duplicate.used_report_ids, [101]));
const unrelated = infer([report({ att_player_id: 99, def_player_id: 88 })]);
ok('player names and unrelated rows never substitute for player identity', unrelated.report_count === 0
    && unrelated.eligible_report_count === 0 && unrelated.status === 'insufficient');
ok('an empty history remains insufficient', infer([]).status === 'insufficient');

// A generated sweep checks the crucial containment property, not a fitted expected
// candidate list: every synthetic race must survive the unknown-stat outer bound.
// The samples explicitly go beyond the calculator UI's 100-level science ceiling and
// include all-three-types player-level boosts plus both possible random roundings.
console.log('\n── Unknown historical stats cannot eliminate the true synthetic pick ──');
let cases = 0;
let counterexample = null;
for (const race of ALL_PICKS) {
    for (const math of [0, 3, 6, 50, 100, 200, 1000]) {
        for (const enemyMath of [0, 6, 1000]) {
            for (const mixed of [false, true]) {
                for (const levelGain of [0, 20, 2000]) {
                    for (const rounding of [Math.floor, Math.ceil]) {
                        const fleet = mixed ? [1000, 100, 100] : [1000, 0, 0];
                        const toughness = fleet[0] * 4 + fleet[1] * 40 + fleet[2] * 84;
                        const bracket = math - enemyMath >= 6 ? 1.25 : math - enemyMath <= -6 ? 0.75 : 1;
                        const multiplier = (1 + 0.0015 * math) * bracket * (1 + 0.12 * race)
                            * (mixed ? 1 + 0.01 * levelGain : 1);
                        const fraction = Math.min(1, 1200 / toughness) / multiplier;
                        const values = {};
                        fleet.forEach((number, i) => {
                            values[`att_${SHIPS[i]}`] = number;
                            const remaining = number ? rounding(Math.max(1, number * (1 - fraction))) : 0;
                            values[`att_${SHIPS[i]}_lost`] = number - remaining;
                        });
                        const result = infer([report(values)]);
                        cases++;
                        if (!result.defense.candidates.includes(race) && !counterexample) {
                            counterexample = { race, math, enemyMath, mixed, levelGain, values, result };
                        }
                    }
                }
            }
        }
    }
}
ok(`all ${cases} synthetic combinations preserve their true race pick`, counterexample === null, counterexample);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
