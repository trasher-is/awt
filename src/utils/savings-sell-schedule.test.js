// How "willing to sell anytime" (My Savings) feeds the Trade Agreement Schedule and My
// Savings' own Ready in. archives.js is browser-only ESM, so the three functions are lifted
// out of its source and evaluated here — same extraction discipline as
// profile-hub-intel-detection.test.js. The server side (storage, capping, sellable_au) is
// covered by src/routes/savings-sell-picks.test.js.
//
// Run with: node src/utils/savings-sell-schedule.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'archives.js'), 'utf8');
function lift(name) {
    const start = src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', start);
    if (start === -1 || end === -1) throw new Error(`${name} not found in archives.js`);
    return src.slice(start, end + 2);
}
const TA_TRADE_COST = 20000;
const { scheduleMembers, sellQty, sellableAu, boardReadiness } = new Function('TA_TRADE_COST',
    `${lift('scheduleMembers')}\n${lift('sellQty')}\n${lift('sellableAu')}\n${lift('boardReadiness')}\nreturn { scheduleMembers, sellQty, sellableAu, boardReadiness };`)(TA_TRADE_COST);

console.log('savings-sell-schedule.test.js');

console.log('\n── Schedule: what each member has on hand ' + '─'.repeat(34));
const inputs = {
    me: 'alice', traders: [],
    econ: {
        pp_price: 10,
        players: [
            { name: 'Alice', astro_dollars: 1000, production_points: 100, hoarded_au: 20000, sellable_au: 3900 },
            { name: 'Bob', astro_dollars: 500, production_points: 0, hoarded_au: 8000, sellable_au: 0 },
            { name: 'Carol', astro_dollars: 9000, production_points: 0, hoarded_au: 0, sellable_au: 0, reserved_au: 1200 },
        ],
    },
};
{
    const off = scheduleMembers(inputs, false).members;
    ok('toggle off: saved = A$ + PP x price + what they would sell anyway',
        off[0].saved === 1000 + 1000 + 3900 && off[1].saved === 500, off.map(m => m.saved));
    const on = scheduleMembers(inputs, true).members;
    ok('toggle on: the whole stockpile replaces the picks, never both',
        on[0].saved === 1000 + 1000 + 20000 && on[1].saved === 500 + 8000, on.map(m => m.saved));
    ok('every member\'s planned expenses are held back, not only the viewer\'s (Carol is not "me")',
        off[2].saved === 9000 - 1200 && on[2].saved === 9000 - 1200, off[2]);
    const oldServer = scheduleMembers({ ...inputs, econ: { ...inputs.econ, players: [{ name: 'Alice', astro_dollars: 1000, production_points: 0, hoarded_au: 5 }] } }, false).members;
    ok('a payload without sellable_au (server not yet updated) counts nothing extra', oldServer[0].saved === 1000, oldServer);
}

console.log('\n── My Savings: the value of the picks ' + '─'.repeat(38));
const items = [
    { name: 'Memory Jar', held: 3, unit_price: 7100, picked: true, qty: 2 },
    { name: 'Supply Unit', held: 6, unit_price: 650, picked: true, qty: null },
    { name: 'Holy Grail', held: 1, unit_price: 50000, picked: false, qty: null },
    { name: 'Ancient Relic', held: 1, unit_price: 100, picked: true, qty: 5 },
];
ok('"all" (qty null) is everything held', sellQty(items[1]) === 6);
ok('a pick above what is held is capped', sellQty(items[3]) === 1);
ok('the total counts picked items only, at min(pick, held) x price',
    sellableAu(items) === 2 * 7100 + 6 * 650 + 100, sellableAu(items));
ok('nothing picked -> 0', sellableAu(items.map(i => ({ ...i, picked: false }))) === 0);

console.log('\n── Board: Ready in / Ready (sold) from each member\'s My Savings ' + '─'.repeat(13));
{
    const r = boardReadiness({ visible_au: 9000, sellable_au: 3900, hoarded_au: 20000, reserved_au: 1200, au_per_h: 200, rate_estimated: false });
    ok('Ready in needs 20k + expenses - (A$+PP + willing to sell)', r.need === 20000 + 1200 - 9000 - 3900, r);
    ok('Ready (sold) swaps in the whole hoard, never hoard + picks', r.needSold === 20000 + 1200 - 9000 - 20000, r);
    ok('the server\'s banking-based rate is used as is', r.auPerH === 200 && r.estimated === false, r);
    const bare = boardReadiness({ visible_au: 5000, hoarded_au: 0, au_per_h: 300, rate_estimated: true });
    ok('a member with no My Savings setup: plain 20k - A$+PP, flagged estimated', bare.need === 15000 && bare.estimated === true, bare);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
