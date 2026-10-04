// Landing planner: chains of landings in one cycle, and the sacrifice search (2026-10-04).
//
// The single fights are already pinned against the battle model (incoming-battle.test.js),
// so this checks that the CHAIN reproduces them exactly where the chain is one fight long,
// and then the parts only a chain has: allies fighting each other, a level-up carried into
// the next fight, the three outcomes adding up, and the sacrifice search.
//
// Run with: node src/utils/landing-planner.test.js

const path = require('path');
const model = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'battle-model.js'));
const B = require(path.join(__dirname, 'incoming-battle.js'));
const P = require(path.join(__dirname, 'landing-planner.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('landing-planner.test.js');

const plain = { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5, totalXp: null };
const worst = { ra: 4, rd: 4, phys: 15, math: 15, lvl: 4, totalXp: 300 };
const planet = (sbLevel, garrison = [0, 0, 0]) => ({ sbLevel, garrison, owner: plain, ownerName: 'Owner' });
const enemy = (fleet) => ({ name: 'Enemy', fleet, stats: worst });

// --- One fight long: the chain is the alert's own numbers -------------------------------
{
    const e = [1, 1, 20];
    const alone = P.simulateChain({ planet: planet(12), enemy: enemy(e), landings: [] });
    const f = B.planetFight({ enemyFleet: e, enemy: worst, sbLevel: 12, garrison: [0, 0, 0], owner: plain });
    ok('nobody landing: held = the planet fight', near(alone.held, f.holds) && near(alone.lost, 1 - f.holds), { alone, holds: f.holds });
    ok('the three outcomes add up to 1', near(alone.held + alone.retaken + alone.lost, 1));

    const ally = [400, 1, 1];
    const after = P.simulateChain({ planet: planet(12), enemy: enemy(e), landings: [{ name: 'Ally', fleet: ally, stats: plain, when: 'after' }] });
    const c = B.counterFight({ allyFleet: ally, ally: plain, enemyLeft: f.enemyLeft, enemy: f.enemyAfter });
    ok('one ally after: retaken = P(planet falls) x the counter-attack, with his level-up',
        near(after.retaken, (1 - f.holds) * c.win), { after, c, holds: f.holds });

    const own = [300, 1, 1];
    const reinforce = P.simulateChain({ planet: planet(12), enemy: enemy(e), landings: [{ name: 'Owner', fleet: own, stats: plain, when: 'before', isOwner: true }] });
    const ro = B.ownerReinforce({ allyFleet: own, enemyFleet: e, enemy: worst, sbLevel: 12, garrison: [0, 0, 0], owner: plain });
    ok('the owner landing first joins his starbase (no fight with it)', near(reinforce.held, ro.win) && reinforce.likely[0].joined === true, { reinforce, ro });
}

// --- An ally landing first fights the starbase ------------------------------------------
{
    const e = [100, 5, 0];
    const ally = [300, 0, 0];
    const chain = P.simulateChain({ planet: planet(9), enemy: enemy(e), landings: [{ name: 'Ally', fleet: ally, stats: plain, when: 'before' }] });
    const lb = B.landBefore({ allyFleet: ally, ally: plain, owner: plain, sbLevel: 9, enemyFleet: e, enemy: worst });
    ok('ally first: he fights the starbase (step 1 is a fight against the owner)', chain.likely[0].fight && chain.likely[0].against === 'Owner', chain.likely);
    ok('holding is at least the alert\'s "before" number (a failed kill leaves a damaged starbase that may still hold)',
        chain.held >= lb.win - 1e-9, { chain: chain.held, lb: lb.win });
}

// --- Allies landing on each other fight -------------------------------------------------
{
    const e = [60, 0, 0];
    const chain = P.simulateChain({ planet: planet(0), enemy: enemy(e), landings: [
        { name: 'First', fleet: [100, 0, 0], stats: plain, when: 'before' },
        { name: 'Second', fleet: [100, 0, 0], stats: plain, when: 'before' },
    ] });
    ok('the second ally landing fights the first', chain.likely[1].fight && chain.likely[1].against === 'First', chain.likely);
    const solo = P.simulateChain({ planet: planet(0), enemy: enemy(e), landings: [{ name: 'First', fleet: [100, 0, 0], stats: plain, when: 'before' }] });
    ok('so two allies landing first hold LESS than one (they wear each other down)', chain.held < solo.held, { two: chain.held, one: solo.held });
}

// --- Level-ups carry into the next fight -------------------------------------------------
{
    const e = [1, 1, 20];   // all three types: player level counts for him
    const chain = P.simulateChain({ planet: planet(12), enemy: enemy(e), landings: [] });
    ok('taking SB 12 (515 CV) lifts a 300-XP PL 4 attacker to PL 6', chain.enemyEndLevel === 6, chain.enemyEndLevel);
    ok('damaged-starbase levels: the level its remaining CV pays for', P.sbLevelLeft(12, 1) === 12 && P.sbLevelLeft(12, 0) === 0
        && model.sbCV(P.sbLevelLeft(12, 0.5)) <= model.sbCV(12) * 0.5 && model.sbCV(P.sbLevelLeft(12, 0.5) + 1) > model.sbCV(12) * 0.5);
}

// --- The sacrifice search -----------------------------------------------------------------
{
    const e = [200, 4, 4];
    const decoy = { name: 'Decoy', fleet: [300, 0, 0], stats: plain };
    const closer = { name: 'Closer', fleet: [260, 1, 1], stats: plain };
    const s = P.bestSacrifice({ planet: planet(10), enemy: enemy(e), decoy, closer });
    ok('the best plan is never worse than the closer alone', s.best && s.best.notLost >= s.baseline.notLost - 1e-9, { best: s.best && s.best.notLost, base: s.baseline.notLost });
    ok('both placements are tried', s.curve.some(c => c.when === 'before') && s.curve.some(c => c.when === 'after'));
    ok('every share is whole ships, at most the whole fleet', s.curve.every(c => c.fleet.every(Number.isInteger) && c.fleet[0] <= 300));
    const top = s.curve.reduce((a, c) => Math.max(a, c.notLost), 0);
    ok('the best is the best point on the curve', near(s.best.notLost, top), { best: s.best.notLost, top });
    ok('and it helps here', s.best.notLost > s.baseline.notLost + 0.01, { best: s.best, base: s.baseline.notLost });
    ok('the cheapest plan is the smallest decoy within the margin of the best',
        s.cheapest.cv <= s.best.cv && s.cheapest.notLost >= s.best.notLost - P.CHEAP_MARGIN
        && !s.curve.some(c => c.cv < s.cheapest.cv && c.notLost >= s.best.notLost - P.CHEAP_MARGIN), { cheapest: s.cheapest.cv, best: s.best.cv });
    ok('the table samples every 10% of both placements', s.table.filter(t => t.when === 'after').every(t => t.share % 10 === 0) && s.table.length > 0);
}

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
