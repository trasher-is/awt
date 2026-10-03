// public/js/ui/hub-settings-store.js — the browser's copy of a member's settings.
//
// The store runs in two JavaScript realms at once (dashboard and game frame), so what matters
// is: a repeat visit answers synchronously from the cached copy; a first visit waits for the
// server but never for long; a failed read falls back to the defaults instead of hanging the
// page; a change shows at once and is rolled back to the server's truth if the save fails;
// and a change made in the other realm arrives through the `storage` event.
//
// Browser ESM, so each scenario writes a fresh copy to a temp .mjs (module state is per
// instance) with its one relative import pointed at the real file, and stubs the globals.
//
// Run with: node src/utils/hub-settings-store.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const CACHE_KEY = 'awt.hubSettings.v1';

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const canon = v => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort()) : val));
const same = (a, b) => canon(a) === canon(b);

console.log('hub-settings-store.test.js');

// A promise that never settles does not keep Node alive: the process would simply exit 0
// with the rest of the suite unrun. That is exactly how a hung whenReady() would look, so a
// run that did not reach its last line is a failure, not a pass.
let finished = false;
process.on('exit', () => { if (!finished) { console.error('  NOT OK - the suite did not run to the end (something never settled)'); process.exitCode = 1; } });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-settings-store-'));
const storeSrc = fs.readFileSync(path.join(ROOT, 'public/js/ui/hub-settings-store.js'), 'utf8')
    .replace("import '../utils/hub-settings.js';", `import '${pathToFileURL(path.join(ROOT, 'public/js/utils/hub-settings.js')).href}';`);

let instance = 0;
async function load({ cache, fetchImpl }) {
    const ls = new Map();
    if (cache !== undefined) ls.set(CACHE_KEY, typeof cache === 'string' ? cache : JSON.stringify(cache));
    const handlers = {};
    const calls = [];
    globalThis.localStorage = {
        getItem: k => (ls.has(k) ? ls.get(k) : null),
        setItem: (k, v) => { ls.set(k, String(v)); },
        removeItem: k => { ls.delete(k); },
    };
    globalThis.window = { addEventListener: (type, fn) => { handlers[type] = fn; } };
    globalThis.fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        return fetchImpl(url, opts);
    };
    const target = path.join(tmp, `store-${++instance}.mjs`);
    fs.writeFileSync(target, storeSrc);
    const store = await import(pathToFileURL(target).href);
    return { store, ls, handlers, calls };
}

const HubSettings = require(path.join(ROOT, 'public/js/utils/hub-settings.js'));
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const server = overrides => json({ success: true, overrides });
// A server that remembers: GET reads, POST applies the change or the reset, as userSettings.js does.
function statefulServer(initial = {}) {
    let state = initial;
    return async (url, opts = {}) => {
        if (opts.method === 'POST') {
            const body = JSON.parse(opts.body);
            state = body.reset === true ? {} : HubSettings.applyChanges(state, body.changes);
        }
        return server(state);
    };
}
const tick = () => new Promise(r => setImmediate(r));

