// Exercise the real calculator listeners and archive opener with synthetic DOM/imports.
// Deferred initialization must finish before a picked flight can replace the empty form.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uiFile = name => path.join(__dirname, '../../public/js/ui', name);
const componentFile = name => path.join(__dirname, '../../public/components', name);
const source = name => fs.readFileSync(uiFile(name), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
    .replace(/\bimport\(/g, 'testImport(');
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));

function element(attributes = {}) {
    const classes = new Set((attributes.class || '').split(/\s+/));
    const listeners = new Map();
    let html = '';
    const node = {
        attributes, value: attributes.value || '', checked: false, disabled: false,
        dataset: {}, buttons: [],
        get validity() {
            const n = Number(node.value);
            const min = attributes.min === undefined ? -Infinity : Number(attributes.min);
            const max = attributes.max === undefined ? Infinity : Number(attributes.max);
            return { valid: node.value === '' || (Number.isFinite(n) && n >= min && n <= max && Number.isInteger(n)) };
        },
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value;
            node.buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(match => {
                const a = attrs(match[1]);
                const button = element(a);
                button.dataset = Object.fromEntries(Object.entries(a).filter(([key]) => key.startsWith('data-'))
                    .map(([key, data]) => [key.slice(5), data]));
                return button;
            });
        },
        get textContent() { return html.replace(/<[^>]*>/g, ''); },
        set textContent(value) { html = value; node.buttons = []; },
        classList: {
            add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
            replace(from, to) { if (!classes.delete(from)) return false; classes.add(to); return true; }
        },
        querySelectorAll(selector) { return node.buttons.filter(button => button.classList.contains(selector.slice(1))); },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        async fire(name) {
            await Promise.all((listeners.get(name) || []).map(callback => callback({ currentTarget: node, preventDefault() {} })));
        }
    };
    return node;
}

function calculator() {
    const elements = new Map([...fs.readFileSync(componentFile('travel-calc.html'), 'utf8')
        .matchAll(/<\w+\b([^>]*\bid="[^"]+"[^>]*)>/g)].map(match => {
        const a = attrs(match[1]);
        return [a.id, element(a)];
    }));
    const get = id => elements.get(id) || null;
    const state = { opens: [], imports: [], fetches: [], importFailure: null, openFailure: null, openWait: null };
    const timers = new Map();
    let timerId = 0;
    const systems = [
        { id: 41, name: 'Synthetic origin', x: 1, y: 2 },
        { id: 72, name: 'Synthetic target', x: 8, y: 9 }
    ];
    const context = vm.createContext({
        console, Date, esc: value => String(value),
        AWTravelModel: require('../../public/js/utils/travel-model'),
        AWBattleModel: { cvOf: () => 0 },
        AWApi: { getTravelTime: async () => { throw new Error('Unexpected game API call'); } },
        document: {
            getElementById: get,
            querySelectorAll: selector => selector === '#travel-calc-panel .tc-in'
                ? [...elements.values()].filter(node => node.classList.contains('tc-in')) : []
        }, window: {},
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        async fetch(url) {
            state.fetches.push(url);
            if (url === '/hub-api/intel/systems_db') return { json: async () => ({ success: true, systems }) };
            if (url.startsWith('/hub-api/intel/system/')) return { json: async () => ({ success: true, planets: [], fleets: [] }) };
            throw new Error('Unexpected request ' + url);
        },
        async testImport(file) {
            state.imports.push(file);
            if (state.importFailure) throw state.importFailure;
            if (file !== './archives.js') throw new Error('Unexpected import ' + file);
            return { async openRoutePlannerPanel(options) {
                state.opens.push(options);
                if (state.openFailure) throw state.openFailure;
                if (state.openWait) await state.openWait.promise;
            } };
        }
    });
    vm.runInContext(source('travel-calc-ui.js'), context);
    vm.runInContext('initTravelCalc()', context);
    async function pick(end, id) {
        get(`tc-${end}-sys-input`).value = String(id);
        await get(`tc-${end}-sys-input`).fire('input');
        const button = get(`tc-${end}-sys-dropdown`).buttons.find(b => b.dataset.id === String(id));
        if (!button) throw new Error('Synthetic picker did not render ' + id);
        await button.fire('mousedown');
    }
    return { get, state, timers, pick, run: code => vm.runInContext(code, context) };
}

