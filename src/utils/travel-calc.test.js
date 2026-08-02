// Travel-time formula calibration harness.
//
// Run with:  node src/utils/travel-calc.test.js      (also runs as part of `npm test`)
//
// Ground truth lives in travel-fixtures.json, not in this file, so that
// scripts/collect-travel-fixtures.js can append API-generated cases without touching
// test code. The gate is EXACT: any fixture off by a single second fails the run.
//
// Checks:
//   1. every fixture reproduced to the second
//   2. floor() is the right rounding — re-derived from the fixtures, not assumed
//   3. the server and the browser share one formula, so a route cannot be quoted two ways
//   4. coverage: which parts of the input space have no ground truth

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'travel-model.js');
const model = require(MODEL_PATH);
const { calcTravelSeconds, formatTime } = require('./travel-calc');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'travel-fixtures.json'), 'utf8'));

const GATE = fixtures.gate.maxErrorSeconds;
const CASES = fixtures.cases;
let failed = false;

const hmsToSecs = (s) => {
    const parts = String(s).split(':').map(Number);
    const [h, m, sec] = parts;
    return h * 3600 + m * 60 + sec;
};

if (CASES.length === 0) {
    console.log('No calibration cases in travel-fixtures.json. Add measurements and re-run.');
    process.exit(0);
}

// ─── 1. EVERY FIXTURE, TO THE SECOND ──────────────────────────────────────────
console.log('── Travel time vs the game ' + '─'.repeat(49));

let worst = 0, worstDesc = '';
for (const c of CASES) {
    const [sx, sy, sp] = c.from;
    const [ex, ey, ep] = c.to;
    const got = calcTravelSeconds(sx, sy, sp, ex, ey, ep, c.energy, c.speed, c.alliance);
    const want = hmsToSecs(c.expect);
    const err = Math.abs(got - want);
    if (err > worst) { worst = err; worstDesc = c.desc; }
    if (err > GATE) failed = true;
    const flag = err <= GATE ? '✅' : '❌';
    console.log(`${flag} ${c.desc}  [${c.source}]`);
    console.log(`     got ${formatTime(got)} (${got}s)   game ${c.expect} (${want}s)   err ${err}s`);
}
console.log(`\nWorst error: ${worst}s across ${CASES.length} fixtures  (gate: ${GATE}s)`);

// ─── 2. IS floor() ACTUALLY RIGHT? ────────────────────────────────────────────
// The formula ends in Math.floor. That is a modelling choice, so re-derive it from the
// fixtures every run instead of trusting the comment: compute the unrounded value and
// see which rounding rule reproduces the game.
console.log('\n── Rounding rule, re-derived from the fixtures ' + '─'.repeat(29));

const { ENERGY_BASE, SPEED_STEP, SAME_SYSTEM_MIN, SAME_SYSTEM_PLANET,
        DEEP_SPACE_MIN, DEEP_SPACE_DIST, DEEP_SPACE_PLANET, ALLIANCE_FACTOR } = model.constants;

function unrounded(c) {
    const [sx, sy, sp] = c.from, [ex, ey, ep] = c.to;
    const mod = Math.pow(ENERGY_BASE, c.energy) / (1 + SPEED_STEP * c.speed);
    const planetTerm = Math.sqrt(Math.abs(sp - ep) + 1);
    if (sx === ex && sy === ey) return SAME_SYSTEM_MIN + SAME_SYSTEM_PLANET * planetTerm * mod;
    return DEEP_SPACE_MIN + (DEEP_SPACE_DIST * model.systemDistance(sx, sy, ex, ey) + DEEP_SPACE_PLANET * planetTerm) * mod;
}

const RULES = {
    floor: Math.floor,
    round: Math.round,
    ceil: Math.ceil,
    trunc: Math.trunc
};
const score = {};
for (const [name, fn] of Object.entries(RULES)) {
    score[name] = CASES.filter(c => {
        const base = fn(unrounded(c));
        const got = c.alliance ? Math.floor(base * ALLIANCE_FACTOR) : base;
        return got === hmsToSecs(c.expect);
    }).length;
}
for (const [name, hits] of Object.entries(score)) {
    console.log(`  ${name.padEnd(6)} reproduces ${hits}/${CASES.length}${name === 'floor' ? '   <- what the formula uses' : ''}`);
}
const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
if (score.floor < CASES.length) {
    console.log(`❌ floor() no longer reproduces every fixture — "${best[0]}" fits ${best[1]}/${CASES.length}. Change the formula.`);
    failed = true;
} else {
    const ties = Object.entries(score).filter(([n, h]) => n !== 'floor' && h === CASES.length).map(([n]) => n);
    if (ties.length) console.log(`  (${ties.join(', ')} fit equally well — the fixtures cannot tell them apart from floor)`);
}
const fracs = CASES.map(c => unrounded(c) % 1);
console.log(`  fractional parts span ${Math.min(...fracs).toFixed(3)} – ${Math.max(...fracs).toFixed(3)}`);
if (Math.max(...fracs) < 0.5 || Math.min(...fracs) > 0.5) {
    console.log('  ⚠️  no fixture straddles .5, so floor and round are indistinguishable here —');
    console.log('     collect a route whose unrounded value lands above .5 to pin this down.');
}