(async () => {
    // ─── First visit: no cached copy ──────────────────────────────────────────
    console.log('\n── First visit ' + '─'.repeat(60));
    {
        let release;
        const gate = new Promise(r => { release = r; });
        const { store, ls } = await load({ fetchImpl: async () => { await gate; return server({ 'inject.suButtons': false }); } });
        ok('before anything is known the store is not ready', store.isReady() === false);
        ok('and answers with the defaults meanwhile', store.isEnabled('inject.suButtons') === true && store.isEnabled('tool.battleCalc') === false);
        let settled = false;
        const ready = store.whenReady().then(() => { settled = true; });
        await tick();
        ok('whenReady waits for the server on a first visit', settled === false);
        release();
        await ready;
        ok('then it is ready', store.isReady() === true);
        ok('and the server\'s answer applies', store.isEnabled('inject.suButtons') === false);
        ok('the copy is cached for the next page load', same(JSON.parse(ls.get(CACHE_KEY)), { 'inject.suButtons': false }), ls.get(CACHE_KEY));
        ok('calling whenReady again does not fetch again', (await store.whenReady(), true));
    }

    // All defaults is the common case: it must still leave a cached copy, or every page load waits.
    {
        const { store, ls } = await load({ fetchImpl: async () => server({}) });
        await store.whenReady();
        ok('a member on all defaults still gets a cached copy', ls.has(CACHE_KEY) && same(JSON.parse(ls.get(CACHE_KEY)), {}), ls.get(CACHE_KEY));
    }

    // ─── Repeat visit: cached copy ────────────────────────────────────────────
    console.log('\n── Repeat visit ' + '─'.repeat(59));
    {
        let release;
        const gate = new Promise(r => { release = r; });
        const { store, calls } = await load({ cache: { 'tool.battleCalc': true }, fetchImpl: async () => { await gate; return server({ 'tool.battleCalc': false, 'inject.popTimers': false }); } });
        ok('a cached copy makes the store ready at once', store.isReady() === true);
        ok('and answers from it synchronously', store.isEnabled('tool.battleCalc') === true);
        let changes = 0;
        store.onChange(() => { changes++; });
        await store.whenReady();   // resolves without waiting on the server
        ok('whenReady does not wait for the server', calls.length === 1 && store.isEnabled('tool.battleCalc') === true);
        release();
        await tick(); await tick();
        ok('the server copy is still read, to catch a change from another device', store.isEnabled('tool.battleCalc') === false && store.isEnabled('inject.popTimers') === false);
        ok('and listeners are told it changed, once', changes === 1, changes);
    }
    {
        const { store, calls } = await load({ cache: { 'tool.battleCalc': true }, fetchImpl: async () => server({ 'tool.battleCalc': true }) });
        let changes = 0;
        store.onChange(() => { changes++; });
        await store.whenReady(); await tick();
        ok('a server copy that agrees changes nothing and tells nobody', changes === 0 && calls.length === 1, changes);
    }
    {
        const { store } = await load({ cache: '{ corrupt', fetchImpl: async () => server({}) });
        ok('a corrupt cached copy reads as the defaults', store.isEnabled('inject.suButtons') === true && store.isEnabled('tool.battleCalc') === false);
    }

    // ─── Failures ─────────────────────────────────────────────────────────────
    console.log('\n── When the server does not answer ' + '─'.repeat(40));
    {
        const warn = console.warn; console.warn = () => {};
        const { store } = await load({ fetchImpl: async () => json({ error: 'nope' }, 500) });
        await store.whenReady();
        console.warn = warn;
        ok('a failed first read counts as ready, with the defaults', store.isReady() === true && store.isEnabled('inject.suButtons') === true && store.isEnabled('tool.battleCalc') === false);
    }
    {
        const warn = console.warn; console.warn = () => {};
        const { store } = await load({ fetchImpl: async () => { throw new Error('network down'); } });
        await store.whenReady();
        console.warn = warn;
        ok('a network error is not a hang either', store.isReady() === true);
    }
    {
        // A server that never answers must not stall the game frame's hooks, which also carry
        // the alliance's data scrapes. The wait is capped; here the cap fires immediately.
        const realSetTimeout = globalThis.setTimeout;
        const { store } = await load({ fetchImpl: () => new Promise(() => {}) });
        globalThis.setTimeout = fn => { fn(); return 0; };
        await store.whenReady();
        globalThis.setTimeout = realSetTimeout;
        ok('a server that never answers is waited for only so long', store.isReady() === true && store.isEnabled('inject.suButtons') === true);
        ok('the cap is a few seconds, not forever', store.FIRST_READ_TIMEOUT_MS >= 1000 && store.FIRST_READ_TIMEOUT_MS <= 5000, store.FIRST_READ_TIMEOUT_MS);
    }

    // ─── Changing ─────────────────────────────────────────────────────────────
    console.log('\n── Changing ' + '─'.repeat(63));
    {
        let release;
        const gate = new Promise(r => { release = r; });
        const { store, calls, ls } = await load({
            cache: {},
            fetchImpl: async (url, opts) => {
                if (opts && opts.method === 'POST') { await gate; return server({ 'inject.suButtons': false }); }
                return server({});
            },
        });
        await store.whenReady(); await tick();
        let notified = 0;
        store.onChange(() => { notified++; });
        const pending = store.change({ 'inject.suButtons': false });
        ok('a change shows at once, before the server has answered', store.isEnabled('inject.suButtons') === false && notified === 1);
        ok('and is cached at once, so the game frame\'s realm sees it', same(JSON.parse(ls.get(CACHE_KEY)), { 'inject.suButtons': false }));
        release();
        await pending;
        const post = calls.find(c => c.method === 'POST');
        ok('it posts only the change, to /hub-api/settings', post && post.url === '/hub-api/settings' && same(post.body, { changes: { 'inject.suButtons': false } }), post);
        ok('the server\'s confirmation leaves it as it was', store.isEnabled('inject.suButtons') === false && notified === 1, notified);
        ok('a snapshot has every key', Object.keys(store.snapshot()).length === require(path.join(ROOT, 'public/js/utils/hub-settings.js')).ALL.length && store.snapshot()['inject.suButtons'] === false, Object.keys(store.snapshot()).length);
    }
    {
        // The save fails: what the member saw is wrong, so go back to what the server holds.
        const { store } = await load({
            cache: { 'tool.battleCalc': true },
            fetchImpl: async (url, opts) => (opts && opts.method === 'POST' ? json({ success: false, error: 'Failed to save settings' }, 500) : server({ 'tool.battleCalc': true })),
        });
        await store.whenReady(); await tick();
        let error = null;
        await store.change({ 'tool.battleCalc': false }).catch(e => { error = e; });
        ok('a failed save rejects, with the server\'s reason', error && /Failed to save settings/.test(error.message), error && error.message);
        ok('and the change is undone to what the server holds', store.isEnabled('tool.battleCalc') === true);
    }
    {
        const { store } = await load({ cache: {}, fetchImpl: statefulServer() });
        await store.whenReady(); await tick();
        await store.change({ 'inject.popTimers': false });
        const before = store.isEnabled('inject.popTimers');
        await store.reset();
        ok('reset goes back to the defaults', before === false && store.isEnabled('inject.popTimers') === true);
    }
    {
        const { store, calls } = await load({ cache: { 'inject.suButtons': false }, fetchImpl: async () => server({}) });
        await store.whenReady(); await tick();
        await store.reset();
        const post = calls.filter(c => c.method === 'POST').pop();
        ok('reset posts { reset: true }', post && same(post.body, { reset: true }), post);
    }

    // ─── The other realm ──────────────────────────────────────────────────────
    console.log('\n── The other realm (storage event) ' + '─'.repeat(40));
    {
        const { store, ls, handlers } = await load({ cache: {}, fetchImpl: async () => server({}) });
        await store.whenReady(); await tick();
        ok('the store listens for storage events', typeof handlers.storage === 'function');
        let notified = 0;
        store.onChange(() => { notified++; });
        ls.set(CACHE_KEY, JSON.stringify({ 'inject.suButtons': false }));   // what the other realm wrote
        handlers.storage({ key: CACHE_KEY });
        ok('a change written by the other realm is picked up and announced', store.isEnabled('inject.suButtons') === false && notified === 1);
        handlers.storage({ key: 'something.else' });
        ok('an unrelated key is ignored', notified === 1);
        handlers.storage({ key: CACHE_KEY });
        ok('an event that changes nothing announces nothing', notified === 1);
    }

    // ─── Logout ───────────────────────────────────────────────────────────────
    console.log('\n── Logout ' + '─'.repeat(65));
    {
        const { store, ls } = await load({ cache: { 'tool.battleCalc': true }, fetchImpl: async () => server({ 'tool.battleCalc': true }) });
        store.clearCache();
        ok('clearing forgets the cached copy', !ls.has(CACHE_KEY));
        ok('and the next account starts from the defaults', store.isEnabled('tool.battleCalc') === false && store.isReady() === false);
    }

    // ─── Source rules ─────────────────────────────────────────────────────────
    console.log('\n── Source ' + '─'.repeat(65));
    const code = storeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('every request goes to the hub, none to the game', !/gameFetch|\/Game\/|astrowars/i.test(code) && (code.match(/fetch\(/g) || []).length === 2);
    ok('localStorage access is always guarded (it throws in a browser set to block site data)', (code.match(/localStorage\./g) || []).length === (code.match(/try \{[^}]*localStorage\./g) || []).length);

    finished = true;
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
