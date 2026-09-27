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
// The rule now lives in intel-freshness.js, shared with player-parser.js — the scraper kept a
// document-wide selector after this card was fixed, and read the same note as a fresh capture
// (see intel-freshness.test.js). The source checks below keep both files on the one rule.

const fs = require('fs');
const path = require('path');
const { isGenuineLiveIntelTable } = require('../../public/js/utils/intel-freshness.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

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

console.log('── Real cases ' + '─'.repeat(62));
ok('a table with no .overflow-auto ancestor (the game\'s own top-of-page intel) counts as live',
    isGenuineLiveIntelTable(fakeEl([])) === true);
ok('a table nested inside .overflow-auto (a pinned note\'s expanded body, e.g. player 144\'s "IR" note) does not count',
    isGenuineLiveIntelTable(fakeEl(['overflow-auto'])) === false);
ok('an unrelated ancestor class does not suppress a genuine top-of-page table',
    isGenuineLiveIntelTable(fakeEl(['col-lg-6', 'row'])) === true);

console.log('\n── One rule, both consumers ' + '─'.repeat(48));
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = rel => stripComments(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'));
const injections = read('public/js/core/page-injections.js');
const parser = read('public/js/scrapers/player-parser.js');
ok('page-injections.js decides live intel through genuineLiveIntelTables',
    /genuineLiveIntelTables\(document, '\.race-summary, \.ir-summary'\)/.test(injections));
ok('page-injections.js no longer carries its own copy of the rule',
    !/function isGenuineLiveIntelTable/.test(injections));
ok('player-parser.js decides has_intel through genuineLiveIntelTables',
    /genuineLiveIntelTables\(doc, 'table\.ir-summary'\)/.test(parser));
ok('player-parser.js has no document-wide .ir-summary / .race-summary lookup left',
    !/doc\.querySelector(All)?\(['"][^'"]*(ir|race)-summary/.test(parser));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
