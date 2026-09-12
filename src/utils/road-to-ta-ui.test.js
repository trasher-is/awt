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
    const calls = [], ranges = [], pending = [];
    const context = vm.createContext({
        Date, console, AbortController, AWSqliteTime, AWTables,
        AWRoadToTA: {
            constants: { DEFAULT_PARTNER_BONUS_RANGES: [[3, 4], [5, 6], [6, 7], [8, 9], [10, 10]] },
            planBonusScenarios(input, bounds) {
                calls.push(input); ranges.push(bounds);
                return { lower: { ok: false, errors: ['Synthetic model boundary'] }, upper: { ok: false } };
            },
        },
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
    return { $, set, calls, ranges, pending, respond, panel, context };
}
function snapshot(id = 1) {
    return { success: true, players: [{ id: 1, name: 'Synthetic One' }, { id: 2, name: 'Synthetic Two' }],
        player: { id, name: `Synthetic ${id}`, has_intel: true, race_growth: 0, race_trader: 0,
            artefact: 'Charcoal Diamond 1', trade_revenue: 0, trade_partners: [], astro_dollars: 0,
            level: 12, social: 10, production_rate: 20, science_rate: 20, culture_rate: 8, total_planets: 1 },
        planets: [{ id: id * 100, name: 'Synthetic Planet', population: 10, farm: 8, factory: 10, lab: 10,
            cybernetics: 8, local_pp: 0, growth_progress: null, is_sieged: false }], market: { pp_price: 1 } };
}

(async () => {
    const state = setup(), { $, set, calls, pending, respond } = state;
    await respond(0, snapshot());
    set('cash', '1234.5');
    state.context.initRoadToTa(state.panel);
    ok('revisiting the mounted tab preserves scenario input without another fetch', $('cash').value === '1234.5' && pending.length === 1);
    ok('embedded view leaves dialog closing and Escape handling to its parent', !$('close') && !state.panel.listeners.keydown);
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
    ok('optional culture uses measured output and complete GC/population coverage', calls.every(input => input.cultureRate === 8 && input.cultureMultiplier === 1));
    ok('initial bonus scenarios use all five absolute TA defaults', JSON.stringify(state.ranges[0]) === '[[3,4],[5,6],[6,7],[8,9],[10,10]]');
    const rangeField = (number, bound) => $('partners').children.find(el => Number(el.dataset.number) === number && el.dataset.bound === bound);
    rangeField(3, 'min').value = '11'; rangeField(3, 'max').value = '12'; $('form').fire('input', rangeField(3, 'min'));
    set('completed', '3');
    ok('nonzero completed count starts at the correct absolute TA range', $('partners').children[0].dataset.number === '4' && $('partners').children[0].value === '8');
    set('completed', '2');
    ok('temporarily hidden ranges retain scenario edits', rangeField(3, 'min').value === '11' && rangeField(3, 'max').value === '12');
    $('form').fire('submit');
    ok('only remaining ranges reach the model after two completed agreements', JSON.stringify(state.ranges.at(-1)) === '[[11,12],[8,9],[10,10]]');
    rangeField(3, 'min').value = '13'; const beforeBounds = calls.length; $('form').fire('submit');
    ok('inverted range never reaches the model', calls.length === beforeBounds && $('results').innerHTML.includes('TA 3:'));
    rangeField(3, 'min').value = ''; $('form').fire('submit');
    ok('blank bonus bound is unknown rather than zero', calls.length === beforeBounds && $('results').innerHTML.includes('whole-number bonus bounds'));
    rangeField(3, 'min').value = '11'; set('completed', '0');

    set('eco-bonus', '0');
    ok('changing economy also invalidates derived growth', $('growth').value === '');
    set('growth', '1.4'); set('trade-bonus', '10');
    ok('an explicitly entered effective multiplier remains the user input', $('growth').value === '1.4');
    set('eco-bonus', '3'); const beforeInvalid = calls.length; $('form').fire('submit');
    ok('invalid economy bonus cannot reach the model even through direct submission', calls.length === beforeInvalid
        && $('results').innerHTML.includes('0% or 5%'));
    set('eco-bonus', '0'); set('trade-bonus', ''); $('form').fire('submit');
    ok('an unknown current trade bonus cannot become zero by adding Eco', calls.length === beforeInvalid && $('results').innerHTML.includes('observed current trade revenue'));


    $('partners').children[0].value = '9'; $('player').value = '2'; $('player').fire('change');
    ok('player switch disables prior snapshot before the response arrives', $('inputs').disabled === true);
    await respond(1, snapshot(2));
    ok('player switch resets partner assumptions and unverified bonuses', $('partners').children[0].value === '3'
        && $('eco-bonus').value === '' && $('growth').value === '');
    $('partners').children[0].value = '7'; $('reload').fire('click'); await respond(2, snapshot(2));
    ok('reload resets future partner assumptions too', $('partners').children[0].value === '3');

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

    const known = setup(), knownData = snapshot();
    knownData.player.trade_partners = [{ name: 'Completed Synthetic Partner' }];
    knownData.future_partners = [{ name: '<img src=x onerror=alert(1)>', population10_planets: 9, observed_at: '2026-09-12 17:00:00' }];
    await known.respond(0, knownData);
    ok('known future partner count seeds a fixed range for the first remaining TA', known.$('partners').children[0].dataset.number === '2'
        && known.$('partners').children[0].value === '9' && known.$('partners').children[1].value === '9');
    ok('known partner source is escaped and identifies observation limits', known.$('partners').innerHTML.includes('&lt;img')
        && !known.$('partners').innerHTML.includes('<img') && known.$('partners').innerHTML.includes('future growth not predicted'));
    ok('unknown next partner retains its absolute-number heuristic', known.$('partners').children[2].value === '6' && known.$('partners').children[3].value === '7');
    known.set('completed', '2');
    ok('increasing the completed count reassigns a known pending partner to the next TA', known.$('partners').children[0].dataset.number === '3' && known.$('partners').children[0].value === '9');
    known.set('completed', '0');
    ok('decreasing the completed count also reassigns the known partner', known.$('partners').children[0].dataset.number === '1' && known.$('partners').children[0].value === '9');
    known.$('partners').children[0].value = '7'; known.$('form').fire('input', known.$('partners').children[0]);
    known.set('completed', '1');
    ok('manual bounds remain tied to an absolute TA while observed candidate defaults move', known.$('partners').children[0].dataset.number === '2' && known.$('partners').children[0].value === '9');
    known.set('completed', '0');
    ok('returning to the edited TA restores its explicit override', known.$('partners').children[0].value === '7' && known.$('partners').children[1].value === '9');

    known.set('eco-bonus', '0'); known.$('use-bio').fire('click'); known.set('culture-rate', ''); known.$('form').fire('submit');
    ok('unknown optional culture is omitted instead of forced to zero', known.calls.length === 3 && known.calls.every(input => !('cultureRate' in input) && !('cultureMultiplier' in input)));
    console.log(`${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
