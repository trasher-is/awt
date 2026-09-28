// Synthetic market prices only; no game/account data or network access.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('../../public/js/utils/building-economics.js');
let failed = 0;
function ok(name, condition, detail) {
    console.log(`${condition ? '  ok' : '  NOT OK'} - ${name}${condition || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!condition) failed++;
}
const now = 1790000000000;
const names = { 'Production Point': '$0.80', 'Supply Unit': '$750.00', 'Robotic Factory': '$100.00' };
const quote = E.quoteFromPrices(names, now);

for (const [text, expected] of [['$0.80', 0.8], ['$0,80', 0.8], ['A$ 1,250.75', 1250.75], ['$1.250,75', 1250.75], ['1 250,75', 1250.75], ['1\u202f250.75', 1250.75], ['1,250', 1250], ['750', 750]]) {
    ok(`strict displayed price parses ${JSON.stringify(text)}`, E.parsePrice(text) === expected);
}
for (const text of ['N/A', '', '750/1000', 'now 750', '750 A$ changed', '-750', 'Infinity', '1,2,3', '$0.125', null]) {
    ok(`unrecognized price fails closed: ${JSON.stringify(text)}`, E.parsePrice(text) === null);
}
for (const [text, expected] of [['0', 0], ['1,234', 1234], ['1.234', 1234], ['1\u00a0234', 1234], ['1234', 1234]]) {
    ok(`remaining PP parses integer ${JSON.stringify(text)}`, E.parseRemainingPP(text) === expected);
}
for (const text of ['N/A', '1/1500', '12.5', '-1', '120 PP', '9007199254740992', '1 20', '']) {
    ok(`remaining PP rejects partial/unknown cost ${JSON.stringify(text)}`, E.parseRemainingPP(text) === null);
}

const saving = E.compareUpgrade(1000, 'Robotic Factory', quote, now);
ok('compare remaining PP value with SU purchase minus the building refund', saving.ppValue === 800 && saving.suValue === 650 && saving.saving === 150 && saving.savingPercent === 18.75, saving);
ok('partial funding can make PP cheaper: no full-level cost is substituted', E.compareUpgrade(100, 'Robotic Factory', quote, now) === null);
ok('zero remaining PP cannot recommend SU', E.compareUpgrade(0, 'Robotic Factory', quote, now) === null);
ok('unsupported Starbase never receives SU advice', E.compareUpgrade(100000, 'Starbase', quote, now) === null);
const beforeRefund = E.compareUpgrade(1000, 'Research Lab', quote, now);
ok('missing optional refund uses the gross SU price with an explicit unknown flag', beforeRefund.refund === null && beforeRefund.suValue === 750 && beforeRefund.saving === 50, beforeRefund);
ok('equality after A$ cent rounding is not a saving', E.compareUpgrade(1, 'Research Lab', { ...quote, ppPrice: 750.004 }, now) === null);
ok('one cent of real savings survives rounding', E.compareUpgrade(1, 'Research Lab', { ...quote, ppPrice: 750.01 }, now)?.saving === 0.01);
ok('unsafe monetary arithmetic does not produce a recommendation', E.compareUpgrade(Number.MAX_SAFE_INTEGER, 'Research Lab', quote, now) === null);
for (const patch of [{ capturedAt: now + 1 }, { capturedAt: now - E.MAX_AGE_MS }, { capturedAt: null }, { ppPrice: 0 }, { ppPrice: NaN }, { suPrice: -1 }, { refunds: { 'Robotic Factory': 751 } }, { refunds: { 'Robotic Factory': null } }]) {
    ok(`invalid/stale quote rejected ${JSON.stringify(patch)}`, E.validateQuote({ ...quote, ...patch }, now) === null);
}
ok('a quote is usable until strictly before the expiry boundary', !!E.validateQuote(quote, now + E.MAX_AGE_MS - 1));
ok('missing PP or SU quotes never reuse a prior price', E.quoteFromPrices({ 'Supply Unit': '$750' }, now) === null && E.quoteFromPrices({ 'Production Point': '$0.80' }, now) === null);

const storage = new Map(), events = [];
const context = vm.createContext({
    Date, Event: class { constructor(type) { this.type = type; } },
    dispatchEvent: event => events.push(event.type),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/utils/building-economics.js'), 'utf8'), context);
const cache = context.AWBuildingEconomics;
cache.recordQuote({ ...names, 'Synthetic player': '$99999', 'Astro Dollar': '$99999' }, now);
ok('persistent quote contains only whitelisted market prices and timestamp', !storage.get(E.STORAGE_KEY).includes('Synthetic') && !storage.get(E.STORAGE_KEY).includes('Astro Dollar') && cache.readQuote(now).suPrice === 750);
ok('recording notifies the current document without a storage event', events[0] === E.QUOTE_EVENT);
cache.recordQuote({ 'Supply Unit': '$750' }, now + 1);
ok('new incomplete quote clears the previously useful snapshot', !storage.has(E.STORAGE_KEY) && cache.readQuote(now + 1) === null);
cache.recordQuote(names, now);
ok('future stored timestamp is never treated as recent', cache.readQuote(now - 1) === null);
storage.set(E.STORAGE_KEY, '{broken');
ok('malformed storage fails closed', cache.readQuote(now) === null);
context.localStorage.setItem = () => { throw new Error('Synthetic storage denial'); };
ok('unavailable localStorage cannot break inventory parsing', cache.recordQuote(names, now) === null && cache.readQuote(now) === null);

// Exercise the actual inventory parser's integration with the advisory capture. It
// still returns the original inventory shape and sends no new fields to the server.
const parserSource = fs.readFileSync(path.join(__dirname, '../../public/js/scrapers/trade-inventory-parser.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const recorded = [];
const parserContext = vm.createContext({ console, AWBuildingEconomics: { BUILDINGS: E.BUILDINGS, recordQuote: values => recorded.push(values) } });
vm.runInContext(parserSource, parserContext);
const inventory = { querySelectorAll: () => [{ querySelectorAll: () => [
    { textContent: 'Supply Unit', querySelector: () => null }, { textContent: '0/8' },
] }] };
const tradeDoc = entries => ({ querySelectorAll: selector => selector === 'tr'
    ? entries.map(([name, amount]) => ({ querySelector: selector => selector.startsWith('a[') ? { textContent: name } : amount === null ? null : { textContent: amount } }))
    : [{ textContent: 'Inventory', closest: () => inventory }] });
const result = parserContext.parseTradeInventoryPage(tradeDoc(Object.entries(names)));
ok('zero held SU still captures current prices', result.items.length === 0 && recorded.at(-1)['Supply Unit'] === '$750.00');
ok('inventory output and POST payload remain unchanged', JSON.stringify(Object.keys(result)) === '["hoarded","astroDollars","items"]' && !parserContext.tradeInventorySyncBody(result).includes('Price'));
parserContext.parseTradeInventoryPage(tradeDoc([...Object.entries(names), ['Supply Unit', '$751']]));
ok('duplicate price rows invalidate the snapshot rather than picking arbitrarily', recorded.at(-1)['Supply Unit'] === null && E.quoteFromPrices(recorded.at(-1), now) === null);
parserContext.parseTradeInventoryPage(tradeDoc([...Object.entries(names), ['Research Lab', null]]));
ok('a named refund row with no price is invalid, not an assumed zero refund', recorded.at(-1)['Research Lab'] === null && E.quoteFromPrices(recorded.at(-1), now) === null);
parserContext.parseTradeInventoryPage({ querySelectorAll: () => [] });
ok('an unrecognized Trade page clears previous advice', recorded.at(-1) === null);

if (failed) process.exitCode = 1;
else console.log('All building-economics checks passed');
