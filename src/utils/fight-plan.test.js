// Fight simulation plan: the dice roll, who gets wiped, and how ships map to icons.
//
// Run with:  node src/utils/fight-plan.test.js      (also runs as part of `npm test`)

const assert = require('assert');
const path = require('path');

const M = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'battle-model.js'));
const P = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'fight-plan.js'));

let failed = false;
function test(name, fn) {
    try { fn(); console.log(`✅ ${name}`); }
    catch (e) { failed = true; console.log(`❌ ${name}\n   ${e.message}`); }
}

// A close fight: 140/45/18 + starbase 8 against 180/50/20, attacker ~66%.
const close = M.simulate(M.normalizeInputs({
    defFleet: [140, 45, 18], atkFleet: [180, 50, 20], sbLevel: 8, def: {}, atk: {}
}));

test('the sample fight is a real coin flip, not a certain result', () => {
    assert.ok(close.winD > 0.2 && close.winD < 0.5, `winD ${close.winD}`);
});

test('a roll under the defender share is a defender win', () => {
    const o = P.rollOutcome(close, close.winD - 0.0001);
    assert.strictEqual(o.winner, 'def');
    assert.deepStrictEqual(o.survDef, close.survDef);
    assert.strictEqual(o.survSB, close.survSB);
    assert.deepStrictEqual(o.survAtk, [0, 0, 0]);
});

test('a roll on or over the defender share is an attacker win, defender and starbase wiped', () => {
    const o = P.rollOutcome(close, close.winD);
    assert.strictEqual(o.winner, 'atk');
    assert.deepStrictEqual(o.survAtk, close.survAtk);
    assert.deepStrictEqual(o.survDef, [0, 0, 0]);
    assert.strictEqual(o.survSB, 0);
});

test('the roll does not change the model result it was given', () => {
    const before = JSON.stringify(close);
    P.rollOutcome(close, 0.9);
    assert.strictEqual(JSON.stringify(close), before);
});

test('a certain win cannot be lost on the roll', () => {
    const sure = M.simulate(M.normalizeInputs({ defFleet: [10, 0, 0], atkFleet: [0, 0, 50], sbLevel: 0, def: {}, atk: {} }));
    assert.strictEqual(sure.winA, 1);
    assert.strictEqual(P.rollOutcome(sure, 0).winner, 'atk');
});

test('small fleets get one icon per ship', () => {
    const plan = P.iconPlan([12, 5, 3], [4.4, 0.6, 0]);
    assert.deepStrictEqual(plan, [
        { per: 1, icons: 12, keep: 4 },
        { per: 1, icons: 5, keep: 1 },
        { per: 1, icons: 3, keep: 0 },
    ]);
});

test('big fleets are grouped under the caps', () => {
    const plan = P.iconPlan([900, 100, 40], [450, 0, 40]);
    plan.forEach((p, t) => assert.ok(p.icons <= P.ICON_CAPS[t], `type ${t}: ${p.icons} icons`));
    assert.strictEqual(plan[0].per, 15);
    assert.strictEqual(plan[0].keep, 30);
    assert.strictEqual(plan[1].keep, 0);
    assert.strictEqual(plan[2].keep, plan[2].icons);
});

test('a winner with one surviving ship keeps one icon even when grouped', () => {
    const plan = P.iconPlan([300, 0, 0], [1, 0, 0]);
    assert.strictEqual(plan[0].per, 5);
    assert.strictEqual(plan[0].keep, 1);
});

test('starbase level left uses whole levels of the remaining CV', () => {
    assert.strictEqual(P.sbLevelLeft(M.sbCV, 8, 1), 8);
    assert.strictEqual(P.sbLevelLeft(M.sbCV, 8, 0), 0);
    // level 8 = 99 CV; 27% left = 26.7 CV, level 5 is 26 CV and level 6 is 42
    assert.strictEqual(P.sbLevelLeft(M.sbCV, 8, 0.27), 5);
});

if (failed) process.exit(1);
