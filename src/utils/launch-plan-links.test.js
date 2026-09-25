// public/js/core/launch-plan-links.js — "Your plans" destination links on the fleet
// launch form. Synthetic form elements only; the game's real markup is not recorded here.
//
// Pinned: the fill touches only System and Planet #, fires the events the page listens
// for, copes with a planet list that arrives late, admits failure instead of faking
// success, and — checked by scanning the source — can never submit, click or pick ships.
//
// Run with: node src/utils/launch-plan-links.test.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('launch-plan-links.test.js');

const srcPath = path.join(__dirname, '../../public/js/core/launch-plan-links.js');
const src = fs.readFileSync(srcPath, 'utf8');
const code = src.replace(/^import .*$/gm, '').replace(/^export \{.*\};?$/gm, '');
global.Event = class { constructor(type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles); } };
const { applyPlanToLaunchForm } = new Function('esc', `${code}\nreturn { applyPlanToLaunchForm };`)(s => String(s));

// A <select>-like element: value only sticks when an option carries it, like the real thing.
function fakeSelect(values) {
    const el = {
        events: [],
        _value: '',
        options: values.map(v => ({ value: String(v) })),
        get value() { return this._value; },
        set value(v) { if (this.options.some(o => o.value === String(v))) this._value = String(v); },
        dispatchEvent(e) { this.events.push(e.type); return true; },
    };
    return el;
}

// Stand-in for MutationObserver: tests call `trigger()` to simulate the page rebuilding a list.
let observers = [];
class FakeObserver {
    constructor(cb) { this.cb = cb; this.active = false; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    trigger() { if (this.active) this.cb([]); }
}

const plan = { system_id: 140, planet_index: 4, system_name: 'Vega' };

(async () => {
    // 1. Both values already offered.
    let sys = fakeSelect([139, 140, 141]);
    let pl = fakeSelect([1, 2, 3, 4, 5]);
    let r = await applyPlanToLaunchForm(sys, pl, plan, { waitMs: 50, Observer: FakeObserver });
    ok('fills system and planet', r.ok && sys.value === '140' && pl.value === '4', r);
    ok('fires input and change on both, so the page reacts as if the member picked them',
        sys.events.join() === 'input,change' && pl.events.join() === 'input,change', [sys.events, pl.events]);
    ok('tells the member to choose ships and launch themselves', /Choose your ships and launch/.test(r.message), r.message);

    // 2. System not offered (e.g. out of range for this fleet).
    sys = fakeSelect([1, 2]);
    pl = fakeSelect([1, 2, 3, 4]);
    r = await applyPlanToLaunchForm(sys, pl, plan, { waitMs: 50, Observer: FakeObserver });
    ok('a system not in the list is reported, not faked', !r.ok && /pick it by hand/.test(r.message) && sys.value === '', r);
    ok('and the planet field is left alone', pl.value === '' && pl.events.length === 0, pl);

    // 3. Planet list filled in only after the system changes.
    observers = [];
    sys = fakeSelect([140]);
    pl = fakeSelect([]);
    const pending = applyPlanToLaunchForm(sys, pl, plan, { waitMs: 1000, Observer: FakeObserver });
    await new Promise(res => setTimeout(res, 10));
    pl.options = [1, 2, 3, 4].map(v => ({ value: String(v) }));
    observers.forEach(o => o.trigger());
    r = await pending;
    ok('waits for a planet list that arrives late, then fills it', r.ok && pl.value === '4', r);
    ok('stops watching once it is done', observers.every(o => !o.active), observers.map(o => o.active));

    // 3b. The real form (recorded 2026-09-25): planets 1-12 are ALWAYS listed, and changing
    // System makes the page clear and refill that list asynchronously, resetting the pick.
    // Setting the planet before that rebuild lands gets silently wiped.
    observers = [];
    const twelve = () => Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1) }));
    sys = fakeSelect([40, 70]);
    sys._value = '40';
    pl = fakeSelect([]);
    pl.options = twelve();
    pl._value = '9';
    const realPending = applyPlanToLaunchForm(sys, pl, { system_id: 70, planet_index: 10, system_name: 'Aridif' }, { waitMs: 1000, Observer: FakeObserver });
    await new Promise(res => setTimeout(res, 10));
    ok('does not pick the planet before the page rebuilds the list', pl.value === '9', pl.value);
    pl.options = []; pl._value = '';                      // step 1: list cleared
    observers.forEach(o => o.trigger());
    await new Promise(res => setTimeout(res, 10));
    ok('an emptied list is not mistaken for the finished rebuild', pl.value === '', pl.value);
    pl.options = twelve(); pl._value = '1';               // step 2: refilled, pick reset
    observers.forEach(o => o.trigger());
    r = await realPending;
    ok('after the rebuild, the planned planet is the one selected', r.ok && sys.value === '70' && pl.value === '10', [r, sys.value, pl.value]);

    // 3c. System already the right one: nothing will rebuild, so nothing to wait for.
    observers = [];
    sys = fakeSelect([70]); sys._value = '70';
    pl = fakeSelect([]); pl.options = twelve(); pl._value = '1';
    const t0 = Date.now();
    r = await applyPlanToLaunchForm(sys, pl, { system_id: 70, planet_index: 10 }, { waitMs: 1000, Observer: FakeObserver });
    ok('same system: sets the planet at once, without waiting for a rebuild', r.ok && pl.value === '10' && Date.now() - t0 < 200 && sys.events.length === 0, [r, Date.now() - t0, sys.events]);

    // 4. Planet never appears.
    observers = [];
    sys = fakeSelect([140]);
    pl = fakeSelect([1, 2]);
    r = await applyPlanToLaunchForm(sys, pl, plan, { waitMs: 30, Observer: FakeObserver });
    ok('a planet that never appears is reported after the wait', !r.ok && /planet #4 could not be selected/.test(r.message), r);
    ok('and the observer is released on timeout', observers.every(o => !o.active), observers.map(o => o.active));

    // 5. The boundaries, by source scan (comments stripped so explanations cannot trip them).
    const bare = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('never submits a form', !/\.submit\s*\(|requestSubmit/.test(bare));
    ok('never clicks anything', !/\.click\s*\(/.test(bare));
    ok('only acts from a member click: the fill runs inside a click listener', /addEventListener\('click'[\s\S]*applyPlanToLaunchForm\(/.test(bare));
    const fetches = [...bare.matchAll(/fetch\(\s*['"`]([^'"`]+)/g)].map(m => m[1]);
    ok('its only request is to the hub, never the game', fetches.length === 1 && fetches[0].startsWith('/hub-api/'), fetches);

    if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
    console.log('All checks passed');
})().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
