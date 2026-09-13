// Regression coverage for the one-time migration that rescues a hub tab too old to update
// itself (2026-09-13). version-watch.js only runs in tabs that already loaded it, so a tab
// opened before it existed would sit on that day's JavaScript indefinitely. The game frame
// is the way out: the proxy injects the hub's script into every proxied game page, so the
// in-frame code is current no matter how stale the wrapper around it is.
//
// The dangerous property here is the loop guard. If the wrapper fails to announce a version
// after reloading — its scripts blocked, an error before it boots — forcing it again on the
// next navigation would trap the member in a reload cycle they can neither escape nor
// diagnose. That case gets the most attention below.
//
// public/js/core/stale-wrapper-reload.js is a browser ES module with no imports, so it runs
// in a vm context with hand-built globals.
//
// Run with: node src/utils/stale-wrapper-reload.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'core', 'stale-wrapper-reload.js'), 'utf8')
    .replace(/^export\s+/gm, '');

function build({ parentVersion = null, framed = true, crossOrigin = false, storage = 'working' } = {}) {
    let reloads = 0;
    const store = new Map();
    const self = {};

    const parentWindow = {
        location: { reload: () => { reloads++; } },
    };
    if (parentVersion) parentWindow.__hubBuildVersion = parentVersion;

    const windowStub = {};
    Object.defineProperty(windowStub, 'parent', {
        get() {
            if (crossOrigin) throw new Error('Blocked a frame with origin from accessing a cross-origin frame.');
            return framed ? parentWindow : windowStub;
        },
    });

    const sessionStorage = storage === 'throws'
        ? { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }
        : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };

    const context = vm.createContext({ window: windowStub, sessionStorage, Date, console: { log: () => {} } });
    vm.runInContext(`${src}\nglobalThis.__run = reloadWrapperIfPreVersionWatch;`, context, { filename: 'stale-wrapper-reload.js' });

    self.run = () => context.__run();
    Object.defineProperty(self, 'reloads', { get: () => reloads });
    return self;
}

console.log('stale-wrapper-reload.test.js');

console.log('\n── A wrapper too old to update itself gets reloaded, once ' + '─'.repeat(19));
{
    const h = build({ parentVersion: null });
    ok('it reloads the wrapper', h.run() === true && h.reloads === 1, h.reloads);
    ok('a second navigation does NOT reload again — no loop, even though the stub wrapper\n     still announces nothing', h.run() === false && h.reloads === 1, h.reloads);
    ok('nor a third', h.run() === false && h.reloads === 1, h.reloads);
}

console.log('\n── A wrapper that can update itself is left alone ' + '─'.repeat(27));
{
    const h = build({ parentVersion: 'bac137dcdef1' });
    ok('no reload', h.run() === false && h.reloads === 0, h.reloads);
    ok('still none after several navigations',
        [h.run(), h.run(), h.run()].every(r => r === false) && h.reloads === 0, h.reloads);
}

console.log('\n── Nothing to migrate ' + '─'.repeat(54));
{
    const unframed = build({ framed: false });
    ok('not in a frame at all — never touches its own window',
        unframed.run() === false && unframed.reloads === 0);

    const foreign = build({ crossOrigin: true });
    ok('a cross-origin parent is not ours to reload, and throwing does not escape',
        foreign.run() === false && foreign.reloads === 0);
}

console.log('\n── No sessionStorage means no loop guard ' + '─'.repeat(36));
{
    // Without somewhere to record the attempt there is no way to stop at one, and an
    // unstoppable reload cycle is far worse than staying on an old build — so it declines.
    const h = build({ parentVersion: null, storage: 'throws' });
    ok('it declines to reload rather than risk a cycle it cannot break',
        h.run() === false && h.reloads === 0, h.reloads);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
