// Exercise the browser card's real async lifecycle with synthetic DOM/network inputs.
// No game session, captured reports, or browser-specific dependencies are needed.
const fs = require('fs');
const path = require('path');
require('../../public/js/utils/sqlite-time.js');

let pass = 0, fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};

class Node {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.attributes = {};
        this.events = {};
        this.hidden = false;
        this.disabled = false;
        this._text = '';
    }
    get isConnected() { return this.connected === true || !!this.parentNode?.isConnected; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._text = '';
        children.forEach(child => this.appendChild(child));
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { this.events[type] = callback; }
    click() { if (!this.disabled && !this.hidden) this.events.click?.(); }
}

const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui/battle-race-intel.js'), 'utf8');
const load = new Function('document', 'fetch', `${src.replace(/^import .*$/gm, '').replace(/^export /gm, '')}\nreturn mountBattleRaceIntel;`);
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const flush = () => new Promise(done => setImmediate(done));
const find = (root, predicate) => [root, ...root.children.flatMap(child => descendants(child))].find(predicate);
function descendants(node) { return [node, ...node.children.flatMap(child => descendants(child))]; }
const button = (root, label) => find(root, node => node.tagName === 'button' && node.textContent === label);

function setup(options = {}) {
    const calls = [];
    const pending = [];
    const liveTables = [];
    const document = { createElement: tag => new Node(tag), querySelectorAll: () => liveTables };
    const fetch = (url, request) => {
        calls.push({ url, ...request });
        const next = deferred();
        pending.push(next);
        return next.promise;
    };
    const mount = load(document, fetch);
    const root = new Node('main');
    root.connected = true;
    const controller = mount(root, { playerId: 42, ...options });
    return { root, mount, controller, calls, pending, liveTables };
}

const estimate = {
    updated_at: '2026-09-12 17:50:03',
    status: 'compatible', report_count: 6, eligible_report_count: 2,
    used_report_ids: [101, 202], skipped: { missing_ship_counts: 3, not_confirmed_winner: 1 },
    attack: { status: 'insufficient', bonus_percent_range: { min: -32, max: 32 }, reason: 'Historical physics is unknown.' },
    defense: { status: 'compatible', bonus_percent_range: { min: -48, max: 0 }, candidates: [-4, -3, -2, 0], reason: 'Winner losses constrain the upper bound.' },
    assumptions: ['Sciences are unknown; this is conditional on the local model.'],
};

