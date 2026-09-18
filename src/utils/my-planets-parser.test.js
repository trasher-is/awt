// Regression coverage for the /Game/Planets parser behind My Savings (2026-09-18).
//
// public/js/utils/my-planets-parser.js is a real ES module with a side-effect import
// (parse-number.js), so — same technique as road-to-ta-ui.test.js — this strips the
// import/export keywords and runs the source in a vm context that already has the real
// parse-number.js module (required normally; it's dual CommonJS/browser) pre-bound as
// globalThis.AWNumber, rather than hand-rolling a second number parser for the test.
//
// Run with: node src/utils/my-planets-parser.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const AWNumber = require('../../public/js/utils/parse-number.js');

function cell(text, dataSort) {
    return {
        textContent: text,
        getAttribute: (n) => (n === 'data-sort' ? (dataSort === undefined ? null : dataSort) : null),
        querySelector: () => null,
    };
}
// The real cell nests a `.progress-text` child with "104/1,191" text; `progressText`
// undefined means no such child at all (an empty/unstarted progress bar, seen in practice).
function progressCell(progressText) {
    return { querySelector: (sel) => (sel === '.progress-text' && progressText !== undefined ? cell(progressText) : null) };
}
// `cells`: [sidDataSort, name, populationText, progress-bar, growthRateText, [productionPp, productionPpDataSort], productionRateText]
function row({ planetId, sid, name, population, progressText, growthRate = '+0.0', pp, ppDataSort, productionRate, tooFewCells = false }) {
    const cells = tooFewCells ? [cell('x')] : [
        cell(`[${sid}] (0/0)`, sid),
        cell(name),
        cell(String(population)),
        progressCell(progressText),
        cell(growthRate),
        cell(String(pp), ppDataSort),
        cell(productionRate),
    ];
    return {
        getAttribute: (n) => (n === 'data-planet-id' ? (planetId === undefined ? null : String(planetId)) : null),
        querySelectorAll: (sel) => (sel === 'td' ? cells : []),
    };
}
function doc(rows) {
    return { querySelectorAll: (sel) => (sel === 'tr[data-planet-id]' ? rows : []) };
}

(async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'my-planets-parser.js'), 'utf8')
        .replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const context = vm.createContext({ AWNumber, console });
    vm.runInContext(`globalThis.__exports = (function(){ ${source}\nreturn { parseMyPlanetsPage }; })();`, context);
    const { parseMyPlanetsPage } = context.__exports;

    console.log('parseMyPlanetsPage');

    console.log('\n── A well-formed row parses fully ' + '─'.repeat(42));
    {
        const rows = parseMyPlanetsPage(doc([
            row({ planetId: 18292, sid: '40', name: 'Minchir #5', population: 11, progressText: '104/1,191', growthRate: '+11.8', pp: 445, ppDataSort: '445', productionRate: '+24.8' }),
        ]));
        ok('one row parsed', rows.length === 1, rows);
        ok('every field captured', rows[0].game_planet_id === 18292 && rows[0].system_id === 40 && rows[0].name === 'Minchir #5'
            && rows[0].population === 11 && rows[0].production_pp === 445 && rows[0].production_rate === 24.8
            && rows[0].population_progress === 104 && rows[0].growth_rate === 11.8, rows[0]);
    }

    console.log('\n── A planet with no progress bar yet reports unknown progress ' + '─'.repeat(9));
    {
        const rows = parseMyPlanetsPage(doc([
            row({ planetId: 3, sid: '5', name: 'A', population: 1, growthRate: '', pp: 0, productionRate: '+0' }), // progressText and growthRate left empty
        ]));
        ok('population_progress is null, not zero, when the page has no progress child', rows[0].population_progress === null, rows[0]);
        ok('growth_rate is null, not zero, for an empty rate cell', rows[0].growth_rate === null, rows[0]);
    }

    console.log('\n── Production reads from data-sort when present, text otherwise ' + '─'.repeat(6));
    {
        const rows = parseMyPlanetsPage(doc([
            row({ planetId: 1, sid: '5', name: 'A', population: 3, pp: '1,234', productionRate: '+2.5' }), // no ppDataSort — falls back to cell text
        ]));
        ok('falls back to the cell\'s own text when data-sort is absent, through the shared locale parser', rows[0].production_pp === 1234, rows[0]);
    }

    console.log('\n── A row with too few cells is dropped, not half-parsed ' + '─'.repeat(14));
    {
        const rows = parseMyPlanetsPage(doc([row({ planetId: 2, tooFewCells: true })]));
        ok('malformed row produced no entry', rows.length === 0, rows);
    }

    console.log('\n── A row with no planet id is dropped ' + '─'.repeat(31));
    {
        const rows = parseMyPlanetsPage(doc([row({ planetId: undefined, sid: '5', name: 'A', population: 1, pp: 1, productionRate: '+1' })]));
        ok('unparseable planet id produced no entry', rows.length === 0, rows);
    }

    console.log('\n── An empty page parses to an empty array ' + '─'.repeat(35));
    ok('no rows at all', parseMyPlanetsPage(doc([])).length === 0);

    console.log('\n' + '─'.repeat(77));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
