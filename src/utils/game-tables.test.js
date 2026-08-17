// game-tables.js must agree with docs/game-rules.md, value for value.
//
// Run with:  node src/utils/game-tables.test.js
//
// This suite re-parses the markdown tables out of the doc and compares them to the JS. That
// direction matters: the doc is ground truth (AGENTS.md), so a mismatch means the JS is
// wrong, never the doc. Do not "fix" a failure by editing docs/game-rules.md — re-check the
// table in game, the same rule that applies to battle-fixtures.json.
//
// It exists because public/js/ui/build-order.js used to hold its own truncated copies of
// these tables and nothing could tell that they had drifted.

const path = require('path');
const fs = require('fs');
const T = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-tables.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'game-rules.md'), 'utf8');

// ── the doc parser, deliberately written from scratch rather than shared with the ─────────
// generator: if both sides used one parser, a parser bug would agree with itself.
function sectionLines(title) {
    const lines = doc.split('\n');
    const start = lines.findIndex(l => /^#{2,3}\s/.test(l) && l.replace(/^#{2,3}\s+/, '').trim() === title);
    if (start === -1) throw new Error(`section not found in docs/game-rules.md: ${title}`);
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^#{2,3}\s/.test(lines[i])) break;
        out.push(lines[i]);
    }
    return out;
}

const cell = s => {
    const t = String(s).replace(/[,$%+]/g, '').trim();
    if (t === '') return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
};

function tableRows(title) {
    return sectionLines(title)
        .map(l => l.trim())
        .filter(l => l.startsWith('|') && !/^\|[\s:|-]+\|$/.test(l))
        .map(l => l.slice(1, -1).split('|').map(c => c.trim()))
        .filter(cells => cell(cells[0]) !== null);
}

// Compare a "level in column 0, cost in column `col`" doc table against a dense JS array
// where index === level.
function checkLevelTable(label, title, col, arr) {
    const rows = tableRows(title);
    let mismatch = null, covered = 0;
    for (const cells of rows) {
        const lvl = cell(cells[0]);
        const want = cell(cells[col]);
        if (arr[lvl] !== want) { mismatch = { level: lvl, doc: want, js: arr[lvl] }; break; }
        covered++;
    }
    ok(`${label}: all ${rows.length} rows match the doc`, mismatch === null, mismatch);
    ok(`${label}: JS has no levels the doc does not (${arr.length - 1} vs ${rows.length})`,
        arr.length - 1 === rows.length, { js: arr.length - 1, doc: rows.length });
    return covered;
}

