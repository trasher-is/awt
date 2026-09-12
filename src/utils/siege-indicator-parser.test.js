// Regression coverage for the DOM siege-classification parser extracted (2026-09-12b) out
// of system-parser.js — the game marks a besieged planet row `tr.siege` (hostile) or
// `tr.friendly-siege` (ours or an ally's) and names the besieger in the
// `.aw-hub-indicator`'s title attribute. Standalone and import-free, same reasoning as
// ranking-page-parser.js's own extraction: system-parser.js has several relative imports of
// its own, but this piece of DOM shape knowledge doesn't need any of them.
//
// public/js/utils/siege-indicator-parser.js is a real ES module (DOM-only, never used
// server-side), so this test dynamically imports it and feeds it minimal hand-built
// DOM-shaped objects rather than a full jsdom.
//
// Run with: node src/utils/siege-indicator-parser.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function row({ classes = [], indicatorTitle = null }) {
    const classSet = new Set(classes);
    const indicator = indicatorTitle !== null
        ? { getAttribute: (n) => (n === 'title' ? indicatorTitle : null) }
        : null;
    return {
        classList: { contains: (c) => classSet.has(c) },
        querySelector: (sel) => (sel === '.aw-hub-indicator' ? indicator : null),
    };
}

(async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'siege-indicator-parser.js'), 'utf8');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-siege-indicator-'));
    const tmpFile = path.join(tmp, 'siege-indicator-parser.mjs');
    fs.writeFileSync(tmpFile, src);
    const { parseSiegeIndicator } = await import(pathToFileURL(tmpFile).href);

    console.log('parseSiegeIndicator');

    console.log('\n── No siege at all ' + '─'.repeat(58));
    {
        const r = parseSiegeIndicator(row({ classes: [] }));
        ok('is_sieged is 0', r.is_sieged === 0, r);
        ok('siege_is_friendly is null (nothing to report)', r.siege_is_friendly === null, r);
        ok('siege_attacker_name is null', r.siege_attacker_name === null, r);
    }

    console.log('\n── Enemy siege, real production example (Phact #41 planet 4) ' + '─'.repeat(15));
    {
        const r = parseSiegeIndicator(row({ classes: ['siege'], indicatorTitle: 'Enemy Siege by GustavusSecondus' }));
        ok('is_sieged is 1', r.is_sieged === 1, r);
        ok('siege_is_friendly is false', r.siege_is_friendly === false, r);
        ok('attacker name captured exactly', r.siege_attacker_name === 'GustavusSecondus', r);
    }

    console.log('\n── Friendly (allied) siege of a Free planet, with an Intel Note suffix ' + '─'.repeat(6));
    {
        const r = parseSiegeIndicator(row({ classes: ['friendly-siege'], indicatorTitle: 'Allied Siege by Tatankamon | Intel Note: Moardin25 (moardin25)' }));
        ok('is_sieged is 1', r.is_sieged === 1, r);
        ok('siege_is_friendly is true', r.siege_is_friendly === true, r);
        ok('attacker name stops at the Intel Note separator', r.siege_attacker_name === 'Tatankamon', r);
    }

    console.log('\n── Enemy siege of a Free planet with an anonymized attacker ' + '─'.repeat(17));
    {
        const r = parseSiegeIndicator(row({ classes: ['siege'], indicatorTitle: 'Enemy Siege by Enemy' }));
        ok('is_sieged is 1', r.is_sieged === 1, r);
        ok('siege_is_friendly is false', r.siege_is_friendly === false, r);
        ok('attacker name is whatever the game itself shows, even a placeholder', r.siege_attacker_name === 'Enemy', r);
    }

    console.log('\n── Sieged but no indicator element found (defensive) ' + '─'.repeat(24));
    {
        const r = parseSiegeIndicator(row({ classes: ['siege'], indicatorTitle: null }));
        ok('is_sieged still reflects the row class', r.is_sieged === 1, r);
        ok('siege_is_friendly still reflects the row class', r.siege_is_friendly === false, r);
        ok('attacker name is null without a title to parse', r.siege_attacker_name === null, r);
    }

    console.log('\n' + '─'.repeat(77));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
