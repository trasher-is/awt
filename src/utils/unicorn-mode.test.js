const fs = require('fs');
const path = require('path');
const Mode = require('../../public/js/utils/unicorn-mode.js');
const SqliteTime = require('../../public/js/utils/sqlite-time.js');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
}
console.log('unicorn-mode.test.js');

function detectorFeed(detector, word, props = {}, start = 10000) {
    return [...word].map((key, i) => detector.feed({ key, target: { tagName: 'BODY' }, ...props }, start + i * 30));
}
ok('the word is case-insensitive and fires once', detectorFeed(Mode.createWordDetector(), 'UNICORN').filter(Boolean).length === 1);
ok('near matches do not activate', !detectorFeed(Mode.createWordDetector(), 'unicom').some(Boolean));
ok('noise before the word does not break it', detectorFeed(Mode.createWordDetector(), 'xxununicorn').filter(Boolean).length === 1);
for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }, { getAttribute: name => name === 'role' ? 'textbox' : null }]) {
    ok('typing into an editor never activates', !detectorFeed(Mode.createWordDetector(), 'unicorn', { target }).some(Boolean), target);
}
for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
    ok(`${key} cannot activate`, !detectorFeed(Mode.createWordDetector(), 'unicorn', { [key]: true }).some(Boolean));
}
{
    const detector = Mode.createWordDetector();
    detector.feed({ key: 'u' }, 10000);
    detector.feed({ key: 'u', repeat: true }, 10020);
    ok('held-key repeats do not corrupt a deliberate word', detectorFeed(detector, 'nicorn', {}, 10030).some(Boolean));
    detectorFeed(detector, 'uni');
    ok('a long gap breaks the word', !detectorFeed(detector, 'corn', {}, 10000 + Mode.KEY_GAP_MS + 1000).some(Boolean));
    detectorFeed(detector, 'uni');
    detector.feed({ key: 'x', target: { tagName: 'INPUT' } }, 10100);
    ok('entering a text field resets a partial word', !detectorFeed(detector, 'corn', {}, 10200).some(Boolean));
}

