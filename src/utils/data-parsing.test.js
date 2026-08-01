// Tests for the two things that decide whether the numbers in this tool are real:
// the locale-aware parser, and the scraper instrumentation that is supposed to make a
// broken scrape look broken.
//
// Run with:  node src/utils/data-parsing.test.js      (also part of `npm test`)
//
// There is no DOM library in this project and adding one for a handful of assertions is
// not worth it, so the table fixtures below are built from a ~60-line element stub that
// implements only what the helpers actually touch. The logic under test is the column
// addressing and the counting; that is what these fixtures exercise.

const path = require('path');
const N = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'parse-number.js'));
const S = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'scrape-report.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// ─── A MINIMAL ELEMENT STUB ───────────────────────────────────────────────────
class El {
    constructor(tag, text = '', attrs = {}) {
        this.tag = tag.toLowerCase();
        this.innerText = text;
        this.attrs = attrs;
        this.children = [];
        this.parent = null;
        this.className = attrs.class || '';
    }
    add(...kids) {
        for (const k of kids) { k.parent = this; this.children.push(k); }
        return this;
    }
    get descendants() {
        return this.children.flatMap(c => [c, ...c.descendants]);
    }
    get nextElementSibling() {
        if (!this.parent) return null;
        const i = this.parent.children.indexOf(this);
        return this.parent.children[i + 1] || null;
    }
    getAttribute(k) { return this.attrs[k] != null ? String(this.attrs[k]) : null; }
    closest(sel) {
        const tag = sel.toLowerCase();
        let n = this;
        while (n) { if (n.tag === tag) return n; n = n.parent; }
        return null;
    }
    // Supports only the selector shapes the helpers use: "td", "th", "td, th",
    // "thead th, thead td", "tr.head", "table".
    querySelectorAll(sel) {
        const parts = sel.split(',').map(s => s.trim().toLowerCase());
        const all = this.descendants;
        const out = [];
        for (const p of parts) {
            const [scope, target] = p.includes(' ') ? p.split(/\s+/) : [null, p];
            for (const node of all) {
                const [tag, cls] = target.split('.');
                if (tag && node.tag !== tag) continue;
                if (cls && !String(node.className).split(/\s+/).includes(cls)) continue;
                if (scope) {
                    let a = node.parent, inScope = false;
                    while (a) { if (a.tag === scope) { inScope = true; break; } a = a.parent; }
                    if (!inScope) continue;
                }
                if (!out.includes(node)) out.push(node);
            }
        }
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const el = (tag, text, attrs) => new El(tag, text, attrs);
const row = (cells, attrs) => el('tr', '', attrs).add(...cells.map(c => (c instanceof El ? c : el('td', String(c)))));

// ─── 1. THE NUMBER PARSER ─────────────────────────────────────────────────────
console.log('── Locale-aware number parser ' + '─'.repeat(46));

const NBSP = ' ', NNBSP = ' ', THIN = ' ';
const numberCases = [
    ['1,234.5', 1234.5, 'comma thousands, dot decimal'],
    ['1.234,5', 1234.5, 'dot thousands, comma decimal'],
    ['1 234', 1234, 'space thousands'],
    [`1${NBSP}234`, 1234, 'NON-BREAKING space thousands — the one the old regexes dropped'],
    [`1${NNBSP}234,5`, 1234.5, 'narrow NBSP thousands'],
    [`1${THIN}234`, 1234, 'thin space thousands'],
    ['1.234', 1234, 'single dot with three trailing digits is thousands'],
    ['1,234', 1234, 'single comma with three trailing digits is thousands'],
    ['1.5', 1.5, 'single dot, one trailing digit, is a decimal'],
    ['1,5', 1.5, 'single comma, one trailing digit, is a decimal'],
    ['-1,234.5', -1234.5, 'negative'],
    ['-1 234', -1234, 'negative with space thousands'],
    ['+4', 4, 'signed race modifier'],
    ['-4', -4, 'signed race modifier'],
    ['12,345,678', 12345678, 'multiple thousands groups'],
    ['1.234.567', 1234567, 'multiple dot thousands groups'],
    ['999.9', 999.9, 'the value that used to sort above 1,000'],
    ['1,000', 1000, 'the value it used to sort below'],
    ['CV: 40,000', 40000, 'number embedded in text'],
    ['N/A', 0, 'no digits at all'],
    ['', 0, 'empty'],
    [null, 0, 'null'],
    [undefined, 0, 'undefined'],
    [1234.5, 1234.5, 'already a number'],
];
for (const [input, want, why] of numberCases) {
    const got = N.parseLocaleNumber(input);
    ok(`${JSON.stringify(input)} -> ${want}  (${why})`, got === want, got);
}

// The three parsers this replaced, on the inputs where they disagreed.
console.log('\n  the disagreements that motivated this:');
ok('"1.5" is 1.5, not 15 (old cleanInt stripped the dot)', N.parseLocaleNumber('1.5') === 1.5, N.parseLocaleNumber('1.5'));
ok('"1,5" is 1.5, not 15 (old toInt stripped every non-digit)', N.parseLocaleNumber('1,5') === 1.5, N.parseLocaleNumber('1,5'));
ok(`"1${NBSP}234" is 1234, not 0 (old client regex omitted NBSP)`, N.parseLocaleNumber(`1${NBSP}234`) === 1234);

console.log('\n  sorting:');
ok('999.9 sorts below 1,000', N.compareNumeric('999.9', '1,000') === -1);
ok('1.234,5 sorts above 1,000', N.compareNumeric('1.234,5', '1,000') === 1);
ok('equal values compare 0', N.compareNumeric('1 000', '1,000') === 0);
const sorted = ['999.9', '1,000', '1.234,5', '12', '-5'].sort(N.compareNumeric);
ok('a full sort orders correctly', JSON.stringify(sorted) === JSON.stringify(['-5', '12', '999.9', '1,000', '1.234,5']), sorted);

// ─── 2. COLUMN ADDRESSING ─────────────────────────────────────────────────────
console.log('\n── Column addressing survives an inserted column ' + '─'.repeat(27));

const SHIP_SYNONYMS = {
    transports: ['tr', 'transports'],
    colony_ships: ['cs', 'colony ships'],
    destroyers: ['ds', 'destroyers'],
    cruisers: ['cr', 'cruisers'],
    battleships: ['bs', 'battleships'],
};

function fleetTable(headers, values) {
    const thead = el('thead').add(row(headers.map(h => el('th', h))));
    const tbody = el('tbody').add(row(values));
    return el('table').add(thead, tbody);
}

// Today's shape: Owner | TR | CS | DS | CR | BS
const before = fleetTable(['Owner', 'TR', 'CS', 'DS', 'CR', 'BS'], ['Someone', '1', '2', '3', '4', '5']);
// Tomorrow's shape, one column inserted in the middle
const after = fleetTable(['Owner', 'Rank', 'TR', 'CS', 'DS', 'CR', 'BS'], ['Someone', 'IV', '1', '2', '3', '4', '5']);

const readByHeader = (table) => {
    const bodyCells = table.querySelector('tbody').querySelectorAll('td');
    const out = {};
    for (const [key, syn] of Object.entries(SHIP_SYNONYMS)) {
        const idx = S.headerIndex(table, syn);
        out[key] = idx >= 0 ? N.parseLocaleInt(bodyCells[idx].innerText) : null;
    }
    return out;
};
const readByPosition = (table) => {
    const c = table.querySelector('tbody').querySelectorAll('td');
    return { transports: +c[1].innerText, colony_ships: +c[2].innerText, destroyers: +c[3].innerText, cruisers: +c[4].innerText, battleships: +c[5].innerText };
};

const want = { transports: 1, colony_ships: 2, destroyers: 3, cruisers: 4, battleships: 5 };
ok('header addressing is correct today', JSON.stringify(readByHeader(before)) === JSON.stringify(want), readByHeader(before));
ok('header addressing still correct after a column is inserted', JSON.stringify(readByHeader(after)) === JSON.stringify(want), readByHeader(after));
const shifted = readByPosition(after);
ok('positional addressing silently shifts every value (the old bug)',
    JSON.stringify(shifted) !== JSON.stringify(want) && shifted.destroyers === 2, shifted);

// A missing header must be reported, not guessed at.
const headless = el('table').add(el('tbody').add(row(['a', 'b', 'c'])));
ok('a table with no header returns -1 rather than a wrong index', S.headerIndex(headless, ['ds']) === -1);
ok('an unknown header name returns -1', S.headerIndex(before, ['zzz']) === -1);

// ─── 3. LABEL MATCHING ────────────────────────────────────────────────────────
console.log('\n── Label matching ' + '─'.repeat(58));

const profile = el('table').add(el('tbody').add(
    row([el('td', 'Local Time'), el('td', '14:22')]),
    row([el('td', 'Economy Bonus'), el('td', '15%')]),
    row([el('td', 'Economy'), el('td', '7')]),
    row([el('td', 'Astro Dollars'), el('td', `1${NBSP}234${NBSP}567`)]),
));

ok('exact label lookup finds its value', S.labelledValue(profile, S.LABELS.localTime).value === '14:22');
ok('trailing punctuation and case do not matter', S.matchesLabel('LOCAL TIME:', S.LABELS.localTime));
ok('an NBSP inside a label still matches', S.matchesLabel(`Local${NBSP}Time`, S.LABELS.localTime));
const economy = S.labelledValue(profile, S.LABELS.economy, { exact: true, accept: v => !v.includes('%') });
ok('"Economy" does not pick up "Economy Bonus"', economy.value === '7', economy.value);
ok('a missing label reports found=false, not an empty string',
    S.labelledValue(profile, ['nonexistent label']).found === false);
ok('the NBSP-separated value parses to a real number',
    N.parseLocaleInt(S.labelledValue(profile, S.LABELS.astroDollars).value) === 1234567,
    S.labelledValue(profile, S.LABELS.astroDollars).value);

// ─── 4. THE REPORT ────────────────────────────────────────────────────────────
console.log('\n── Scrape reporting ' + '─'.repeat(56));

const good = new S.ScrapeReport('good');
for (let i = 0; i < 5; i++) good.row(true);
good.label(true, 'a'); good.label(true, 'b');
ok('a clean scrape is ok', good.ok === true);
ok('a clean scrape reports its counts', good.summary().includes('5/5 rows'), good.summary());

const empty = new S.ScrapeReport('empty');
for (let i = 0; i < 4; i++) empty.row(false);
ok('zero rows parsed from a non-empty table is NOT ok', empty.ok === false);
ok('and says so in the summary', /NOTHING PARSED/.test(empty.summary()), empty.summary());

const noRows = new S.ScrapeReport('genuinely empty');
ok('a genuinely empty table is fine', noRows.ok === true && noRows.emptyFromNonEmpty === false);

const wrongLang = new S.ScrapeReport('locale');
for (let i = 0; i < 3; i++) wrongLang.row(true);
['a', 'b', 'c', 'd', 'e', 'f'].forEach((k, i) => wrongLang.label(i < 2, k));
ok('mostly-missing labels are flagged as a language problem', wrongLang.likelyWrongLanguage === true);
ok('and that makes the scrape not ok', wrongLang.ok === false);
ok('the message names the likely cause', /English/.test(wrongLang.summary()), wrongLang.summary());

const partialLang = new S.ScrapeReport('partial');
partialLang.row(true);
['a', 'b', 'c', 'd'].forEach((k, i) => partialLang.label(i < 3, k));
ok('one missing label out of four is not a language problem', partialLang.likelyWrongLanguage === false);

const throwing = new S.ScrapeReport('throwing');
throwing.tryRow(() => { throw new Error('boom'); }, 'row 1');
throwing.tryRow(() => true, 'row 2');
ok('a throwing row is counted as skipped, not lost', throwing.rowsSkipped === 1 && throwing.rowsParsed === 1);
ok('and the reason is recorded', throwing.problems.some(p => /boom/.test(p.detail)), throwing.problems);

const repeated = new S.ScrapeReport('repeated');
for (let i = 0; i < 7; i++) repeated.problem('same reason', 'same detail');
ok('repeated problems collapse into one entry with a count',
    repeated.problems.length === 1 && repeated.problems[0].count === 7, repeated.problems);

// ─── 5. THE SCRAPERS THEMSELVES ───────────────────────────────────────────────
// The helpers above are unit-testable; the scrapers are ES modules that only run in a
// browser. What can be checked here is that they no longer contain the shapes this work
// removed — a silent catch, a positional ship read, a hand-rolled number regex. These are
// regression guards: if one comes back, this fails.
console.log('\n── Scraper source guards ' + '─'.repeat(51));

const fs = require('fs');
const SCRAPER_DIRS = [
    path.join(__dirname, '..', '..', 'public', 'js', 'scrapers'),
    path.join(__dirname, '..', '..', 'public', 'js', 'core'),
];
const scraperFiles = SCRAPER_DIRS.flatMap(d =>
    fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.js')).map(f => path.join(d, f)) : []
);

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// public/js/core/spy.js still has one empty catch. It is excluded here rather than fixed
// because that file is the whole subject of the polling-loop issue and belongs to a
// different branch; touching it here would create the merge conflict the split exists to
// avoid. Deleting this entry is part of that work.
const SILENT_CATCH_ALLOWED = {
    'public/js/core/spy.js': 'owned by the spy.js polling-loop branch',
};

const silentCatch = [], allowedCatch = [];
const positionalShips = [];
for (const file of scraperFiles) {
    const rel = path.relative(process.cwd(), file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(code)) {
        (SILENT_CATCH_ALLOWED[rel] ? allowedCatch : silentCatch).push(rel);
    }
    // A ship count read by fixed offset AND stripped with a digits-only regex is the
    // exact shape that shifted silently when a column was inserted.
    if (/\b(?:fTds|tds)\[[1-5]\]\.innerText\.replace\(\/\[\^\\d\]/.test(code)) positionalShips.push(rel);
}
ok('no empty catch blocks left in the scan paths', silentCatch.length === 0, silentCatch);
ok('no hand-rolled positional ship-count parsing left', positionalShips.length === 0, positionalShips);
if (allowedCatch.length) {
    console.log(`  ⚠️  known, accepted: ${allowedCatch.map(f => `${f} [${SILENT_CATCH_ALLOWED[f]}]`).join(', ')}`);
}

// The scrapers that write to the database must be instrumented.
const SYNCING = ['player-parser.js', 'alliance-parser.js', 'mass-scanner.js', 'system-parser.js'];
for (const name of SYNCING) {
    const file = path.join(__dirname, '..', '..', 'public', 'js', 'scrapers', name);
    const src = fs.readFileSync(file, 'utf8');
    ok(`${name} imports the scrape report`, /scrape-report\.js/.test(src));
    ok(`${name} imports the shared number parser`, /parse-number\.js/.test(src));
    ok(`${name} constructs a report`, /new ScrapeReport\(/.test(src));
}

// And nothing on the server should be parsing numbers its own way any more.
const serverNumberOffenders = [];
for (const rel of ['src/utils/interceptors.js', 'src/routes/intel.js', 'src/routes/trade.js']) {
    const code = stripComments(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'));
    if (/replace\(\/\[\^\\d\]\/g|replace\(\/\[,\.\\s\]\/g/.test(code)) serverNumberOffenders.push(rel);
    if (!/parse-number\.js/.test(code)) serverNumberOffenders.push(`${rel} (does not use the shared parser)`);
}
ok('server number parsing goes through the shared module only', serverNumberOffenders.length === 0, serverNumberOffenders);

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