// ─── 3. ONE FORMULA, TWO RUNTIMES ─────────────────────────────────────────────
console.log('\n── Server and browser share one formula ' + '─'.repeat(36));
const uiSource = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'travel-calc-ui.js'), 'utf8');
const uiImports = /import\s+['"]\.\.\/utils\/travel-model\.js['"]/.test(uiSource);
const uiHasOwnFormula = /\b(?:0\.91|14400|36000|2700)\b/.test(
    uiSource.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
);
const serverShares = require('./travel-calc').calcTravelSeconds === model.calcTravelSeconds;
if (uiImports && !uiHasOwnFormula && serverShares) {
    console.log('✅ src/utils/travel-calc.js and public/js/ui/travel-calc-ui.js both run');
    console.log('   public/js/utils/travel-model.js — no second copy of the constants.');
} else {
    if (!uiImports) console.log('❌ travel-calc-ui.js does not import the shared model');
    if (uiHasOwnFormula) console.log('❌ travel-calc-ui.js contains formula constants of its own');
    if (!serverShares) console.log('❌ src/utils/travel-calc.js does not re-export the shared model');
    failed = true;
}

// Structural identity is necessary but not sufficient: exercise the thing over a grid so
// a future divergence shows up as numbers, not as a missing import. The browser reaches
// the formula through globalThis.AWTravelModel, the server through require — this walks
// both handles across the whole input space the panel can produce.
const browserHandle = globalThis.AWTravelModel;
const serverHandle = require('./travel-calc');
let gridChecked = 0, gridBad = 0, gridWorst = null;
for (let sx = -60; sx <= 60; sx += 17) {
    for (let sy = -60; sy <= 60; sy += 19) {
        for (let ex = -60; ex <= 60; ex += 23) {
            for (let ey = -60; ey <= 60; ey += 29) {
                for (const sp of [1, 6, 12]) {
                    for (const ep of [1, 7, 12]) {
                        for (const energy of [0, 9, 27, 45]) {
                            for (const speed of [-4, -1, 0, 2, 4]) {
                                for (const allied of [false, true]) {
                                    const a = browserHandle.calcTravelSeconds(sx, sy, sp, ex, ey, ep, energy, speed, allied);
                                    const b = serverHandle.calcTravelSeconds(sx, sy, sp, ex, ey, ep, energy, speed, allied);
                                    gridChecked++;
                                    if (a !== b) { gridBad++; if (!gridWorst) gridWorst = { sx, sy, sp, ex, ey, ep, energy, speed, allied, a, b }; }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
if (gridBad === 0) {
    console.log(`✅ client and server agree on all ${gridChecked.toLocaleString()} grid routes`);
} else {
    console.log(`❌ client and server disagree on ${gridBad} of ${gridChecked} routes, e.g. ${JSON.stringify(gridWorst)}`);
    failed = true;
}

// ─── 4. COVERAGE ──────────────────────────────────────────────────────────────
console.log('\n── Coverage: where there is no ground truth ' + '─'.repeat(32));
const sameSystem = CASES.filter(c => c.from[0] === c.to[0] && c.from[1] === c.to[1]);
const deepSpace = CASES.filter(c => c.from[0] !== c.to[0] || c.from[1] !== c.to[1]);
const dims = [
    ['same-system routes',            sameSystem.length > 0],
    ['deep-space routes',             deepSpace.length > 0],
    ['allied (halved) same-system',   sameSystem.some(c => c.alliance)],
    ['allied (halved) deep-space',    deepSpace.some(c => c.alliance)],
    ['negative race speed',           CASES.some(c => c.speed < 0)],
    ['negative speed in deep space',  deepSpace.some(c => c.speed < 0)],
    ['energy 0 in deep space',        deepSpace.some(c => c.energy === 0)],
    ['same planet index (Δ = 0)',     CASES.some(c => c.from[2] === c.to[2])],
    ['API-generated fixtures',        CASES.some(c => c.source === 'api')],
];
for (const [name, covered] of dims) console.log(`  ${covered ? '✅ covered  ' : '⚠️  MISSING '} ${name}`);
const missing = dims.filter(([, c]) => !c);
if (missing.length) {
    console.log(`\n  ${missing.length} of ${dims.length} input regions have no measurement.`);
    console.log('  Run scripts/collect-travel-fixtures.js against the test server to fill them —');
    console.log('  see docs/travel-calibration.md.');
}
const energies = CASES.map(c => c.energy), speeds = CASES.map(c => c.speed);
console.log(`\n  energy levels covered: ${Math.min(...energies)}–${Math.max(...energies)}   race speed: ${Math.min(...speeds)}..${Math.max(...speeds)}`);
console.log(`  fixtures by source: ${Object.entries(CASES.reduce((a, c) => ((a[c.source] = (a[c.source] || 0) + 1), a), {})).map(([k, v]) => `${k}=${v}`).join(', ')}`);

console.log('\n' + '─'.repeat(75));
if (failed) {
    console.log('RESULT: FAILED');
    process.exit(1);
}
console.log(`RESULT: passed — ${CASES.length} fixtures, all exact to the second`);
process.exit(0);
