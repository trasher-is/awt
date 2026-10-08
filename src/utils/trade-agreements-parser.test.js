// public/js/scrapers/trade-agreements-parser.js — the member's own Existing Agreements table.
// Pinned (2026-10-08): each partner's Status becomes pending / establishing / active, read
// from the column headed "Status", and the partners list the reconciliation relies on is
// unchanged. Layout and wording as seen in game: Name | Planets (Pop >= 10) | Status, rows
// "Request is Pending", "Establishing trade infrastructure", "Active Trading".
//
// Same technique as trade-inventory-parser.test.js: strip import/export, run in a vm.
//
// Run with: node src/utils/trade-agreements-parser.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('trade-agreements-parser.test.js');

const cell = (text, { th = false, link = false } = {}) => ({
    tag: th ? 'th' : 'td', innerText: text,
    querySelector: (sel) => (link && sel.includes('/Game/Players/Profile/') ? { innerText: text.replace(/\s*\[.*\]$/, '') } : null),
});
const row = (cells) => ({
    cells,
    querySelectorAll: () => cells,
    querySelector: (sel) => (sel === 'th' ? cells.find(c => c.tag === 'th') || null : null),
});
function table(rows) {
    const title = row([cell('Existing Agreements', { th: true })]);
    return {
        querySelector: (sel) => (sel === 'thead th, thead td' ? title.cells[0] : null),
        querySelectorAll: (sel) => (sel === 'tr' ? [title, ...rows] : []),
    };
}

async function run(tbl) {
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/scrapers/trade-agreements-parser.js'), 'utf8')
        .replace(/^export /gm, '');
    const posted = [];
    const ctx = {
        console: { log() {}, error: console.error },
        document: { querySelectorAll: () => [tbl] },
        fetch: async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return {}; },
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\n;globalThis.__scrape = scrapeTradeAgreements; globalThis.__state = offerState;', ctx);
    await ctx.__scrape();
    return { posted, offerState: ctx.__state };
}

(async () => {
    const labels = row([cell('Name'), cell('Planets (Pop >= 10)'), cell('Status')]);
    const partner = (name, pct, status) => row([cell(`${name} [RAID]`, { link: true }), cell(pct), cell(status)]);
    const { posted, offerState } = await run(table([
        labels,
        partner('Moardin25', '11%', 'Active Trading'),
        partner('BaldWithABeard', '10%', 'Request is Pending'),
        partner('Harpyie', '10%', 'Establishing trade infrastructure'),
        row([cell('Trade Revenue Avg: 10.75%, Sum: 43%')]),
    ]));
    const body = posted[0] && posted[0].body;
    ok('posts to the sync route', posted.length === 1 && posted[0].url === '/hub-api/sync/trade-agreements');
    ok('partners list unchanged: names only, footer and label rows skipped',
        JSON.stringify(body.partners) === JSON.stringify(['Moardin25', 'BaldWithABeard', 'Harpyie']), body.partners);
    ok('each row carries its state', JSON.stringify(body.rows) === JSON.stringify([
        { name: 'Moardin25', state: 'active' }, { name: 'BaldWithABeard', state: 'pending' }, { name: 'Harpyie', state: 'establishing' },
    ]), body.rows);
    ok('unknown wording is no state, not a guess', offerState('Something new') === null);

    // Status column found by its header, not by position.
    const moved = await run(table([
        row([cell('Name'), cell('Status'), cell('Planets (Pop >= 10)')]),
        row([cell('Bob', { link: true }), cell('Request is Pending'), cell('9%')]),
    ]));
    ok('a moved Status column is still read', moved.posted[0].body.rows[0].state === 'pending', moved.posted[0].body.rows);

    console.log(failed === 0 ? 'All checks passed' : `${failed} check(s) failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