function archive() {
    const elements = new Map([
        ['travel-calc-panel', element({ class: 'translate-x-0' })],
        ['sidebar', element({ class: 'expanded' })]
    ]);
    const get = id => elements.get(id) || null;
    const state = { fetches: [], imports: [], inserts: 0, initCalls: 0, drafts: [], savedCalls: 0, sidebarCalls: 0 };
    const initWait = deferred(), draftWait = deferred(), savedWait = deferred();
    const container = element();
    container.insertAdjacentHTML = (position, html) => {
        if (position !== 'beforeend' || !html.includes('id="route-planner-panel"')) throw new Error('Invalid panel insertion');
        state.inserts++;
        const panel = element({ class: 'translate-x-full' });
        panel.remove = () => elements.delete('route-planner-panel');
        elements.set('route-planner-panel', panel);
    };
    elements.set('dynamic-panels-container', container);
    const context = vm.createContext({
        console, Date,
        document: { getElementById: get },
        window: { toggleSidebar() { state.sidebarCalls++; get('sidebar').classList.remove('expanded'); } },
        AWGameRate: {}, AWBattleModel: {}, AWSqliteTime: {},
        fetch(url) {
            const pending = deferred();
            state.fetches.push({ url, ...pending });
            return pending.promise;
        },
        async testImport(file) {
            state.imports.push(file);
            if (state.importFailure) throw state.importFailure;
            if (file !== './route-planner.js') throw new Error('Unexpected import ' + file);
            return {
                async initRoutePlanner() { state.initCalls++; await initWait.promise; },
                async loadRouteDraft(draft) { state.drafts.push(draft); await draftWait.promise; },
                async showSavedRoutes() { state.savedCalls++; await savedWait.promise; }
            };
        }
    });
    vm.runInContext(source('archives.js'), context);
    function respond(ok = true) {
        state.fetches.at(-1).resolve({ ok, text: async () => fs.readFileSync(componentFile('route-planner.html'), 'utf8') });
    }
    return { get, state, initWait, draftWait, savedWait, respond, run: code => vm.runInContext(code, context) };
}

