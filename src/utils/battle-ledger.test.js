// src/utils/battle-ledger.js — what recorded battles say an attack cost.
//
// Every fixture here is hand-built, per AGENTS.md: no captured report is copied into the
// repository. The shapes are chosen to pin the behaviours that matter — a thin band must
// not become advice, a skipped row must be counted rather than vanish, and the
// win_chance check must call a calibrated column calibrated and an uninformative one
// uninformative, so it cannot only ever say "bad".
//
// Run with: node src/utils/battle-ledger.test.js

const ledger = require('./battle-ledger');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('battle-ledger.test.js');

// One battle at a chosen ratio, with a chosen outcome and cost.
function battle(att, def, won, attPct, defPct, extra = {}) {
    return {
        att_combat_value: att, def_combat_value: def,
        att_has_won: won ? 1 : 0,
        att_pct_cv_lost: attPct, def_pct_cv_lost: defPct,
        att_lost_cv: Math.round(att * attPct / 100), def_lost_cv: Math.round(def * defPct / 100),
        ...extra,
    };
}

// A synthetic archive with the shape the real one has: hopeless below parity, certain and
// progressively cheaper above it.
const rows = [];
for (let i = 0; i < 20; i++) rows.push(battle(50, 100, false, 100, 20));      // 0.5x
for (let i = 0; i < 10; i++) rows.push(battle(105, 100, i < 8, 70, 95));      // 1.05x
for (let i = 0; i < 12; i++) rows.push(battle(200, 100, true, 40, 100));      // 2.0x
for (let i = 0; i < 12; i++) rows.push(battle(400, 100, true, 25, 100));      // 4.0x
for (let i = 0; i < 12; i++) rows.push(battle(2000, 100, true, 3, 100));      // 20x
rows.push(battle(130, 100, true, 60, 100));                                   // 1.3x, alone
rows.push({ att_combat_value: null, def_combat_value: 100, att_has_won: 1 }); // unplaceable
rows.push({ att_combat_value: 100, def_combat_value: 0, att_has_won: 1 });    // unplaceable

const curve = ledger.costCurve(rows);

// --- Placing battles on the ratio axis ---------------------------------------
ok('every placeable battle is counted exactly once', curve.battles === 67, { battles: curve.battles });
ok('rows without both combat values are counted as skipped, not dropped silently', curve.skipped === 2, curve.skipped);
ok('a zero defender CV is skipped rather than dividing by zero', Number.isFinite(curve.battles));

const band = name => curve.bands.find(b => b.label === name);
ok('0.5x lands in the "under 0.9x" band', band('under 0.9x').battles === 20, band('under 0.9x'));
ok('1.05x lands in the 0.9-1.2x band', band('0.9-1.2x').battles === 10, band('0.9-1.2x'));
ok('2.0x lands in the 1.6-2.5x band', band('1.6-2.5x').battles === 12, band('1.6-2.5x'));
ok('20x lands in the open-ended top band', band('10x+').battles === 12, band('10x+'));
ok('a band edge belongs to the band above it', ledger.costCurve([battle(90, 100, false, 100, 10)]).bands.find(b => b.label === '0.9-1.2x').battles === 1);

// --- The numbers ------------------------------------------------------------
ok('the win rate is observed, not modelled', Math.abs(band('0.9-1.2x').winRate - 0.8) < 1e-9, band('0.9-1.2x').winRate);
ok('the attacker cost is the mean of what was recorded', Math.abs(band('1.6-2.5x').attackerLossPct - 40) < 1e-9);
ok('the median cost is reported next to the mean', band('1.6-2.5x').attackerLossPctMedian === 40);
ok('the exchange is CV destroyed per CV lost, weighted by size',
    Math.abs(band('1.6-2.5x').exchange - (100 / 80)) < 1e-6, band('1.6-2.5x').exchange);

// --- A thin band must not become advice -------------------------------------
ok('a band with one battle is marked thin', band('1.2-1.6x').thin === true, band('1.2-1.6x'));
ok('a band with twelve battles is not thin', band('1.6-2.5x').thin === false);
const thinAnswer = ledger.lookup(curve, 130, 100);
ok('a lookup into a thin band refuses to quote a cost', !thinAnswer.confident, thinAnswer);
ok('a lookup into a thin band says why', /anecdote/.test(thinAnswer.verdict), thinAnswer.verdict);

const solidAnswer = ledger.lookup(curve, 400, 100);
ok('a lookup into a well-populated band answers', solidAnswer.confident === true, solidAnswer);
ok('the answer quotes the ratio it used', /4\.00x/.test(solidAnswer.verdict), solidAnswer.verdict);
ok('the answer quotes the sample count, not just the number', /12 recorded battles/.test(solidAnswer.verdict), solidAnswer.verdict);
ok('the answer quotes the price of winning', /lose about 25%/.test(solidAnswer.verdict), solidAnswer.verdict);

