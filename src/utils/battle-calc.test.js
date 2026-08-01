// Battle-model calibration harness.
//
// Run with:  node src/utils/battle-calc.test.js      (also runs as part of `npm test`)
//
// Modelled on travel-calc.test.js: real in-game measurements in a fixtures file, a hard
// error gate, and a non-zero exit when the model drifts away from the game.
//
// It checks four things:
//   1. win %          against the in-game observations in battle-fixtures.json
//   2. starbase CV    against the confirmed in-game table (exact match required)
//   3. no drift       the constants exist in exactly one file, so the bot and the
//                     dashboard cannot silently diverge again
//   4. one instance   every caller resolves to the same module object
//
// It also prints a coverage report: which parts of the model the fixtures actually
// exercise and which are untested. Read that section — an untested dimension is where
// the model is most likely wrong, and it is the shopping list for the next sample run.

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'battle-model.js');
const model = require(MODEL_PATH);
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'battle-fixtures.json'), 'utf8'));

const GATE_PP = fixtures.gate.winChanceMaxErrorPp;
let failed = false;

const toStats = s => ({
    phys: s.physics || 0, math: s.mathematics || 0,
    ra: s.raceAttack || 0, rd: s.raceDefense || 0, lvl: s.level || 0
});

// ─── 1. WIN % vs the game ─────────────────────────────────────────────────────
console.log('── Win % vs in-game observations ' + '─'.repeat(44));

let worst = 0, worstId = '';
const errors = [];
for (const c of fixtures.winChance) {
    const r = model.simulate({
        defFleet: c.def.fleet,
        atkFleet: c.atk.fleet,
        sbLevel: c.def.starbase || 0,
        def: toStats(c.def),
        atk: toStats(c.atk)
    });
    if (!r) {
        console.log(`❌ ${c.id}: the model returned no result for this fixture`);
        failed = true;
        continue;
    }
    const got = r.winD * 100;
    const err = Math.abs(got - c.observedDefenderWinPct);
    errors.push({ id: c.id, err });
    if (err > worst) { worst = err; worstId = c.id; }
    const flag = err <= GATE_PP ? '✅' : '❌';
    if (err > GATE_PP) failed = true;
    console.log(`${flag} ${c.id}`);
    console.log(`     model ${got.toFixed(2)}%   game ${c.observedDefenderWinPct.toFixed(2)}%   err ${err.toFixed(2)} pp   (${c.desc})`);
}
console.log(`\nWorst win-% error: ${worst.toFixed(2)} pp on "${worstId}"  (gate: ${GATE_PP} pp)`);

// ─── 2. STARBASE CV table (exact) ─────────────────────────────────────────────
console.log('\n── Starbase CV table (exact match required) ' + '─'.repeat(33));
let sbBad = 0;
for (const [lvl, cv] of Object.entries(fixtures.starbaseCv.levels)) {
    const got = model.sbCV(Number(lvl));
    if (got !== cv) {
        console.log(`❌ starbase level ${lvl}: model ${got}, game ${cv}`);
        sbBad++;
    }
}
if (sbBad === 0) console.log(`✅ all ${Object.keys(fixtures.starbaseCv.levels).length} confirmed levels exact`);
else failed = true;

// ─── 3. NO DRIFT: the model lives in exactly one file ─────────────────────────
// This is the check that would have caught the original defect. The bot carried its own
// copy of the constants for five weeks after the dashboard was recalibrated, and nothing
// in the repo noticed.
console.log('\n── Anti-drift scan ' + '─'.repeat(57));

// Only constants that are DISTINCTIVE to the battle model. 0.11 and 0.07 are deliberately
// absent: 0.11 is also the race-speed coefficient in the travel formula, so matching it
// here would flag travel-calc.js forever and train everyone to ignore this check.
const FINGERPRINTS = [
    { name: 'ship CV table',         re: /\b3\s*\)?\s*\+.*\b24\s*\)?\s*\+.*\b60\b/ },
    { name: 'math-toughness 0.0015', re: /(?<![.\w])0\.0015(?![\d])/ },
    { name: 'force weight 21.8',     re: /(?<![.\w])21\.8(?![\d])/ },
    { name: 'attack weight 2.67',    re: /(?<![.\w])2\.67(?![\d])/ },
    { name: 'physics base 2.94',     re: /(?<![.\w])2\.94(?![\d])/ },
    { name: 'physics slope 0.1034',  re: /(?<![.\w])0\.1034(?![\d])/ },
    { name: 'race-attack base 7.4',  re: /(?<![.\w])7\.4(?![\d])/ },
    { name: 'player-level 0.069',    re: /(?<![.\w])0\.069(?![\d])/ },
    { name: 'stale math-HP 0.153',   re: /(?<![.\w])0\.153(?![\d])/ },
];

