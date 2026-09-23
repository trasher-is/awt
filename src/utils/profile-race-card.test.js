// The Race Summary the hub draws on a player's profile when the game is not showing live
// intel (public/js/core/page-injections.js).
//
// It mirrors the game's own grid, and until 2026-09-23 it mirrored only seven of the nine
// picks: Trader and Start Up Lab were missing. That was the other half of the manual intel
// form's missing checkboxes — a member could not enter "this player is a trader", and even
// once they could, the card they were looking at could not show it back, so a correct entry
// would have looked like it had not saved.
//
// Browser module, so the helpers are lifted out of the source the same way
// page-injection-clock.test.js lifts its own.
//
// Run with: node src/utils/profile-race-card.test.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('profile-race-card.test.js');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/core/page-injections.js'), 'utf8');

function lift(name, bindings = {}) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate ${name}`);
    return new Function(...Object.keys(bindings), `${source.slice(start, end + 2)}; return ${name};`)(...Object.values(bindings));
}
function constant(name) {
    const start = source.indexOf(`const ${name} = [`);
    const end = source.indexOf('\n];', start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate ${name}`);
    return new Function(`${source.slice(start, end + 3)}; return ${name};`)();
}

const RACE_TRAITS = constant('RACE_TRAITS');
const RACE_TOGGLES = constant('RACE_TOGGLES');
const raceGridRows = lift('raceGridRows', { RACE_TRAITS, RACE_TOGGLES });
const raceToggleCellKnown = lift('raceToggleCellKnown');

const label = (trait, value) => `${trait.label} ${value == null ? 'X' : value}`;
const flat = (rows) => rows.flat().filter(c => c != null);

// Ikki [ZOD], the profile that prompted this: seven picks summing to -6, balanced by
// Trader's cost of 6. The hub had them all except the one that made the sum work.
const IKKI = {
    race_growth: -3, race_science: -1, race_culture: 0, race_production: 4,
    race_speed: -4, race_attack: -2, race_defense: 0, race_trader: 6, race_sul: 0,
};

console.log('\n-- A taken toggle is drawn, the way the game draws it ' + '-'.repeat(20));
{
    const cells = flat(raceGridRows(IKKI, label, raceToggleCellKnown));
    ok('the trader appears on the card at all', cells.some(c => /Trader/.test(c)), cells);
    ok('it leads the grid, as it does on the game\'s own page', /Trader/.test(cells[0]), cells[0]);
    ok('it prints its cost with a sign and no percentage — there is no rate to derive one from',
        cells[0] === 'Trader +6', cells[0]);
    ok('and the seven traits still follow it', cells.length === 8, cells);

    const bothTaken = flat(raceGridRows({ ...IKKI, race_sul: 1 }, label, raceToggleCellKnown));
    ok('both toggles are drawn when both were taken',
        bothTaken.length === 9 && /Trader/.test(bothTaken[0]) && /Start Up Lab/.test(bothTaken[1]), bothTaken.slice(0, 2));
    ok('Start Up Lab prints its own cost of 1', bothTaken[1] === 'Start Up Lab +1', bothTaken[1]);
}

console.log('\n-- A toggle that was not taken is absent, not shown as zero ' + '-'.repeat(14));
{
    const none = flat(raceGridRows({ ...IKKI, race_trader: 0 }, label, raceToggleCellKnown));
    ok('a player who is not a trader has no Trader cell', !none.some(c => /Trader/.test(c)), none);
    ok('and the card falls back to exactly the seven traits', none.length === 7, none);
    // The game omits an untaken toggle entirely rather than printing "Trader +0", and a 0 on
    // the card would read as a fact the hub does not have.
    ok('no "+0" toggle is ever printed', !none.some(c => /Trader \+0|Start Up Lab \+0/.test(c)), none);
}

console.log('\n-- The grid shape ' + '-'.repeat(56));
{
    const rows = raceGridRows({ ...IKKI, race_trader: 0 }, label, raceToggleCellKnown);
    ok('seven cells make four rows, the last one half empty',
        rows.length === 4 && rows[3][1] === null, rows.map(r => r.length));
    const even = raceGridRows(IKKI, label, raceToggleCellKnown);
    ok('eight cells make four full rows', even.length === 4 && even.every(r => r[1] !== null), even);
    const nine = raceGridRows({ ...IKKI, race_sul: 1 }, label, raceToggleCellKnown);
    ok('nine cells make five rows, the last one half empty', nine.length === 5 && nine[4][1] === null, nine.length);
}

console.log('\n-- Nothing on record ' + '-'.repeat(53));
{
    const unknown = flat(raceGridRows(null, (trait) => `${trait.label}: X`, raceToggleCellKnown));
    ok('the no-intel card still lists every trait as unknown', unknown.length === 7, unknown);
    // "Not taken" and "we have never looked" are indistinguishable on the game's own page,
    // so the card must not invent an unknown row for a toggle either.
    ok('but invents no unknown row for a toggle it cannot know about',
        !unknown.some(c => /Trader|Start Up Lab/.test(c)), unknown);
}

console.log('\n-- The two picks the card draws are the two the form offers ' + '-'.repeat(14));
{
    const formSource = fs.readFileSync(path.join(__dirname, '../../public/js/utils/manual-intel-form.js'), 'utf8');
    for (const toggle of RACE_TOGGLES) {
        ok(`${toggle.field} can be entered as well as displayed`,
            formSource.includes(`field: '${toggle.field}'`), toggle.field);
    }
}

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
