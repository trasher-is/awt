// Live intel vs. a pasted copy, and how far behind recorded sciences are.
//
// The bug (2026-09-27): a pinned Player Note holding an old intel report — a real
// <table class="ir-summary"> inside the notes list's `.overflow-auto` container — was read by
// player-parser.js as a live capture on every scrape. The note's sciences were written over
// the record and intel_updated_at was stamped "now", so a player nobody could see looked
// freshly scouted. page-injections.js already ignored such tables; the scraper did not.
//
// Everything here is synthetic — no captured page, per AGENTS.md. Same vm harness as
// player-origin-parser.test.js, because player-parser.js is browser-only ESM.
//
// Run with: node src/utils/intel-freshness.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { isGenuineLiveIntelTable, genuineLiveIntelTables, scienceLag } =
    require('../../public/js/utils/intel-freshness.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('intel-freshness.test.js');

// ── Synthetic DOM ────────────────────────────────────────────────────────────────────────
// Just enough of the DOM for extractPlayerData: label cells with a nextElementSibling,
// tables that answer closest() from a declared ancestor list, and a document whose
// querySelectorAll returns cells in DOCUMENT ORDER — which is what makes "note first" a
// real test of scoping rather than of luck.
function labelRows(rows) {
    return rows.flatMap(([label, text]) => {
        const key = { innerText: label, querySelector: () => null };
        const value = { innerText: text, querySelector: () => null };
        key.nextElementSibling = value;
        return [key, value];
    });
}
function table(kind, rows, { inNote = false } = {}) {
    const cells = kind === 'race'
        ? rows.map(([trait, v]) => ({ innerText: `${trait} ${v}`, querySelector: () => null }))
        : labelRows(rows);
    return {
        kind, cells,
        closest: sel => (sel === '.overflow-auto' && inNote ? {} : null),
        querySelectorAll: sel => (sel === 'td, th' || sel === 'tbody td' ? cells : []),
    };
}
function irTable(sciences, opts) {
    return table('ir', [
        ['Biology', String(sciences[0])], ['Economy', String(sciences[1])], ['Energy', String(sciences[2])],
        ['Mathematics', String(sciences[3])], ['Physics', String(sciences[4])], ['Social', String(sciences[5])],
        ['Trade Revenue', '+12%'], ['Artefact', 'N/A'],
    ], opts);
}
function raceTable(traits, opts) {
    const names = ['Growth', 'Science', 'Culture', 'Production', 'Speed', 'Attack', 'Defence'];
    return table('race', names.map((n, i) => [n, (traits[i] >= 0 ? '+' : '') + traits[i]]), opts);
}
// `tables` in document order; the public part of the profile always comes first.
function profile(tables) {
    const base = labelRows([
        ['Local Time', '12:34'], ['Idle', '1h'], ['Joined', '2026-01-01'], ['Logins', '125'],
        ['Player Level', '5'], ['Science Level', '18'], ['Culture Level', '10'], ['Ranking', '#4 (1 234)'],
    ]);
    const header = { innerText: 'Synthetic navigator', querySelector: () => null };
    const doc = {
        // Like a real document, querySelector is the first querySelectorAll match — so the
        // old document-wide `querySelector('table.ir-summary')` finds the note, as it did live.
        querySelector: sel => (sel === 'th[colspan="2"]' ? header : doc.querySelectorAll(sel)[0] || null),
        querySelectorAll(sel) {
            if (sel === 'td, th') return [...base, ...tables.flatMap(t => t.cells)];
            if (sel === 'table.ir-summary') return tables.filter(t => t.kind === 'ir');
            if (sel === '.race-summary') return tables.filter(t => t.kind === 'race');
            return [];
        },
    };
    return doc;
}

const context = vm.createContext({
    console,
    AWScrape: require('../../public/js/utils/scrape-report'),
    AWNumber: require('../../public/js/utils/parse-number'),
    AWIdleParse: require('../../public/js/utils/idle-parse'),
    AWIntelFreshness: require('../../public/js/utils/intel-freshness'),
    AWGameRate: {},
});
const code = fs.readFileSync(path.join(__dirname, '../../public/js/scrapers/player-parser.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
vm.runInContext(code, context);
function extract(doc) {
    context.syntheticProfile = doc;
    return vm.runInContext('extractPlayerData(701, syntheticProfile)', context);
}

// ── The shared rule ──────────────────────────────────────────────────────────────────────
console.log('\n── Which tables are live ' + '─'.repeat(51));
ok('a table outside .overflow-auto is the game\'s own',
    isGenuineLiveIntelTable(irTable([1, 1, 1, 1, 1, 1])) === true);
ok('a table inside .overflow-auto (a pinned note) is not',
    isGenuineLiveIntelTable(irTable([1, 1, 1, 1, 1, 1], { inNote: true })) === false);
ok('genuineLiveIntelTables drops the note copy and keeps the live one',
    genuineLiveIntelTables(profile([irTable([3, 3, 3, 3, 3, 3], { inNote: true }), irTable([9, 9, 9, 9, 9, 9])]),
        'table.ir-summary').length === 1);
ok('a missing root yields no tables rather than throwing', genuineLiveIntelTables(null, '.ir-summary').length === 0);

// ── The scraper ──────────────────────────────────────────────────────────────────────────
console.log('\n── Scraping a profile whose only intel is a pasted note ' + '─'.repeat(19));
{
    const p = extract(profile([
        irTable([1, 5, 3, 2, 1, 2], { inNote: true }),
        raceTable([-3, 3, 1, 2, 3, -3, -3], { inNote: true }),
    ]));
    ok('has_intel is 0 — the note is not a capture, so the upsert keeps the record and its date',
        p.has_intel === 0, p.has_intel);
    ok('the note\'s Social is not read', p.social !== 2, p.social);
}

console.log('\n── Live intel with an older note ABOVE it ' + '─'.repeat(33));
{
    const p = extract(profile([
        irTable([1, 5, 3, 2, 1, 2], { inNote: true }),
        raceTable([0, 0, 0, 0, 0, 0, 0], { inNote: true }),
        irTable([17, 11, 13, 8, 9, 18]),
        raceTable([-3, 3, 1, 2, 3, -3, -3]),
    ]));
    ok('has_intel is 1', p.has_intel === 1, p.has_intel);
    ok('sciences come from the live table, not the first match in the document',
        [p.biology, p.economy, p.energy, p.mathematics, p.physics, p.social].join() === '17,11,13,8,9,18',
        [p.biology, p.economy, p.energy, p.mathematics, p.physics, p.social]);
    ok('trade revenue comes from the live table', p.trade_revenue === 12, p.trade_revenue);
    ok('race comes from the live table',
        [p.race_growth, p.race_science, p.race_speed, p.race_attack, p.race_defense].join() === '-3,3,3,-3,-3',
        [p.race_growth, p.race_science, p.race_speed, p.race_attack, p.race_defense]);
}

console.log('\n── Live intel, no note ' + '─'.repeat(53));
{
    const p = extract(profile([irTable([13, 8, 11, 12, 10, 15]), raceTable([-1, -2, -3, 4, -4, 4, 2])]));
    ok('has_intel is 1 and Social is read', p.has_intel === 1 && p.social === 15, [p.has_intel, p.social]);
}

// ── Science lag ──────────────────────────────────────────────────────────────────────────
// The public science level is the player's highest science, always current.
console.log('\n── scienceLag ' + '─'.repeat(62));
const row = (science_level, sciences, extra = {}) => ({
    has_intel: 1, science_level,
    biology: sciences[0], economy: sciences[1], energy: sciences[2],
    mathematics: sciences[3], physics: sciences[4], social: sciences[5], ...extra,
});
ok('current record: highest science equals the public level -> 0', scienceLag(row(19, [15, 5, 11, 13, 9, 19])) === 0);
ok('the note case: public 18, highest on record 5 -> 13 behind', scienceLag(row(18, [1, 5, 3, 2, 1, 2])) === 13);
ok('a record two levels behind -> 2', scienceLag(row(17, [15, 6, 11, 13, 9, 12])) === 2);
ok('public level never synced (0) -> unknown, not "current"', scienceLag(row(0, [12, 6, 9, 11, 10, 13])) === null);
ok('no intel -> unknown', scienceLag(row(18, [0, 0, 0, 0, 0, 0], { has_intel: 0 })) === null);
ok('a missing science -> unknown', scienceLag(row(18, [1, 2, 3, 4, 5, undefined])) === null);
ok('public level below the record (manual entry ahead of a lagging sync) -> 0, not negative',
    scienceLag(row(4, [8, 2, 2, 2, 2, 2])) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
