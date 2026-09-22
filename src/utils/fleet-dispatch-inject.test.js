// public/js/core/fleet-dispatch.js — the suggestions drawn under the game's Fleets table.
//
// Two halves, and the second is the important one.
//
// The first is ordinary parsing: columns are located by header text and the fleet's
// position by the shape of its system link, never by counting cells, because an inserted
// column silently shifted every value the last time a parser in this repo counted.
//
// The second is a rule, not a behaviour: **automating play is forbidden**, and a tool that
// fills the launch form in for you is automating play whatever it is called. That cannot be
// demonstrated by calling a function — it is a statement about everything the file does
// NOT do — so it is asserted by scanning the source. If somebody later adds a "click to
// prefill the target" convenience, these assertions fail and say why.
//
// Run with: node src/utils/fleet-dispatch-inject.test.js

const fs = require('fs');
const path = require('path');
const scrape = require('../../public/js/utils/scrape-report.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('fleet-dispatch-inject.test.js');

const file = path.join(__dirname, '../../public/js/core/fleet-dispatch.js');
const source = fs.readFileSync(file, 'utf8');
// The header explains at length what the file must never do, and would otherwise trip
// every scan below.
const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

function lift(name, bindings = {}) {
    const start = source.indexOf(`export function ${name}(`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Cannot locate ${name}`);
    const body = source.slice(start, end + 2).replace('export function', 'function');
    return new Function(...Object.keys(bindings), `${body}; return ${name};`)(...Object.values(bindings));
}

// The header labels are lifted out of the file too, rather than retyped here: a test that
// declares its own copy of the thing under test would keep passing after somebody changed
// the real one.
function constant(name) {
    const match = source.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
    if (!match) throw new Error(`Cannot locate ${name}`);
    return JSON.parse(match[1].replace(/'/g, '"'));
}
const CV_HEADERS = constant('CV_HEADERS');
const COLONY_HEADERS = constant('COLONY_HEADERS');
ok('the header labels are read from the page\'s real wording', CV_HEADERS.includes('combat value'), CV_HEADERS);

const headerIndexes = lift('headerIndexes', { CV_HEADERS, COLONY_HEADERS });
const readFleetRow = lift('readFleetRow');

// A stand-in for the game's table. The real one has no <thead> — the header row is plain
// <td>s inside <tbody> (checked against the live page), which is why the shared
// AWScrape.headerIndex() cannot be used and this shape is what has to be parsed.
const cell = (text, href) => ({
    innerText: text,
    querySelector: (sel) => (href && /SolarSystem/.test(sel) ? { getAttribute: () => href } : null),
});
const makeRow = (texts, href) => ({
    cells: texts.map(t => cell(t)),
    querySelector: (sel) => (href && sel.includes('SolarSystem') ? { getAttribute: () => href } : null),
});

const LIVE_HEADERS = ['SID', 'Location', 'Transport', 'Colony Ship', 'Destroyer', 'Cruiser', 'Battleship', 'Combat Value', 'Limit 0/5'];

// --- Finding the columns ----------------------------------------------------
{
    const indexes = headerIndexes(makeRow(LIVE_HEADERS), scrape);
    ok('the Combat Value column is found by its header', indexes && indexes.cv === 7, indexes);
    ok('the Colony Ship column is found by its header', indexes && indexes.colony === 3, indexes);

    // The whole point of reading headers: a new column must move the index, not shift the
    // values by one.
    const shifted = headerIndexes(makeRow(['SID', 'NEW', ...LIVE_HEADERS.slice(1)]), scrape);
    ok('an inserted column moves the index instead of shifting every value',
        shifted && shifted.cv === 8 && shifted.colony === 4, shifted);

    ok('a table with no Combat Value header is refused rather than guessed at',
        headerIndexes(makeRow(['SID', 'Location', 'Something else']), scrape) === null);
    ok('no header row at all is refused', headerIndexes(null, scrape) === null);
    ok('without AWScrape loaded it refuses rather than matching labels its own way',
        headerIndexes(makeRow(LIVE_HEADERS), null) === null);
}

// --- Reading a fleet row ----------------------------------------------------
{
    const indexes = headerIndexes(makeRow(LIVE_HEADERS), scrape);
    const row = makeRow(['[70] (-3/12)', 'Aridif #7', '2', '0', '23', '0', '0', '69', 'Launch Loop BC TT'],
        '/Game/Map/SolarSystem/70/7');
    const fleet = readFleetRow(row, indexes);
    ok('the system and planet come from the row\'s own system link, not from its text',
        fleet && fleet.system_id === 70 && fleet.planet_index === 7, fleet);
    ok('the combat value is read from the Combat Value column', fleet.cv === 69, fleet);
    ok('the colony-ship count is read too', fleet.colonyShips === 0, fleet);

    const colonyRow = makeRow(['[40] (-1/8)', 'Minchir #5', '0', '1', '0', '0', '0', '0', 'Launch Loop'],
        '/Game/Map/SolarSystem/40/5');
    const colony = readFleetRow(colonyRow, indexes);
    ok('a colony-ship fleet reads as one colony ship and no combat value',
        colony.colonyShips === 1 && colony.cv === 0, colony);

    ok('a row with no system link is skipped rather than half-read',
        readFleetRow(makeRow(['x', 'y', '0', '0', '0', '0', '0', '5', '']), indexes) === null);
    ok('a planet index outside 1-12 is refused',
        readFleetRow(makeRow(LIVE_HEADERS, '/Game/Map/SolarSystem/70/13'), indexes) === null);
    ok('a system id of zero is refused',
        readFleetRow(makeRow(LIVE_HEADERS, '/Game/Map/SolarSystem/0/4'), indexes) === null);
    ok('a thousands separator in a count does not become a truncated number',
        readFleetRow(makeRow(['[70] (-3/12)', 'Aridif #7', '0', '0', '0', '0', '0', '1,234', ''],
            '/Game/Map/SolarSystem/70/7'), indexes).cv === 1234);
    // The live table ends with a "Sum" row: blank SID, column totals, no system link. It is
    // not a fleet and must not be reported as one that failed to parse.
    const sumRow = makeRow(['', 'Sum', '2', '1', '23', '0', '0', '69', 'Limit: 15.2K CV']);
    ok('the page\'s own Sum footer is not a fleet row', readFleetRow(sumRow, indexes) === null);
    ok('and the injection skips rows with no system link before counting them as failures',
        /filter\(r => r\.querySelector\('a\[href\*="\/Game\/Map\/SolarSystem\/"\]'\)\)/.test(code), null);

    ok('an unreadable count reads as zero rather than NaN',
        readFleetRow(makeRow(['[70]', 'x', '0', '0', '0', '0', '0', '—', ''],
            '/Game/Map/SolarSystem/70/7'), indexes).cv === 0);
}

// --- The rule: this never plays the game -------------------------------------
// Each of these exists because breaking it would turn an informational panel into an
// automation tool, which is forbidden regardless of how convenient it would be.
ok('it never assigns to .value — the launch form is the member\'s to fill in',
    !/\.value\s*=[^=]/.test(code), (code.match(/.{0,40}\.value\s*=[^=].{0,20}/g) || []).slice(0, 3));
ok('it never submits a form', !/\.submit\s*\(/.test(code));
ok('it never clicks anything', !/\.click\s*\(/.test(code));
ok('it never dispatches a synthetic event', !/dispatchEvent|new (Mouse|Keyboard|Pointer)Event/.test(code));
ok('it never sets a selected option or a checkbox',
    !/\.selectedIndex|\.checked\s*=[^=]|setAttribute\(\s*['"](value|checked|selected)['"]/.test(code));
ok('it never navigates on its own', !/location\s*=|location\.(href|assign|replace)\s*[=(]|window\.open/.test(code));
ok('it never posts anything anywhere', !/method\s*:\s*['"]POST|FormData|\.send\s*\(/i.test(code));

// It may read the page's own URL to decide whether it is on the right page — that is not
// navigation, and the next assertion would be meaningless without saying so.
ok('it does read the path, to stay off the launch and loop forms',
    /location\.pathname/.test(code) && /game\/fleets\/launch/.test(code), null);

ok('the one request it makes goes to the hub, not to the game',
    (code.match(/fetch\(/g) || []).length === 1 && /fetch\(`\/hub-api\//.test(code),
    (code.match(/fetch\([^)]{0,50}/g) || []));
ok('and it is a GET — no body, no method override',
    !/fetch\([^)]*\{[^)]*method/.test(code));

// --- What it draws instead ---------------------------------------------------
ok('the injected row is marked with its own class so a redraw can remove it',
    /ROW_CLASS = 'awt-dispatch-row'/.test(source) && /querySelectorAll\(`\.\$\{ROW_CLASS\}`\)/.test(code));
ok('it tells the member the suggestions are theirs to act on',
    /open Launch yourself and pick the destination there/.test(source));
ok('a target with no defender estimate is shown as unknown, never as undefended',
    /no estimate/.test(source) && /not the same as undefended/.test(source));
ok('an away score is labelled with the days behind it, not printed bare',
    /observed days/.test(source));
ok('a table whose rows all fail to parse is reported, not rendered blank',
    /emptyFromNonEmpty/.test(code));

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
