// The incoming-alert battle lines: planet first, then defenders (2026-10-04).
//
// What is pinned here is the ORDER of the fight, which is the part the alerts had wrong:
// the attacker meets the starbase (and the owner's ships on the planet) first; an ally
// lands after that against what is left; the owner's own fleet stands with his starbase.
// The battle numbers themselves come from battle-model.js and are checked against the
// game's calculator in battle-calc.test.js — this only checks they are wired in the right
// order and with the right sides.
//
// Run with: node src/utils/incoming-battle.test.js

const path = require('path');
const model = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'battle-model.js'));
const AWTables = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-tables.js'));
const B = require(path.join(__dirname, 'incoming-battle.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('incoming-battle.test.js');

const plain = { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5 };
const worst = { ra: 4, rd: 4, phys: 15, math: 15, lvl: 5 };   // an unscouted attacker

// --- The planet fight is the battle model's own, with the starbase on the defence ---------
{
    const enemyFleet = [51, 0, 0];
    const f = B.planetFight({ enemyFleet, enemy: worst, sbLevel: 9, garrison: [0, 0, 0], owner: plain });
    const direct = model.simulate({ defFleet: [0, 0, 0], atkFleet: enemyFleet, sbLevel: 9, def: plain, atk: worst });
    ok('planetFight is simulate() with the starbase and garrison defending', f.holds === direct.winD && f.sbLevel === 9, { f, direct });
    ok('what is left of the attacker is the model\'s attacker survivors', f.enemyLeftCv === model.cvOf(direct.survAtk));
    ok('the starbase costs the attacker ships: it keeps less than it brought', f.enemyLeftCv < model.cvOf(enemyFleet), f.enemyLeftCv);

    const big = B.planetFight({ enemyFleet: [9, 0, 0], enemy: worst, sbLevel: 12, garrison: [0, 0, 0], owner: plain });
    ok('a strong starbase holds outright against a small attack', big.holds >= B.HOLDS, big.holds);
    ok('and then nothing of the attacker is left on the planet', big.enemyLeftCv === 0, big.enemyLeft);

    const withGarrison = B.planetFight({ enemyFleet, enemy: worst, sbLevel: 9, garrison: [20, 0, 0], owner: plain });
    ok('the owner\'s ships on the planet fight beside the starbase', withGarrison.holds > f.holds && withGarrison.garrisonCv === 60, withGarrison);
}

// --- An ally lands AFTER: against what the starbase left, not the whole fleet ------------
{
    const enemyFleet = [120, 5, 0];
    const fight = B.planetFight({ enemyFleet, enemy: worst, sbLevel: 9, garrison: [0, 0, 0], owner: plain });
    const allyFleet = [180, 0, 0];   // 44% after the starbase, 19% against the whole fleet
    const after = B.counterFight({ allyFleet, ally: plain, enemyLeft: fight.enemyLeft, enemy: worst });
    const alone = B.counterFight({ allyFleet, ally: plain, enemyLeft: enemyFleet, enemy: worst });
    ok('landing after the starbase fight beats meeting the whole fleet', after.win > alone.win, { after, alone });
    const direct = model.simulate({ defFleet: fight.enemyLeft, atkFleet: allyFleet, sbLevel: 0, def: worst, atk: plain });
    ok('the ally is the attacker and the enemy now defends the planet, with no starbase', after.win === direct.winA && after.keepCv === direct.cvAtkRemain);
    const nothingLeft = B.counterFight({ allyFleet, ally: plain, enemyLeft: [0, 0, 0], enemy: worst });
    ok('nothing left to fight: a certain win that costs nothing', nothingLeft.win === 1 && nothingLeft.keepCv === model.cvOf(allyFleet));
}

// --- An ally lands BEFORE: kills the starbase, then holds the planet --------------------
{
    const enemyFleet = [100, 5, 0];
    const allyFleet = [200, 0, 0];
    const noSb = B.landBefore({ allyFleet, ally: plain, owner: plain, sbLevel: 0, enemyFleet, enemy: worst });
    const direct = model.simulate({ defFleet: allyFleet, atkFleet: enemyFleet, sbLevel: 0, def: plain, atk: worst });
    ok('no starbase: he simply defends the planet with his whole fleet', noSb.win === direct.winD && noSb.sbCostCv === 0, noSb);
    const withSb = B.landBefore({ allyFleet, ally: plain, owner: plain, sbLevel: 9, enemyFleet, enemy: worst });
    const kill = model.simulate({ defFleet: [0, 0, 0], atkFleet: allyFleet, sbLevel: 9, def: plain, atk: plain });
    const hold = model.simulate({ defFleet: kill.survAtk, atkFleet: enemyFleet, sbLevel: 0, def: plain, atk: worst });
    ok('with a starbase he fights it first (he attacks, the owner\'s stats defend) and pays in ships',
        withSb.sbCostCv === model.cvOf(allyFleet) - kill.cvAtkRemain && withSb.sbCostCv > 0, withSb);
    ok('then holds with what is left: P(kill) x P(hold)', Math.abs(withSb.win - kill.winA * hold.winD) < 1e-12, { withSb, k: kill.winA, h: hold.winD });
    ok('so killing the starbase first is never better than finding no starbase', withSb.win <= noSb.win);
    const tooWeak = B.landBefore({ allyFleet: [3, 0, 0], ally: plain, owner: plain, sbLevel: 12, enemyFleet, enemy: worst });
    ok('a fleet that cannot beat the starbase holds nothing', tooWeak.win === 0 && tooWeak.keepCv === 0, tooWeak);
}

// --- The owner lands BEFORE: his fleet joins his starbase ---------------------------------
{
    const ctx = { enemyFleet: [120, 5, 0], enemy: worst, sbLevel: 9, garrison: [10, 0, 0], owner: plain };
    const r = B.ownerReinforce({ ...ctx, allyFleet: [40, 0, 0] });
    const same = B.planetFight({ ...ctx, garrison: [50, 0, 0] });
    ok('the owner reinforcing is the planet fight with a bigger garrison', r.win === same.holds && r.keepCv === same.garrisonLeftCv, { r, same });
    ok('what he keeps is ships, never more than he brought (the starbase is not counted)', r.keepCv <= model.cvOf([50, 0, 0]), r);
}

// --- What the planet's own PP buys before the attack lands --------------------------------
{
    const ctx = { enemyFleet: [51, 0, 0], enemy: worst, garrison: [0, 0, 0], owner: plain };
    const up = B.sbUpgrade({ ...ctx, sbLevel: 0, budgetPp: 100000 });
    ok('with plenty of PP it stops at the CHEAPEST level that holds', up.holds >= B.HOLDS
        && B.planetFight({ ...ctx, sbLevel: up.level - 1 }).holds < B.HOLDS, up);
    ok('the cost is the sum of the level costs from the current level', up.cost === AWTables.aggregate(AWTables.BUILDING, 0, up.level), up);
    const from5 = B.sbUpgrade({ ...ctx, sbLevel: 5, budgetPp: 100000 });
    ok('starting from an existing starbase only the missing levels are paid', from5.cost === AWTables.aggregate(AWTables.BUILDING, 5, from5.level), from5);
    const poor = B.sbUpgrade({ ...ctx, sbLevel: 0, budgetPp: 30 });
    ok('a small budget gets the highest level it can pay for', poor.level === 3 && poor.cost === 24, poor);
    const big = { ...ctx, enemyFleet: [400, 0, 0] };
    const partial = B.sbUpgrade({ ...big, sbLevel: 0, budgetPp: 250 });
    ok('a starbase that still loses reports how much of the attacker it destroys',
        partial.holds < 0.5 && partial.enemyLeftCv < B.planetFight({ ...big, sbLevel: 0 }).enemyLeftCv, partial);
    ok('not even one level affordable -> null', B.sbUpgrade({ ...ctx, sbLevel: 0, budgetPp: 4 }) === null);
    ok('PP keep accruing at the planet\'s rate until arrival', B.ppAfter({ production_pp: 100, production_rate: 30 }, 2.5) === 175);
    ok('a past arrival adds nothing', B.ppAfter({ production_pp: 100, production_rate: 30 }, -1) === 100);
}

// --- Our own players are rated by their real sciences -------------------------------------
{
    const old = '2026-09-01 10:00:00', fresh = '2026-10-04 14:00:00';
    const row = { has_intel: 1, race_attack: 2, race_defense: 1, physics: 9, mathematics: 9, science_level: 25, level: 7,
        intel_updated_at: old, sheet_physics: 15, sheet_mathematics: 12, sheet_sciences_updated_at: fresh };
    const s = B.allySide(row);
    ok('an aged scan does not fall back to science level for an ally', s.phys !== 25 && s.math !== 25, s);
    ok('the fresher member sheet wins', s.phys === 15 && s.math === 12, s);
    ok('race and level come from the scan', s.ra === 2 && s.rd === 1 && s.lvl === 7, s);
    const noSheet = B.allySide({ ...row, sheet_physics: null, sheet_mathematics: null, sheet_sciences_updated_at: null });
    ok('without a sheet the scan\'s own sciences are used, not the science level', noSheet.phys === 9 && noSheet.math === 9, noSheet);
    const unscanned = B.allySide({ has_intel: 0, level: 4, science_level: 25, sheet_physics: 11, sheet_mathematics: 8, sheet_sciences_updated_at: fresh });
    ok('an unscanned ally is NOT given the enemy worst case (+4/+4)', unscanned.ra === 0 && unscanned.rd === 0, unscanned);
    ok('but still gets his sheet sciences and level', unscanned.phys === 11 && unscanned.math === 8 && unscanned.lvl === 4, unscanned);
    ok('nothing known at all -> neutral and flagged', B.allySide(null).ra === 0 && B.allySide(null).unknown === true);
}

// --- Percentages --------------------------------------------------------------------------
ok('whole numbers in the middle', B.pct(0.873) === '87%');
ok('"almost certain" keeps a decimal so it never reads as 100%', B.pct(0.9987) === '99.8%');
ok('certain is 100%', B.pct(1) === '100%' && B.pct(0) === '0%');
ok('a sliver is not rounded to 0%', B.pct(0.0004) === '0.1%');

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