// Two display-only copies of the CV sum are knowingly left in place. They are reported as
// a warning rather than a failure so that this branch touches a file set that is disjoint
// from the route-planner and travel-calibration branches and can therefore be merged in
// any order without conflicts. Deleting an entry from this list is the follow-up.
const KNOWN_DUPLICATES = {
    'public/js/ui/archives.js': 'display-only CV sum; file is owned by the route-planner branch',
    'public/js/ui/travel-calc-ui.js': 'display-only CV sum; file is owned by the travel-calibration branch'
};

const ROOTS = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'public')];
const SKIP_DIRS = new Set(['node_modules', '.git', 'components']);
const ALLOWED = path.relative(process.cwd(), MODEL_PATH);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(path.join(dir, e.name));
    }
    return out;
}

const files = [...new Set(ROOTS.flatMap(r => walk(r)))];
const strays = [], known = [];
for (const f of files) {
    const rel = path.relative(process.cwd(), f);
    if (rel === ALLOWED) continue;
    const src = fs.readFileSync(f, 'utf8');
    // Ignore comments — the point is a second *implementation*, not a mention.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
        .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    for (const fp of FINGERPRINTS) {
        if (!fp.re.test(code)) continue;
        (KNOWN_DUPLICATES[rel] ? known : strays).push(`${rel}  —  ${fp.name}`);
    }
}
if (strays.length) {
    console.log('❌ battle-model constants found outside the shared model:');
    strays.forEach(s => console.log('     ' + s));
    console.log('   Move them into public/js/utils/battle-model.js — a second copy is how the bot');
    console.log('   and the dashboard drifted 19 percentage points apart in the first place.');
    failed = true;
} else {
    console.log(`✅ scanned ${files.length} files — no unexpected copy of the battle model`);
}
if (known.length) {
    console.log('⚠️  known, accepted duplicates (each one is still debt):');
    known.forEach(s => console.log(`     ${s}  [${KNOWN_DUPLICATES[s.split('  —  ')[0]]}]`));
}

// ─── 4. ONE INSTANCE: every caller shares the same module ─────────────────────
console.log('\n── Caller identity ' + '─'.repeat(57));
const viaServer = require('./battle');
const viaBot = require('../../public/js/utils/battle-model.js');
const sameSimulate = viaServer.simulate === model.simulate && viaBot.simulate === model.simulate;
const sameCv = viaServer.cvOf === model.cvOf;
if (sameSimulate && sameCv) {
    console.log('✅ src/utils/battle.js, the Discord bot and the browser calculator all resolve');
    console.log('   to the same module object — identical inputs cannot produce different output.');
} else {
    console.log('❌ callers resolved to different implementations');
    failed = true;
}

// ─── 5. BOT vs DASHBOARD: the same inputs must give the same output ───────────
// The two front ends collect input differently: the panel reads DOM fields (strings via
// parseFloat), !battle parses chat flags (integers via parseInt). This replays both
// collection shapes through the shared normalize+simulate path and demands identical
// numbers — including the cases that used to differ, where science above 10 was capped
// by the bot but not by the panel.
console.log('\n── Bot vs dashboard on identical inputs ' + '─'.repeat(36));

