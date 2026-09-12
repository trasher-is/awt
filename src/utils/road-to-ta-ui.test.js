// Exercise actual Road to TA listeners with synthetic fields and delayed responses.
// The model is a recording boundary here; its numerical behavior has its own suite.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '../..');
const AWSqliteTime = require('../../public/js/utils/sqlite-time.js');
const AWTables = require('../../public/js/utils/game-tables.js');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const attributes = markup => Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
class Field {
    constructor(attrs = {}) {
        this.dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5), value]));
        this.type = attrs.type || '';
        this.value = attrs.value || '';
        this.children = [];
        this.listeners = {};
        this.classList = { contains: () => true, replace() {} };
    }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    set innerHTML(markup) {
        this.markup = markup;
        this.children = [...markup.matchAll(/<input\b([^>]*)>/g)].map(match => new Field(attributes(match[1])));
    }
    get innerHTML() { return this.markup || ''; }
    replaceChildren(...children) { this.children = children; this.markup = ''; }
    querySelectorAll(selector) { return selector === 'input' ? this.children.filter(child => child.type) : []; }
    querySelector(selector) {
        const match = /^\[data-field="([^"]+)"\]$/.exec(selector);
        return match ? this.children.find(child => child.dataset.field === match[1]) : null;
    }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    fire(type, target = this) { for (const handler of this.listeners[type] || []) handler({ target, preventDefault() {} }); }
    reportValidity() { return true; }
    focus() {}
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
    const fields = new Map();
    const template = fs.readFileSync(path.join(ROOT, 'public/components/road-to-ta.html'), 'utf8');
    for (const match of template.matchAll(/<[^>]+\bid="(rta-[^"]+)"[^>]*>/g)) fields.set(match[1], new Field(attributes(match[0])));
    const $ = id => fields.get('rta-' + id);
    const panel = new Field();
    panel.querySelector = selector => fields.get(selector.slice(1));
    const calls = [], pending = [];
    const context = vm.createContext({
        Date, console, AbortController, AWSqliteTime, AWTables,
        AWRoadToTA: { plan(input) { calls.push(input); return { ok: false, errors: ['Synthetic model boundary'] }; } },
        document: { createElement: () => new Field(), getElementById: () => new Field() },
        fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); },
    });
    for (const file of ['public/js/utils/escape.js', 'public/js/ui/road-to-ta.js']) {
        const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
        vm.runInContext(code, context, { filename: file });
    }
    context.initRoadToTa(panel);
    function set(id, value) { $(id).value = value; $('form').fire('input', $(id)); }
    async function respond(index, data, status = 200) {
        pending[index].resolve({ ok: status === 200, json: async () => data });
        await flush();
    }
    return { $, set, calls, pending, respond, panel, context };
}
function snapshot(id = 1) {
    return { success: true, players: [{ id: 1, name: 'Synthetic One' }, { id: 2, name: 'Synthetic Two' }],
        player: { id, name: `Synthetic ${id}`, has_intel: true, race_growth: 0, race_trader: 0,
            artefact: 'Charcoal Diamond 1', trade_revenue: 0, trade_partners: [], astro_dollars: 0,
            level: 12, social: 10, production_rate: 20, science_rate: 20, total_planets: 1 },
        planets: [{ id: id * 100, name: 'Synthetic Planet', population: 10, farm: 8, factory: 10, lab: 10,
            cybernetics: 8, local_pp: 0, growth_progress: null, is_sieged: false }], market: { pp_price: 1 } };
}

(async () => {
    const state = setup(), { $, set, calls, pending, respond } = state;
    await respond(0, snapshot());
    ok('loading bio does not guess the separate economy bonus or effective growth', $('eco-bonus').value === '' && $('growth').value === '');
    $('use-bio').fire('click');
    ok('bio calculation requires an explicit economy bonus', $('growth').value === '' && $('results').innerHTML.includes('explicit trade and economy bonuses'));
    set('eco-bonus', '0'); $('use-bio').fire('click');
    ok('confirmed neutral growth with explicit zero bonuses gives multiplier one', $('growth').value === '1');
    set('trade-bonus', '20');
    ok('changing trade invalidates a bio-derived growth multiplier', $('growth').value === '');
    set('eco-bonus', '5'); $('use-bio').fire('click');
    ok('trade 20 plus separate economy 5 gives growth 1.25', $('growth').value === '1.25');
    $('form').fire('submit');
    ok('all strategy inputs receive the combined current bonus once', calls.length === 3
        && calls.every(input => input.currentTradeBonusPct === 25 && input.growthMultiplier === 1.25));
    ok('automatic output multipliers use the supplied complete planet totals', calls.every(input => input.productionMultiplier === 1 && input.scienceMultiplier === 1));
    set('eco-bonus', '0');
    ok('changing economy also invalidates derived growth', $('growth').value === '');
    set('growth', '1.4'); set('trade-bonus', '10');
    ok('an explicitly entered effective multiplier remains the user input', $('growth').value === '1.4');
    set('eco-bonus', '3'); const beforeInvalid = calls.length; $('form').fire('submit');
    ok('invalid economy bonus cannot reach the model even through direct submission', calls.length === beforeInvalid
        && $('results').innerHTML.includes('0% or 5%'));

    $('partners').children[0].value = '9'; $('player').value = '2'; $('player').fire('change');
    ok('player switch disables prior snapshot before the response arrives', $('inputs').disabled === true);
    await respond(1, snapshot(2));
    ok('player switch resets partner assumptions and unverified bonuses', $('partners').children[0].value === '0'
        && $('eco-bonus').value === '' && $('growth').value === '');
    $('partners').children[0].value = '7'; $('reload').fire('click'); await respond(2, snapshot(2));
    ok('reload resets future partner assumptions too', $('partners').children[0].value === '0');

    $('player').value = '1'; $('player').fire('change');
    $('player').value = '2'; $('player').fire('change');
    ok('new selection aborts the prior request', pending[3].options.signal.aborted === true);
    await respond(4, snapshot(2)); await respond(3, snapshot(1));
    ok('a late response cannot overwrite the current selected player', $('player').value === '2' && $('status').textContent.includes('Synthetic 2'));
    $('reload').fire('click'); await respond(5, { success: false, error: 'Synthetic failure' }, 500);
    const beforeFailure = calls.length; $('form').fire('submit');
    ok('failed reload cannot calculate from stale data', $('inputs').disabled === true && calls.length === beforeFailure
        && $('status').textContent.includes('Synthetic failure'));
    state.context.initRoadToTa(state.panel);
    ok('reinitializing a mounted panel does not duplicate requests/listeners', pending.length === 6);
    console.log(`${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
