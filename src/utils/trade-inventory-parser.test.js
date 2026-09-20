// Regression coverage for the /Game/Trade inventory parser behind Hoard A$ / My Savings
// (2026-09-19). public/js/scrapers/trade-inventory-parser.js is a real ES module with no
// side-effect imports, so — same technique as my-planets-parser.test.js — this strips the
// import/export keywords and runs the source in a vm context.
//
// Every mock element below implements textContent (never innerText): a DOMParser result
// used by trade-inventory-watch.js is never rendered, so innerText would silently read as
// empty there — the parser must use textContent to work in both the live-page and
// background-fetch contexts. See the parser's own comment for the full reasoning.
//
// Run with: node src/utils/trade-inventory-parser.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function cell(text, { span } = {}) {
    return {
        textContent: text,
        querySelector: (sel) => (sel === 'span' && span !== undefined ? cell(span) : null),
    };
}

function priceRow({ name, price, noLink = false, noPrice = false }) {
    return {
        querySelector: (sel) => {
            if (sel.startsWith('a[href') ) return noLink ? null : cell(name);
            if (sel === 'td.text-end') return noPrice ? null : cell(price);
            return null;
        },
    };
}

function itemRow(cells) {
    return { querySelectorAll: (sel) => (sel === 'td' ? cells : []) };
}

function table(rows) {
    return { querySelectorAll: (sel) => (sel === 'tbody tr' ? rows : []) };
}

// `invTableFor`: the table the "Inventory" header cell resolves to via closest('table'),
// or null to simulate the header never being found (page didn't parse as expected).
function makeDoc({ priceRows = [], invTableFor = null }) {
    const headerCells = invTableFor
        ? [cell('Something Else', {}), Object.assign(cell('Inventory'), { closest: () => invTableFor })]
        : [cell('Something Else', {})];
    return {
        querySelectorAll: (sel) => {
            if (sel === 'tr') return priceRows;
            if (sel === 'td, th') return headerCells;
            return [];
        },
    };
}

(async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scrapers', 'trade-inventory-parser.js'), 'utf8')
        .replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const context = vm.createContext({ console });
    vm.runInContext(`globalThis.__exports = (function(){ ${source}\nreturn { parseTradeInventoryPage }; })();`, context);
    const { parseTradeInventoryPage } = context.__exports;

    console.log('parseTradeInventoryPage');

    console.log('\n── Artifacts and supply units are valued from the Prices table ' + '─'.repeat(13));
    {
        const inv = table([
            itemRow([cell('Ancient Relic', { span: 'Ancient Relic' }), cell('3')]),
            itemRow([cell('Supply Unit'), cell('2/6')]),
        ]);
        const doc = makeDoc({
            priceRows: [
                priceRow({ name: 'Ancient Relic', price: '100.00' }),
                priceRow({ name: 'Supply Unit', price: '50.00' }),
            ],
            invTableFor: inv,
        });
        const { hoarded } = parseTradeInventoryPage(doc);
        // 3 * 100 (Ancient Relic) + 2 * 50 (Supply Unit, "2/6" -> held 2) = 400
        ok('artifact qty * price + supply-unit held-count * price', hoarded === 400, hoarded);
    }

    console.log('\n── The Astro Dollar row is read exactly, not folded into the hoard ' + '─'.repeat(7));
    {
        const inv = table([
            itemRow([cell('Astro Dollar'), cell('$7,200.27')]),
            itemRow([cell('Ancient Relic'), cell('1')]),
        ]);
        const doc = makeDoc({
            priceRows: [priceRow({ name: 'Ancient Relic', price: '10.00' })],
            invTableFor: inv,
        });
        const result = parseTradeInventoryPage(doc);
        ok('astroDollars reads the exact balance, not abbreviated', result.astroDollars === 7200.27, result);
        ok('the Astro Dollar row itself contributes nothing to the artifact/supply-unit hoard', result.hoarded === 10, result);
    }

    console.log('\n── Rows after "Orders" / "Trade Revenue" stop counting ' + '─'.repeat(21));
    {
        const inv = table([
            itemRow([cell('Ancient Relic'), cell('1')]),
            itemRow([cell('Orders'), cell('')]),
            itemRow([cell('Some Order Row'), cell('9')]),
            itemRow([cell('Trade Revenue'), cell('')]),
            itemRow([cell('Some Revenue Row'), cell('9')]),
        ]);
        const doc = makeDoc({
            priceRows: [priceRow({ name: 'Ancient Relic', price: '10.00' })],
            invTableFor: inv,
        });
        const { hoarded } = parseTradeInventoryPage(doc);
        ok('only the Inventory section is valued, not Orders or Trade Revenue', hoarded === 10, hoarded);
    }

    console.log('\n── Header/qty rows inside Inventory are skipped, not mis-valued ' + '─'.repeat(9));
    {
        const inv = table([
            itemRow([cell('Inventory'), cell('qty')]),
            itemRow([cell('qty'), cell('Astro Dollar')]),
            itemRow([cell('Ancient Relic'), cell('2')]),
        ]);
        const doc = makeDoc({
            priceRows: [priceRow({ name: 'Ancient Relic', price: '25.00' })],
            invTableFor: inv,
        });
        ok('label rows contribute nothing', parseTradeInventoryPage(doc).hoarded === 50, parseTradeInventoryPage(doc));
    }

    console.log('\n── An item with no matching price row values at zero, not NaN ' + '─'.repeat(11));
    {
        const inv = table([itemRow([cell('Mystery Box'), cell('4')])]);
        const doc = makeDoc({ priceRows: [], invTableFor: inv });
        ok('unpriced item contributes 0', parseTradeInventoryPage(doc).hoarded === 0, parseTradeInventoryPage(doc));
    }

    console.log('\n── A row with too few cells is skipped ' + '─'.repeat(30));
    {
        const inv = table([{ querySelectorAll: (sel) => (sel === 'td' ? [cell('No Orders!')] : []) }]);
        const doc = makeDoc({ priceRows: [], invTableFor: inv });
        ok('malformed row produced no crash and no value', parseTradeInventoryPage(doc).hoarded === 0, parseTradeInventoryPage(doc));
    }

    console.log('\n── No Inventory table found returns null, not zero ' + '─'.repeat(19));
    {
        const doc = makeDoc({ priceRows: [], invTableFor: null });
        ok('unparseable page reports null so callers keep the old value', parseTradeInventoryPage(doc) === null, parseTradeInventoryPage(doc));
    }

    console.log('\n' + '─'.repeat(77));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
