// Regression coverage for the ranking-page parser extracted (2026-09-12) out of
// bonus-goals-sync.js so the Various Changes Best Planets watcher (best-planets-watch.js)
// uses the exact same "leading rank + /Game/Map/Planet/{id} link" parsing logic, instead of
// a second copy that could drift.
//
// public/js/utils/ranking-page-parser.js is a real ES module (no dual Node/browser
// wrapper — it's DOM-only, never used server-side), so this test dynamically imports it
// and feeds it minimal hand-built DOM-shaped objects rather than a full jsdom.
//
// Run with: node src/utils/ranking-page-parser.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function link(href, text) {
    return { getAttribute: (n) => (n === 'href' ? href : null), textContent: text || '' };
}
function cell(text) {
    return { textContent: text };
}
function row({ rankText, planetHref, ownerText, ownerHref, tagText, tagHref, noCells = false }) {
    const cells = noCells ? [] : [cell(rankText)];
    const links = [];
    if (planetHref) links.push({ selector: 'a[href^="/Game/Map/Planet/"]', el: link(planetHref) });
    if (ownerHref) links.push({ selector: 'a[href*="/Game/Players/Profile/"]', el: link(ownerHref, ownerText) });
    if (tagHref) links.push({ selector: 'a[href*="/Game/Alliance/Profile/"]', el: link(tagHref, tagText) });
    return {
        querySelectorAll: (sel) => (sel === 'td' ? cells : []),
        querySelector: (sel) => (links.find(l => l.selector === sel) || {}).el || null,
    };
}
function doc(rows) {
    return { querySelectorAll: (sel) => (sel === 'table tr' ? rows : []) };
}

(async () => {
    // package.json says "type": "commonjs", so a plain .js ES module has to be copied to a
    // temp .mjs before dynamic import() will treat it as one — same trick as
    // column-prefs.test.js's loadEsm.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'ranking-page-parser.js'), 'utf8');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-ranking-parser-'));
    const tmpFile = path.join(tmp, 'ranking-page-parser.mjs');
    fs.writeFileSync(tmpFile, src);
    const { parseRankingPage } = await import(pathToFileURL(tmpFile).href);

    console.log('parseRankingPage');

    console.log('\n── A well-formed row parses fully ' + '─'.repeat(42));
    {
        const rows = parseRankingPage(doc([
            row({ rankText: '1', planetHref: '/Game/Map/Planet/555', ownerText: 'Someone', ownerHref: '/Game/Players/Profile/9', tagText: 'RAID', tagHref: '/Game/Alliance/Profile/3' }),
        ]));
        ok('one row parsed', rows.length === 1, rows);
        ok('rank, planet id, owner name and tag all captured',
            rows[0].rank === 1 && rows[0].game_planet_id === 555 && rows[0].owner_name === 'Someone' && rows[0].owner_alliance_tag === 'RAID', rows[0]);
    }

    console.log('\n── Rows missing required pieces are dropped, not half-parsed ' + '─'.repeat(9));
    {
        const rows = parseRankingPage(doc([
            row({ noCells: true, planetHref: '/Game/Map/Planet/1' }), // no cells at all
            row({ rankText: 'not a number', planetHref: '/Game/Map/Planet/2' }), // unparseable rank
            row({ rankText: '0', planetHref: '/Game/Map/Planet/3' }), // rank must be > 0
            row({ rankText: '5' }), // no planet link at all
            row({ rankText: '6', planetHref: '/Game/Map/Planet/not-a-number' }), // unparseable planet id
        ]));
        ok('none of the malformed rows produced an entry', rows.length === 0, rows);
    }

    console.log('\n── Owner/tag are optional — the row still scores without them ' + '─'.repeat(8));
    {
        const rows = parseRankingPage(doc([row({ rankText: '2', planetHref: '/Game/Map/Planet/777' })]));
        ok('row parses with rank + planet id only', rows.length === 1 && rows[0].rank === 2 && rows[0].game_planet_id === 777, rows);
        ok('owner_name is null when no profile link exists', rows[0].owner_name === null, rows[0]);
        ok('owner_alliance_tag is null when no alliance link exists', rows[0].owner_alliance_tag === null, rows[0]);
    }

    console.log('\n── An empty page parses to an empty array ' + '─'.repeat(35));
    ok('no rows at all', parseRankingPage(doc([])).length === 0);

    console.log('\n' + '─'.repeat(77));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