async function main() {
    console.log('travel-route-link.test.js');
    const h = calculator();
    ok('raw coordinates keep Plan this flight disabled with a system-pick explanation', h.get('tc-plan-route').disabled
        && h.get('tc-route-message').textContent.includes('Pick origin and destination systems'));
    await h.get('tc-plan-route').fire('click');
    ok('missing system ids never import or open the planner even on direct activation', h.state.imports.length === 0 && h.state.opens.length === 0);
    await h.pick('orig', 41);
    ok('one picked endpoint is insufficient for a route draft', h.get('tc-plan-route').disabled);
    await h.pick('dest', 72);
    ok('two real picker selections enable the route handoff', !h.get('tc-plan-route').disabled
        && h.get('tc-orig-x').value === '1' && h.get('tc-dest-y').value === '9');
    h.get('tc-orig-p').value = '4';
    h.get('tc-dest-p').value = '12';
    h.get('tc-energy').value = '17';
    h.get('tc-speed').value = '-2';
    h.get('tc-alliance').checked = true;
    h.state.openWait = deferred();
    let opened = false;
    const open = h.get('tc-plan-route').fire('click').then(() => { opened = true; });
    await flush();
    ok('handoff transfers picked ids, planets, labels and fleet parameters exactly', same(h.state.opens[0], { draft: {
        waypoints: [{ systemId: 41, planetIndex: 4, label: 'Synthetic origin #41' },
            { systemId: 72, planetIndex: 12, label: 'Synthetic target #72' }],
        energy: 17, raceSpeed: -2, isAllianceMove: true
    } }), h.state.opens[0]);
    ok('the button stays busy until the planner has accepted the draft', !opened && h.get('tc-plan-route').disabled);
    ok('handoff cancels the pending game-time debounce', h.timers.size === 0);
    h.state.openWait.resolve();
    await open;
    ok('the completed handoff releases its button', opened && !h.get('tc-plan-route').disabled);
    h.state.openWait = null;

    for (const [id, value] of [['tc-orig-p', '0'], ['tc-dest-p', '13'], ['tc-orig-p', '1.5'], ['tc-energy', '-1'], ['tc-speed', '5'], ['tc-speed', ''], ['tc-energy', '']]) {
        const previous = h.get(id).value;
        const before = h.state.opens.length;
        h.get(id).value = value;
        await h.get('tc-plan-route').fire('click');
        ok(`invalid ${id}=${JSON.stringify(value)} does not open a plan`, h.state.opens.length === before
            && h.get('tc-route-message').textContent.includes('Enter valid'));
        h.get(id).value = previous;
    }

    for (const [field, end, id] of [['tc-orig-x', 'orig', 41], ['tc-orig-y', 'orig', 41], ['tc-dest-x', 'dest', 72], ['tc-dest-y', 'dest', 72],
        ['tc-orig-sys-input', 'orig', 41], ['tc-dest-sys-input', 'dest', 72]]) {
        h.get(field).value = field.endsWith('input') ? 'edited system text' : '99';
        const editing = h.get(field).fire('input');
        ok(`editing ${field} immediately invalidates the old picked id`, h.get('tc-plan-route').disabled);
        await editing;
        const before = h.state.opens.length;
        await h.get('tc-plan-route').fire('click');
        ok(`editing ${field} cannot hand off the old location`, h.state.opens.length === before);
        await h.pick(end, id);
    }

    h.get('tc-orig-p').value = '';
    h.get('tc-orig-x').value = '99';
    await h.get('tc-orig-x').fire('input');
    await h.get('tc-saved-routes').fire('click');
    ok('saved routes opens independently of invalid flight inputs and sends no draft', same(h.state.opens.at(-1), { showSaved: true })
        && !h.get('tc-saved-routes').disabled);

    h.state.importFailure = new Error('Synthetic module load failed');
    await h.get('tc-saved-routes').fire('click');
    ok('dynamic import failure is shown and the saved-route button permits retry', h.get('tc-route-message').textContent === 'Synthetic module load failed'
        && !h.get('tc-saved-routes').disabled);
    h.state.importFailure = null;
    h.state.openFailure = new Error('Synthetic planner initialization failed');
    await h.get('tc-saved-routes').fire('click');
    ok('planner-open rejection reaches the calculator status message', h.get('tc-route-message').textContent === 'Synthetic planner initialization failed');

    const a = archive();
    const first = a.run('openRoutePlannerPanel()');
    const draft = { waypoints: [{ systemId: 41, planetIndex: 4 }, { systemId: 72, planetIndex: 12 }], energy: 17, raceSpeed: -2 };
    let handedOff = false;
    const second = a.run(`openRoutePlannerPanel({ draft: ${JSON.stringify(draft)} })`).then(() => { handedOff = true; });
    ok('overlapping sidebar and calculator opens fetch the component only once', a.state.fetches.length === 1
        && a.state.fetches[0].url === '/hub-assets/components/route-planner.html');
    a.respond();
    await flush();
    ok('a pending initializer runs once and cannot receive the draft prematurely', a.state.inserts === 1 && a.state.initCalls === 1
        && a.state.drafts.length === 0 && !handedOff);
    a.initWait.resolve();
    await first;
    await flush();
    ok('the draft arrives only after initialization, without a second panel insertion', same(a.state.drafts, [draft]) && a.state.inserts === 1);
    ok('opening awaits asynchronous draft loading too', !handedOff);
    a.draftWait.resolve();
    await second;
    ok('the accepted flight leaves the planner open and closes the calculator', handedOff
        && a.get('route-planner-panel').classList.contains('translate-x-0')
        && a.get('travel-calc-panel').classList.contains('translate-x-full') && a.state.sidebarCalls === 1);
    let savedOpened = false;
    const saved = a.run('openRoutePlannerPanel({ showSaved: true })').then(() => { savedOpened = true; });
    await flush();
    ok('saved-routes link refreshes an already-open planner without toggling it shut or loading a draft', a.state.savedCalls === 1
        && a.state.drafts.length === 1 && a.state.initCalls === 1 && a.state.fetches.length === 1
        && a.get('route-planner-panel').classList.contains('translate-x-0') && !savedOpened);
    a.savedWait.resolve();
    await saved;
    ok('saved-routes open awaits the list refresh', savedOpened);
    await a.run('openRoutePlannerPanel()');
    ok('the ordinary sidebar action still toggles a warm planner closed', a.get('route-planner-panel').classList.contains('translate-x-full'));

    const broken = archive();
    broken.state.importFailure = new Error('Synthetic planner module failed');
    const failure = broken.run('openRoutePlannerPanel({ showSaved: true })').then(() => null, error => error);
    broken.respond();
    const error = await failure;
    ok('failed initialization removes the half-created panel and rejects the opener', error?.message === 'Synthetic planner module failed'
        && broken.get('route-planner-panel') === null);
    broken.state.importFailure = null;
    const retry = broken.run('openRoutePlannerPanel({ showSaved: true })');
    ok('retry after failed initialization fetches a clean component again', broken.state.fetches.length === 2);
    broken.respond();
    broken.initWait.resolve();
    broken.savedWait.resolve();
    await retry;
    ok('retry initializes successfully and opens the saved list once', broken.state.initCalls === 1 && broken.state.savedCalls === 1
        && broken.get('route-planner-panel').classList.contains('translate-x-0'));

    const unavailable = archive();
    const noMarkup = unavailable.run('openRoutePlannerPanel()').then(() => null, error => error);
    unavailable.respond(false);
    const markupError = await noMarkup;
    ok('failed component fetch never inserts or initializes a broken planner', markupError?.message.includes('Could not load')
        && unavailable.state.inserts === 0 && unavailable.state.initCalls === 0);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