ok('a nonsense combat value is refused rather than answered',
    ledger.lookup(curve, 0, 100).band === null && /positive/.test(ledger.lookup(curve, 0, 100).verdict));
ok('a ratio no battle has ever been fought at says exactly that',
    /cannot answer/.test(ledger.lookup(ledger.costCurve([battle(200, 100, true, 40, 100)]), 50, 100).verdict));

// --- Thresholds and the cheapest certain band -------------------------------
const t = ledger.thresholds(curve);
ok('the archive names the ratio from which the attacker has never lost', t.alwaysWonFrom === 1.6, t);
ok('a thin band cannot set the "never lost" threshold', t.alwaysWonFrom !== 1.2, t);
ok('the favourable threshold is where wins first pass half', t.favourableFrom === 0.9, t);

const cheapest = ledger.cheapestCertainBand(curve);
ok('the cheapest certain band is the one that keeps the most fleet', cheapest && cheapest.label === '10x+', cheapest);
ok('a curve with no certain band returns none',
    ledger.cheapestCertainBand(ledger.costCurve([battle(50, 100, false, 100, 20), battle(60, 100, false, 100, 20),
        battle(55, 100, false, 100, 20), battle(52, 100, false, 100, 20), battle(58, 100, false, 100, 20)])) === null);

// --- The win_chance column ---------------------------------------------------
// A column that really is a calibrated probability must pass, or the check is just a
// machine for producing bad news.
const calibrated = [];
for (let i = 0; i < 100; i++) {
    const p = (i % 10) * 10 + 5;                    // 5,15,...,95
    const won = (i % 10) >= 5 ? 1 : 0;              // wins exactly where p > 50
    calibrated.push({ ...battle(100, 100, !!won, 50, 50), win_chance: p, random_number: 50 });
}
const goodCheck = ledger.storedWinChanceCheck(calibrated);
ok('a genuinely informative column is reported as behaving like a probability',
    goodCheck.behavesLikeAProbability === true, goodCheck);
ok('the check reports how many battles it scored', goodCheck.battles === 100, goodCheck.battles);

// A column that is really a dice roll: uncorrelated with the outcome, equal to
// random_number. This is the shape the live column has.
const dice = [];
for (let i = 0; i < 100; i++) {
    const roll = (i * 37) % 100;
    dice.push({ ...battle(100, 100, i % 2 === 0, 50, 50), win_chance: roll, random_number: roll });
}
const diceCheck = ledger.storedWinChanceCheck(dice);
ok('a dice roll is reported as NOT behaving like a probability', diceCheck.behavesLikeAProbability === false, diceCheck);
ok('its Brier score is worse than guessing the base rate', diceCheck.brier > diceCheck.baseRateBrier, diceCheck);
ok('the check notices the column matching random_number exactly', diceCheck.diceMatchRate === 1, diceCheck.diceMatchRate);
ok('the mean distance to random_number is reported', diceCheck.diceMeanAbsDiff === 0, diceCheck.diceMeanAbsDiff);

const emptyCheck = ledger.storedWinChanceCheck([]);
ok('an empty archive is answered with nulls, not a crash', emptyCheck.battles === 0 && emptyCheck.brier === null, emptyCheck);
ok('rows with no win_chance are ignored by the check',
    ledger.storedWinChanceCheck([battle(100, 100, true, 50, 50)]).battles === 0);
// SQLite returns NULL as null, and Number(null) is 0 — a finite, plausible zero. The first
// version of this module scored 1029 live battles when only 1025 carry a win_chance, and
// its mean distance to random_number came out 0.47 instead of 0.28, because four nulls had
// silently become "predicted 0%".
ok('a NULL win_chance is missing, not a prediction of zero',
    ledger.storedWinChanceCheck([
        { ...battle(100, 100, true, 50, 50), win_chance: null, random_number: null },
        { ...battle(100, 100, true, 50, 50), win_chance: 80, random_number: 80 },
    ]).battles === 1);
ok('a NULL cost column is left out of the average rather than averaged in as zero',
    ledger.costCurve([
        battle(200, 100, true, 40, 100),
        { ...battle(200, 100, true, 40, 100), att_pct_cv_lost: null },
    ]).bands.find(b => b.label === '1.6-2.5x').attackerLossPct === 40);
ok('a NULL combat value is skipped, not read as zero',
    ledger.costCurve([{ ...battle(200, 100, true, 40, 100), def_combat_value: null }]).skipped === 1);

// --- Empty input -------------------------------------------------------------
const empty = ledger.costCurve([]);
ok('an empty archive yields bands with no battles rather than nulls everywhere', empty.battles === 0 && empty.bands.length === 7, empty.bands.length);
ok('an empty archive has no thresholds to report', ledger.thresholds(empty).alwaysWonFrom === null);

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
