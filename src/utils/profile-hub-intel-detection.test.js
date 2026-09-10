// Whether the profile page's fallback "Hub Intel" card should render (issue: a pinned
// Player Note's expanded body can contain a real .race-summary/.ir-summary table — a
// member pasting an old intel snapshot into a note — which a naive document-wide
// selector mistakes for the game's own CURRENT live intel display and wrongly suppresses
// the fallback card. Confirmed live against player 144: a note titled "IR" by an alliance
// member contained <table class="table ir-summary mb-0">, nested inside the notes list's
// `.overflow-auto` scroll container, with no genuine live intel anywhere else on the page.
//
// Run with:  node src/utils/profile-hub-intel-detection.test.js
//
// page-injections.js is browser-only ESM touching the live DOM, so isGenuineLiveIntelTable
// is lifted out of the source text and evaluated here against fake elements — same
// extraction discipline as profile-buildings-card.test.js, for the same reason.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'core', 'page-injections.js'), 'utf8');

console.log('── Lifting isGenuineLiveIntelTable out of page-injections.js ' + '─'.repeat(14));
const fnStart = src.indexOf('function isGenuineLiveIntelTable(el) {');
const fnEnd = src.indexOf('\n}\n', fnStart);
ok('isGenuineLiveIntelTable is where the test expects it', fnStart !== -1 && fnEnd !== -1);

const isGenuineLiveIntelTable = new Function(`${src.slice(fnStart, fnEnd + 2)}\nreturn isGenuineLiveIntelTable;`)();
ok('the lifted function is callable', typeof isGenuineLiveIntelTable === 'function');

// A minimal fake element: .closest(selector) walks a manually-built ancestor chain,
// same shape real elements give it — no jsdom in this repo (see route-airports-ui.test.js).
function fakeEl(ancestorClasses) {
    return {
        closest(selector) {
            const wanted = selector.replace(/^\./, '');
            return ancestorClasses.includes(wanted) ? {} : null;
        },
    };
}

console.log('\n── Real cases ' + '─'.repeat(62));
ok('a table with no .overflow-auto ancestor (the game\'s own top-of-page intel) counts as live',
    isGenuineLiveIntelTable(fakeEl([])) === true);
ok('a table nested inside .overflow-auto (a pinned note\'s expanded body, e.g. player 144\'s "IR" note) does not count',
    isGenuineLiveIntelTable(fakeEl(['overflow-auto'])) === false);
ok('an unrelated ancestor class does not suppress a genuine top-of-page table',
    isGenuineLiveIntelTable(fakeEl(['col-lg-6', 'row'])) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