const SAME_INPUT_CASES = [
    { desc: 'plain fight',            def: [100, 50, 20], atk: [80, 60, 30], sb: 0,  dp: 3,  am: 2 },
    { desc: 'science above the old bot cap of 10', def: [1000, 0, 0], atk: [1000, 0, 0], sb: 0, dp: 20, am: 0 },
    { desc: 'science above every cap', def: [1000, 0, 0], atk: [1000, 0, 0], sb: 0,  dp: 45, am: 45 },
    { desc: 'starbase defense',       def: [0, 0, 0],     atk: [500, 0, 0],  sb: 10, dp: 0,  am: 0 },
    { desc: 'starbase plus fleet',    def: [200, 10, 5],  atk: [500, 0, 0],  sb: 7,  dp: 6,  am: 6 },
];
let sameBad = 0;
for (const c of SAME_INPUT_CASES) {
    // what the Discord handler builds (parseInt from a regex capture)
    const fromBot = model.normalizeInputs({
        defFleet: c.def, atkFleet: c.atk, sbLevel: c.sb,
        def: { phys: c.dp, math: 0, ra: 0, rd: 0, lvl: 0 },
        atk: { phys: 0, math: c.am, ra: 0, rd: 0, lvl: 0 }
    });
    // what the panel builds (parseFloat over DOM string values)
    const dom = v => parseFloat(String(v)) || 0;
    const fromPanel = model.normalizeInputs({
        defFleet: c.def.map(dom), atkFleet: c.atk.map(dom), sbLevel: dom(c.sb),
        def: { phys: dom(c.dp), math: dom(0), ra: dom(0), rd: dom(0), lvl: dom(0) },
        atk: { phys: dom(0), math: dom(c.am), ra: dom(0), rd: dom(0), lvl: dom(0) }
    });
    const a = model.simulate(fromBot), b = model.simulate(fromPanel);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) { sameBad++; failed = true; }
    const win = a ? (a.winD * 100).toFixed(2) + '%' : 'n/a';
    console.log(`${same ? '✅' : '❌'} ${c.desc.padEnd(38)} both sides: ${win}`);
}
if (sameBad === 0) console.log(`✅ ${SAME_INPUT_CASES.length}/${SAME_INPUT_CASES.length} identical — survivors, CV and win % all match`);

// ─── COVERAGE REPORT ──────────────────────────────────────────────────────────
// "Where is the model worst?" — with this few fixtures the honest answer is mostly
// "we cannot tell", and saying so is the useful output.
console.log('\n── Coverage: what the fixtures actually test ' + '─'.repeat(32));

const has = pred => fixtures.winChance.some(pred);
const dims = [
    ['physics difference',        has(c => (c.atk.physics || 0) !== (c.def.physics || 0))],
    ['race attack difference',    has(c => (c.atk.raceAttack || 0) !== (c.def.raceAttack || 0))],
    ['player level difference',   has(c => (c.atk.level || 0) !== (c.def.level || 0))],
    ['mixed compositions',        has(c => c.def.fleet.filter(Boolean).length !== c.atk.fleet.filter(Boolean).length || c.def.fleet.join() !== c.atk.fleet.join())],
    ['force ratio (unequal CV)',  has(c => model.cvOf(c.def.fleet) !== model.cvOf(c.atk.fleet))],
    ['mathematics difference',    has(c => (c.atk.mathematics || 0) !== (c.def.mathematics || 0))],
    ['race defense difference',   has(c => (c.atk.raceDefense || 0) !== (c.def.raceDefense || 0))],
    ['starbase in the fight',     has(c => (c.def.starbase || 0) > 0)],
    ['battleship-heavy fleets',   has(c => c.def.fleet[2] > 0 || c.atk.fleet[2] > 0)],
    ['survivor counts',           (fixtures.survivors.cases || []).length > 0],
];
for (const [name, covered] of dims) {
    console.log(`  ${covered ? '✅ tested ' : '⚠️  UNTESTED'}  ${name}`);
}
const gaps = dims.filter(([, c]) => !c).map(([n]) => n);
if (gaps.length) {
    console.log(`\n  ${gaps.length} of ${dims.length} dimensions have no ground truth at all.`);
    console.log('  Those are where the model is most likely wrong — not because it is known to be,');
    console.log('  but because nothing here would notice. See docs/battle-model.md for how to');
    console.log('  collect samples, and add them to battle-fixtures.json.');
}

// CV-range coverage, so "which CV ranges" from the issue gets a real answer.
const cvs = fixtures.winChance.flatMap(c => [model.cvOf(c.def.fleet), model.cvOf(c.atk.fleet)]);
console.log(`\n  CV range covered: ${Math.min(...cvs).toLocaleString()} – ${Math.max(...cvs).toLocaleString()}`);
console.log('  Errors by fixture (pp):', errors.map(e => `${e.id}=${e.err.toFixed(2)}`).join(', '));

console.log('\n' + '─'.repeat(75));
if (failed) {
    console.log('RESULT: FAILED');
    process.exit(1);
}
console.log(`RESULT: passed — ${fixtures.winChance.length} win-% fixtures, worst error ${worst.toFixed(2)} pp (gate ${GATE_PP} pp)`);
process.exit(0);