(async () => {
    console.log('── Every table is the doc\'s table ' + '─'.repeat(46));
    checkLevelTable('BUILDING', 'Buildings', 1, T.BUILDING);
    checkLevelTable('POP_GROWTH', 'Population growth', 1, T.POP_GROWTH);
    checkLevelTable('CULTURE', 'Culture growth', 1, T.CULTURE);
    checkLevelTable('SCIENCE', 'Science', 1, T.SCIENCE);
    checkLevelTable('PLAYER_LEVEL', 'Player level', 1, T.PLAYER_LEVEL);

    // Social starts at level 0, so index === level with no placeholder.
    const socialRows = tableRows('Social (population cap)');
    ok('SOCIAL_CAP matches the doc row for row',
        socialRows.every(c => T.SOCIAL_CAP[cell(c[0])] === cell(c[1])) &&
        T.SOCIAL_CAP.length === socialRows.length,
        { js: T.SOCIAL_CAP.length, doc: socialRows.length });
    ok('social 0 already allows population 5 (level 0 is a real row, not a placeholder)',
        T.SOCIAL_CAP[0] === 5);

    console.log('');
    console.log('── Aggregated columns confirm the per-level costs ' + '─'.repeat(31));
    // The doc prints a running total beside each cost. Summing our per-level values must
    // reproduce it, which catches an off-by-one that a row-by-row check would not.
    const checkAggregate = (label, title, arr) => {
        let bad = null;
        for (const cells of tableRows(title)) {
            const lvl = cell(cells[0]);
            const want = cell(cells[2]);
            if (want === null) continue;
            const got = T.aggregate(arr, 0, lvl);
            if (got !== want) { bad = { level: lvl, doc: want, summed: got }; break; }
        }
        ok(`${label}: aggregate(0, n) equals the doc's running total at every level`, bad === null, bad);
    };
    checkAggregate('BUILDING', 'Buildings', T.BUILDING);
    checkAggregate('POP_GROWTH', 'Population growth', T.POP_GROWTH);
    checkAggregate('CULTURE', 'Culture growth', T.CULTURE);
    checkAggregate('SCIENCE', 'Science', T.SCIENCE);

    console.log('');
    console.log('── Ship cost is the formula, not a lookup ' + '─'.repeat(38));
    const econRows = tableRows('Economy (ship costs)');
    ok('there are 30 published economy breakpoints', econRows.length === 30, econRows.length);
    let econBad = null;
    for (const cells of econRows) {
        const [lvl, d, c, b] = cells.map(cell);
        if (T.destroyerCost(lvl) !== d || T.cruiserCost(lvl) !== c || T.battleshipCost(lvl) !== b) {
            econBad = { level: lvl, doc: [d, c, b], js: [T.destroyerCost(lvl), T.cruiserCost(lvl), T.battleshipCost(lvl)] };
            break;
        }
    }
    ok('destroyer/cruiser/battleship cost matches all 30 rows', econBad === null, econBad);
    ok('economy 98-100 stay at the level-97 price and never reach 0',
        T.destroyerCost(97) === 1 && T.destroyerCost(100) === 1);
    ok('cruiser is 8x and battleship 20x the destroyer at every level',
        [0, 17, 50, 84, 97, 100].every(l =>
            T.cruiserCost(l) === T.destroyerCost(l) * 8 && T.battleshipCost(l) === T.destroyerCost(l) * 20));

    console.log('');
    console.log('── Starbase levels cost the same as buildings ' + '─'.repeat(34));
    // Why there is no separate starbase cost table. The doc's Costs column is abbreviated
    // ("11.1K") past level 19, so only the exact rows are compared.
    let sbBad = null;
    for (const cells of tableRows('Starbase')) {
        const lvl = cell(cells[0]);
        const cost = cell(cells[4]);
        if (cost === null) continue;                     // 11.1K etc — not a plain number
        if (T.BUILDING[lvl] !== cost) { sbBad = { level: lvl, starbase: cost, building: T.BUILDING[lvl] }; break; }
    }
    ok('every exactly-printed starbase cost equals the building cost for that level',
        sbBad === null, sbBad);

    console.log('');
    console.log('── Artifacts ' + '─'.repeat(67));
    const artRows = tableRows('Artifacts');
    ok('all 21 artifacts are present', T.ARTIFACTS.length === 21 && artRows.length === 21,
        { js: T.ARTIFACTS.length, doc: artRows.length });
    ok('bonuses are stored as fractions, not percentages',
        T.ARTIFACTS.every(a => [a.growth, a.science, a.culture, a.production]
            .every(v => v === 0 || v === 0.1 || v === 0.2 || v === 0.3)));
    const mj3 = T.ARTIFACTS.find(a => a.name === 'Memory Jar 3');
    ok('Memory Jar 3 is +30% science and production, nothing else, at player level 20',
        mj3 && mj3.science === 0.3 && mj3.production === 0.3 &&
        mj3.growth === 0 && mj3.culture === 0 && mj3.playerLevel === 20, mj3);

    console.log('');
    console.log('── Colony ship disbanding, including the 2-ship trap ' + '─'.repeat(27));
    ok('1 colony ship gives a planet nothing', T.colonyStartingPP(1) === 0);
    ok('2 colony ships still give nothing — the single extra does not disband',
        T.colonyStartingPP(2) === 0);
    ok('3 give 30 PP', T.colonyStartingPP(3) === 30);
    ok('4 give 45 PP', T.colonyStartingPP(4) === 45);
    ok('10 give 135 PP', T.colonyStartingPP(10) === 135);
    ok('a colony ship costs a flat 60 PP, unscaled by economy', T.CIVIL_SHIP_PP === 60);

    console.log('');
    console.log('── Population cap clamps rather than returning undefined ' + '─'.repeat(23));
    ok('social 10 caps population at 10', T.popCap(10) === 10);
    ok('social 25 caps population at 25', T.popCap(25) === 25);
    ok('past the published table it clamps to the last row, not undefined', T.popCap(40) === 25);
    ok('a negative social level is treated as 0', T.popCap(-3) === 5);

    console.log('');
    console.log(`${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