(async () => {
    const bio = setup({ hasBio: true });
    await bio.controller.ready;
    ok('bio keeps the exact update control visible and disabled', button(bio.root, 'Update from battle reports').disabled);
    ok('bio does not load or display a weaker estimate', bio.calls.length === 0 && /Bio intel is available/.test(bio.root.textContent));

    const visible = setup({ hasLiveIntel: true });
    await visible.controller.ready;
    ok('live profile intel locks before background sync catches up', visible.calls.length === 0 && button(visible.root, 'Update from battle reports').disabled);

    const state = setup();
    const update = button(state.root, 'Update from battle reports');
    ok('initial source verification disables updates and calls only the hub', update.disabled
        && state.calls[0].url === '/hub-api/intel/player/42/battle-race-inference' && state.calls[0].method === 'GET');
    ok('remounting the same container does not duplicate requests or cards', state.mount(state.root, { playerId: 42 }) === state.controller && state.calls.length === 1 && state.root.children.length === 1);
    state.pending[0].resolve(response({ success: true, has_bio: false, inference: null }));
    await state.controller.ready;
    ok('a verified no-bio player can update', !update.disabled && /No estimate saved/.test(state.root.textContent));
    update.click(); update.click();
    ok('double click emits one update and disables the control while busy', state.calls.length === 2 && state.calls[1].method === 'POST' && update.disabled);
    state.pending[1].resolve(response({ success: true, has_bio: false, inference: estimate }));
    await flush();
    ok('candidate signs, counts and conditional status are visible', /Compatible DEF picks: -4, -3, -2, \+0/.test(state.root.textContent)
        && /2 eligible of 6 stored reports/.test(state.root.textContent) && /Conditional estimate only/.test(state.root.textContent));
    const updatedHour = String(new Date('2026-09-12T17:50:03Z').getHours()).padStart(2, '0');
    ok('saved evidence timestamp reads SQLite as UTC and renders the local 24-hour clock',
        state.root.textContent.includes(`${updatedHour}:50:03`) && !/\b(?:AM|PM)\b/.test(state.root.textContent));
    ok('attack shows its unresolved bonus range rather than an invented probability', /Attack: −32% to \+32% — unresolved/.test(state.root.textContent));
    ok('defence shows the narrowed bonus range and labels it conditional', /Defence: −48% to \+0% — conditional range/.test(state.root.textContent));
    ok('the evidence details link contributing reports and explain exclusions', find(state.root, node => node.tagName === 'a' && node.href === '/About/BattleReport/202')
        && /missing ship counts: 3; not confirmed winner: 1/.test(state.root.textContent));

    update.click();
    state.pending[2].resolve(response({}, 500));
    await flush();
    ok('failed update preserves the previous result and offers retry', /previous estimate is still shown/.test(state.root.textContent)
        && /Compatible DEF picks: -4/.test(state.root.textContent) && !button(state.root, 'Retry').hidden);
    button(state.root, 'Retry').click();
    ok('retry repeats the failed POST, without accidentally reading stale saved state', state.calls[3].method === 'POST');
    state.pending[3].resolve(response({}, 409));
    await flush();
    ok('bio arriving during POST locks and clears all previously rendered evidence', update.disabled && /Bio intel is available/.test(state.root.textContent)
        && !/Compatible DEF|Historical physics|eligible of/.test(state.root.textContent) && button(state.root, 'Retry').hidden);

    const retryLoad = setup();
    retryLoad.pending[0].resolve(response({}, 500));
    await retryLoad.controller.ready;
    ok('failed GET cannot enable updates before the bio check succeeds', button(retryLoad.root, 'Update from battle reports').disabled && !button(retryLoad.root, 'Retry').hidden);
    button(retryLoad.root, 'Retry').click();
    retryLoad.pending[1].resolve(response({ success: true, has_bio: false, inference: null }));
    await flush();
    ok('GET retry recovers cleanly', retryLoad.calls[1].method === 'GET' && !button(retryLoad.root, 'Update from battle reports').disabled);
    retryLoad.liveTables.push({ closest: () => ({}) });
    button(retryLoad.root, 'Update from battle reports').click();
    ok('old intel embedded in a player note does not lock the update', retryLoad.calls.length === 3);
    retryLoad.pending[2].resolve(response({ success: true, has_bio: false, inference: estimate }));
    await flush();
    retryLoad.liveTables.push({ closest: () => null });
    button(retryLoad.root, 'Update from battle reports').click();
    ok('new genuine live intel locks before any POST and clears old evidence', retryLoad.calls.length === 3
        && button(retryLoad.root, 'Update from battle reports').disabled && !/Compatible DEF/.test(retryLoad.root.textContent));

    for (const code of [401, 403]) {
        const auth = setup();
        auth.pending[0].resolve(response({}, code));
        await auth.controller.ready;
        ok(`${code} explains the access problem and keeps updates disabled`, (code === 401 ? /Sign in again/ : /hub role/).test(auth.root.textContent)
            && button(auth.root, 'Update from battle reports').disabled && button(auth.root, 'Retry').hidden);
    }

    const malformed = setup();
    malformed.pending[0].resolve(response({ success: true, has_bio: false, inference: {
        ...estimate, report_count: Infinity, defense: { status: 'compatible', candidates: ['<img src=x onerror=evil()>'] },
        assumptions: ['<script>evil()</script>'],
    } }));
    await malformed.controller.ready;
    ok('malformed picks never become evidence and count formatting stays finite', /Not enough evidence to narrow/.test(malformed.root.textContent) && !/Infinity/.test(malformed.root.textContent));
    ok('server prose is rendered as text without HTML parsing', malformed.root.textContent.includes('<script>evil()</script>')
        && !descendants(malformed.root).some(node => /script|img/.test(node.tagName)));

    const manyReports = setup();
    manyReports.pending[0].resolve(response({ success: true, has_bio: false, inference: {
        ...estimate, used_report_ids: ['javascript:evil()', 0, ...Array.from({ length: 25 }, (_, index) => index + 1)],
    } }));
    await manyReports.controller.ready;
    const links = descendants(manyReports.root).filter(node => node.tagName === 'a');
    ok('large evidence sets show the latest twenty safe numeric links and remainder', links.length === 20
        && links[0].href === '/About/BattleReport/25' && /5 more/.test(manyReports.root.textContent));

    const detached = setup();
    const before = detached.root.textContent;
    detached.root.connected = false;
    detached.pending[0].resolve(response({ success: true, has_bio: false, inference: estimate }));
    await detached.controller.ready;
    ok('a response after profile removal cannot rerender the detached card', detached.root.textContent === before);

    const protectedGet = setup();
    protectedGet.pending[0].resolve(response({ success: true, has_bio: true, inference: estimate }));
    await protectedGet.controller.ready;
    ok('GET bio authority suppresses even an included stale estimate', button(protectedGet.root, 'Update from battle reports').disabled && !/Compatible DEF/.test(protectedGet.root.textContent));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
