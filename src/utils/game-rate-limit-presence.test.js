// Nothing goes to the game on a member's session while that member is away.
//
// Every tool request rides on the member's own game session and the game counts it as the
// member being active, so an open hub tab used to keep its member at "0s idle" around the
// clock (2026-10-16). game-rate-limit.js now holds its queue while the document is hidden
// or nobody has touched a hub/game document for IDLE_AFTER_MS, and every background job
// checks isMemberActive() before starting a tick.
//
// Run with:  node src/utils/game-rate-limit-presence.test.js

const fs = require('fs');
const path = require('path');
const modulePath = require.resolve('../../public/js/utils/game-rate-limit.js');
const repo = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fresh() {
    delete require.cache[modulePath];
    return require(modulePath);
}

function fakeDocument() {
    const listeners = {};
    return {
        hidden: false,
        visibilityState: 'visible',
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        fire(type) { (listeners[type] || []).forEach(fn => fn({ type })); },
        listeners,
    };
}

function installStorage() {
    const storage = new Map();
    globalThis.localStorage = {
        getItem: k => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: k => storage.delete(k),
    };
    return storage;
}

(async () => {
    console.log('── Outside a browser the gate is open ' + '─'.repeat(38));
    delete globalThis.document;
    delete globalThis.localStorage;
    let R = fresh();
    ok('no document: member counts as active', R.isMemberActive() === true);
    ok('no document: a request runs', (await R.schedule(async () => 'ran')) === 'ran');

    console.log('\n── A visible tab nobody has touched sends nothing ' + '─'.repeat(26));
    const storage = installStorage();
    const doc = fakeDocument();
    globalThis.document = doc;
    R = fresh();
    R.reset();
    ok('listens for member input', ['pointerdown', 'keydown', 'touchstart', 'mousemove'].every(t => doc.listeners[t]));
    ok('no input yet: not active', R.isMemberActive() === false);
    let ran = false;
    const held = R.schedule(async () => { ran = true; return 'late'; });
    await sleep(300);
    ok('request is held while away', ran === false && R.snapshot().pending === 1, R.snapshot());
    ok('snapshot reports the pause', R.snapshot().paused === true);
    doc.fire('pointerdown');
    ok('a tap makes the member active', R.isMemberActive() === true);
    ok('the held request goes out once the member is back', (await held) === 'late');

    console.log('\n── A hidden tab sends nothing, even right after input ' + '─'.repeat(23));
    doc.hidden = true; doc.visibilityState = 'hidden';
    ok('hidden: not active', R.isMemberActive() === false);
    ran = false;
    const hiddenJob = R.schedule(async () => { ran = true; return 'back'; });
    await sleep(300);
    ok('request is held while hidden', ran === false);
    doc.hidden = false; doc.visibilityState = 'visible';
    ok('visible again: request goes out', (await hiddenJob) === 'back');

    console.log('\n── Idle for longer than IDLE_AFTER_MS counts as away ' + '─'.repeat(24));
    R.reset();
    storage.set(R.INPUT_KEY, String(Date.now() - R.IDLE_AFTER_MS - 1000));
    ok('old input: not active', R.isMemberActive() === false);
    storage.set(R.INPUT_KEY, String(Date.now() - 60 * 1000));
    ok('input a minute ago: active', R.isMemberActive() === true);

    console.log('\n── Input in the game iframe counts for the wrapper ' + '─'.repeat(25));
    // Two realms (wrapper + injected game frame) each load the module; they share storage.
    R.reset();
    const wrapper = fresh();
    const frameDoc = fakeDocument();
    globalThis.document = frameDoc;
    fresh();                       // the frame's own instance registers on its document
    globalThis.document = doc;     // wrapper's document again
    ok('wrapper starts away', wrapper.isMemberActive() === false);
    frameDoc.fire('keydown');
    ok('a keypress in the frame makes the wrapper active', wrapper.isMemberActive() === true);

    console.log('\n── Every background job checks presence before a tick ' + '─'.repeat(22));
    // Member taps only (2026-10-17): these are the ONLY background jobs that may still send
    // game requests, each once per game day for the whole hub, after the reset. Everything
    // else that talks to the game runs from a member's tap or a page they opened.
    const jobs = [
        'public/js/ui/battle-sync.js',
        'public/js/ui/battle-report-detail-sync.js',
        'public/js/ui/bonus-goals-sync.js',
        'public/js/ui/highest-population-watch.js',
        'public/js/ui/best-planets-watch.js',
    ];
    for (const file of jobs) {
        const src = fs.readFileSync(path.join(repo, file), 'utf8');
        ok(`${file} checks isMemberActive()`, src.includes('isMemberActive()'));
        ok(`${file} runs only when the hub hands it the day's turn`, src.includes('await claimSharedJob('));
    }
    // spy.js's only timer polls the hub (bonus-goal targets); its one game request is a
    // one-shot identity check on load, which the gate itself holds while the member is away.
    const notGameTimers = new Set(['public/js/core/spy.js']);
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
    const gameTimers = walk(path.join(repo, 'public', 'js'))
        .map(f => [path.relative(repo, f), fs.readFileSync(f, 'utf8')])
        .filter(([f, src]) => /setInterval\(/.test(src) && /gameFetch\(|AWApi\.\w+\(|searchBattleReports|scrapeBattleReportShipDetail\(/.test(src)
            && !notGameTimers.has(f))
        .map(([f]) => f);
    const extra = gameTimers.filter(f => !jobs.includes(f));
    ok('no other file runs a timer that talks to the game (a new one needs the owner\'s OK first)', extra.length === 0, extra);

    console.log('\n── Member taps only: no timers left in these ' + '─'.repeat(31));
    // Science / Planets / Trade (the "Update my data" button), the ListPlayer roster (before a
    // Player scan) and the galaxy seed (the Galaxy buttons) — no timer, and nothing started
    // on dashboard load.
    const tapOnly = {
        'public/js/ui/research-watch.js': 'initResearchWatch',
        'public/js/ui/my-planets-watch.js': 'initMyPlanetsWatch',
        'public/js/ui/trade-inventory-watch.js': 'initTradeInventoryWatch',
        'public/js/ui/player-api-sync.js': 'initPlayerApiSync',
        'public/js/scrapers/api-galaxy-seed.js': 'startAutoGalaxySeed',
    };
    const dashboard = fs.readFileSync(path.join(repo, 'public', 'js', 'ui', 'dashboard.js'), 'utf8');
    for (const [file, starter] of Object.entries(tapOnly)) {
        const src = fs.readFileSync(path.join(repo, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        ok(`${file} has no timer`, !/setInterval\(|setTimeout\(/.test(src));
        ok(`${file} is not started on dashboard load`, !src.includes(starter) && !dashboard.includes(starter));
    }

    delete globalThis.document;
    delete globalThis.localStorage;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