// Plain event/document stand-ins: no game data, external DOM library or clock mocking
// of a rate limiter. The controllable clock belongs only to this one-hour decoration.
class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); }
    count(type) { return this.listeners.get(type)?.size || 0; }
}
class Node extends Events {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.attrs = {}; }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    querySelector(selector) {
        for (const child of this.children) {
            if (selector.startsWith('.') && child.className.split(/\s+/).includes(selector.slice(1))) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
}
class Doc extends Events {
    constructor() { super(); this.body = new Node('body'); this.documentElement = new Node('html'); this.hidden = false; this.frame = null; }
    createElement(tag) { return new Node(tag); }
    getElementById(id) { return id === 'game-frame' ? this.frame : null; }
}
let clock = 1000000;
let timerId = 0;
const shared = new Map();
const hosts = [];
function makeHost(blockStorage = false) {
    const host = new Events();
    host.document = new Doc();
    host.timers = new Map();
    host.intervals = new Map();
    host.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
    host.setTimeout = (fn, ms) => { const id = ++timerId; host.timers.set(id, { fn, due: clock + ms }); return id; };
    host.clearTimeout = id => host.timers.delete(id);
    host.setInterval = (fn, ms) => { const id = ++timerId; host.intervals.set(id, { fn, ms }); return id; };
    host.clearInterval = id => host.intervals.delete(id);
    host.MutationObserver = class { constructor(callback) { this.callback = callback; host.lastObserver = this; } observe() { this.connected = true; } disconnect() { this.connected = false; } };
    host.localStorage = {
        getItem(key) { if (blockStorage) throw new Error('blocked'); return shared.get(key) ?? null; },
        setItem(key, value) {
            if (blockStorage) throw new Error('blocked');
            shared.set(key, value);
            for (const other of hosts) if (other !== host) other.dispatchEvent({ type: 'storage', key });
        },
        removeItem(key) {
            if (blockStorage) throw new Error('blocked');
            shared.delete(key);
            for (const other of hosts) if (other !== host) other.dispatchEvent({ type: 'storage', key });
        }
    };
    hosts.push(host);
    return host;
}
function tick(host, milliseconds) {
    clock += milliseconds;
    for (let count = 0; count < 100; count++) {
        const ready = [...host.timers].filter(([, value]) => value.due <= clock);
        if (!ready.length) break;
        for (const [id, value] of ready) { host.timers.delete(id); value.fn(); }
    }
}
{
    const hostA = makeHost(), hostB = makeHost();
    const a = Mode.createStore(hostA, () => clock), b = Mode.createStore(hostB, () => clock);
    a.activate();
    const deadline = a.getState().expiresAt;
    ok('activation is exactly sixty minutes', deadline === clock + Mode.DURATION_MS && a.getState().minutesLeft === 60);
    ok('another tab becomes active via storage', b.getState().expiresAt === deadline);
    clock += 59 * 60000;
    const reload = Mode.createStore(makeHost(), () => clock);
    ok('reload preserves the absolute deadline and remaining minute', reload.getState().expiresAt === deadline && reload.getState().minutesLeft === 1);
    a.deactivate();
    ok('OFF immediately disables other tabs', !a.getState().active && !b.getState().active && !reload.getState().active);
    a.activate();
    let visibleState;
    a.subscribe(state => { visibleState = state; });
    tick(hostA, Mode.DURATION_MS);
    ok('the deadline itself expires and notifies without navigation', !visibleState.active && !a.getState().active);
    a.activate();
    clock += Mode.DURATION_MS;
    hostA.document.dispatchEvent({ type: 'visibilitychange' });
    ok('resuming a throttled tab rechecks expiry', !visibleState.active);
    a.dispose(); b.dispose(); reload.dispose();
    ok('store cleanup removes event listeners and timers', hostA.count('storage') === 0 && hostA.count(Mode.CHANGE_EVENT) === 0 && hostA.timers.size === 0);
}
{
    const host = makeHost(true);
    const a = Mode.createStore(host, () => clock), sameDocument = Mode.createStore(host, () => clock);
    a.activate();
    ok('blocked storage retains active state in the current owner', a.getState().active);
    ok('same-document events propagate without storage', sameDocument.getState().active);
    a.deactivate();
    ok('same-document OFF works without storage', !sameDocument.getState().active);
    a.dispose(); sameDocument.dispose();
}
ok('invalid timestamps and the exact deadline are inactive', !Mode.stateAt(NaN, clock).active && !Mode.stateAt(clock, clock).active);

const source = fs.readFileSync(path.join(__dirname, '../../public/js/ui/unicorn-mode.js'), 'utf8');
const browserSource = source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
const markerCalls = [];
const ui = new Function('globalThis', 'Date', 'renderUnicornMarkers', 'clearUnicornMarkers', 'isUnicornMutation',
    `${browserSource}; return { initUnicornMode, summarizeUnicornData };`)(
    { AWUnicornMode: { ...Mode, createStore: host => Mode.createStore(host, () => clock) }, AWSqliteTime: SqliteTime },
    { now: () => clock },
    (doc, data) => { doc.rendered = data; markerCalls.push({ doc, data }); },
    doc => { doc.rendered = null; },
    record => record.owned === true
);
const sample = { success: true, total: 50, mapped: 40, synced_at: '2026-09-28T10:00:00Z', rows: [], leaders: [], leaders_status: 'incomplete' };
ok('status shows partial mapping and unavailable leaders', /40\/50/.test(ui.summarizeUnicornData(sample)) && /incomplete/.test(ui.summarizeUnicornData(sample)));
ok('old syncs are visibly stale', /stale/.test(ui.summarizeUnicornData(sample, Date.parse('2026-09-30T10:00:00Z'))));
ok('missing snapshots do not read as an empty current ranking', /not been synced/.test(ui.summarizeUnicornData({ total: 0 })));
ok('a fully mapped partial ranking still says fewer than fifty entries', /Partial ranking: 3\/50 entries · 3\/3 located/.test(ui.summarizeUnicornData({ ...sample, total: 3, mapped: 3 })));
ok('identified leaders are not described as necessarily located', /4 building leaders identified/.test(ui.summarizeUnicornData({ ...sample, mapped: 1, leaders_status: 'complete' })));
ok('the controller only fetches the hub endpoint', /host\.fetch\('\/hub-api\/intel\/unicorn'/.test(source) && !/gameFetch|\/api\/v1\/|\/Game\//.test(source));

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function type(doc, text) { for (const key of text) doc.dispatchEvent({ type: 'keydown', key, target: { tagName: 'BODY' } }); }
function answer(request, data = sample) { request.resolve({ ok: true, json: async () => data }); }
(async () => {
    shared.clear();
    const host = makeHost();
    const frame = new Node('iframe');
    frame.contentDocument = new Doc();
    host.document.frame = frame;
    const requests = [];
    host.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    const cleanup = ui.initUnicornMode(host);
    ok('init is idempotent', ui.initUnicornMode(host) === cleanup && host.document.count('keydown') === 1 && frame.count('load') === 1);
    ok('OFF has no request or game annotations', requests.length === 0 && !frame.contentDocument.rendered);
    type(host.document, 'uni');
    type(frame.contentDocument, 'corn');
    ok('one word can cross wrapper and iframe', requests.length === 1 && requests[0].url === '/hub-api/intel/unicorn');
    const off = host.document.body.querySelector('.awt-unicorn-off');
    ok('the requested OFF label is exact and countdown visible', off.textContent === 'Unicorn OFF' && host.document.body.querySelector('.awt-unicorn-countdown').textContent.includes('60 min'));
    off.dispatchEvent({ type: 'click' });
    answer(requests[0]);
    await flush();
    ok('a late response cannot redraw after OFF', !frame.contentDocument.rendered && !host.document.body.querySelector('.awt-unicorn-control'));
    type(frame.contentDocument, 'unicorn');
    const staleRequest = requests[1];
    host.document.body.querySelector('.awt-unicorn-off').dispatchEvent({ type: 'click' });
    type(host.document, 'unicorn');
    const currentRequest = requests[2];
    answer(staleRequest, { ...sample, mapped: 1 });
    await flush();
    ok('an old activation cannot win a new activation race', !frame.contentDocument.rendered);
    answer(currentRequest, { ...sample, mapped: 49 });
    await flush();
    ok('the current activation renders its own snapshot', frame.contentDocument.rendered?.mapped === 49);
    const oldDoc = frame.contentDocument;
    const oldObserver = host.lastObserver;
    frame.contentDocument = new Doc();
    frame.dispatchEvent({ type: 'load' });
    ok('frame navigation detaches old keys, observer and annotations', oldDoc.count('keydown') === 0 && !oldObserver.connected && !oldDoc.rendered);
    ok('the new document gets cached markers without another fetch', frame.contentDocument.count('keydown') === 1 && frame.contentDocument.rendered?.mapped === 49 && requests.length === 3);
    const before = markerCalls.length;
    host.lastObserver.callback([{ owned: true }]);
    tick(host, 150);
    ok('the observer ignores its own annotations', markerCalls.length === before);
    host.lastObserver.callback([{ owned: false }]);
    tick(host, 150);
    ok('SPA markup replacement redraws from memory', markerCalls.length === before + 1 && requests.length === 3);
    clock += Mode.DURATION_MS;
    host.document.dispatchEvent({ type: 'visibilitychange' });
    ok('expiry removes the control, markers and refresh interval', !frame.contentDocument.rendered && !host.document.body.querySelector('.awt-unicorn-control') && host.intervals.size === 0);
    cleanup(); cleanup();
    ok('controller cleanup removes both keyboard listeners', host.document.count('keydown') === 0 && frame.contentDocument.count('keydown') === 0 && frame.count('load') === 0);

    const blocked = makeHost(true);
    blocked.document.frame = new Node('iframe');
    blocked.document.frame.contentDocument = new Doc();
    const blockedRequests = [];
    blocked.fetch = url => new Promise(resolve => blockedRequests.push({ url, resolve }));
    const stopBlocked = ui.initUnicornMode(blocked);
    type(blocked.document.frame.contentDocument, 'unicorn');
    answer(blockedRequests[0]);
    await flush();
    ok('a blocked-storage wrapper still renders its frame', blocked.document.frame.contentDocument.rendered?.mapped === 40);
    blocked.document.body.querySelector('.awt-unicorn-off').dispatchEvent({ type: 'click' });
    ok('blocked-storage OFF immediately clears its frame', !blocked.document.frame.contentDocument.rendered);
    stopBlocked();
    console.log(failed ? `  FAIL (${failed})` : '  PASS');
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
