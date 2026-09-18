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
    };
}
// `cells`: [sidDataSort, name, populationText, /* progress bar, skipped */ , growthRateText, [productionPp, productionPpDataSort], productionRateText]
function row({ planetId, sid, name, population, growthRate = '+0.0', pp, ppDataSort, productionRate, tooFewCells = false }) {
    const cells = tooFewCells ? [cell('x')] : [
        cell(`[${sid}] (0/0)`, sid),
        cell(name),
        cell(String(population)),
        cell(''), // progress bar cell, not read by the parser
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
            row({ planetId: 18292, sid: '40', name: 'Minchir #5', population: 11, growthRate: '+11.8', pp: 445, ppDataSort: '445', productionRate: '+24.8' }),
        ]));
        ok('one row parsed', rows.length === 1, rows);
        ok('every field captured', rows[0].game_planet_id === 18292 && rows[0].system_id === 40 && rows[0].name === 'Minchir #5'
            && rows[0].population === 11 && rows[0].production_pp === 445 && rows[0].production_rate === 24.8, rows[0]);
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
