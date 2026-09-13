// Regression coverage for the self-updating tab (2026-09-13). The risky half is not
// noticing a new build — it is WHEN the reload happens. Wrapper.html holds the live game
// in an iframe, so reloading the top window reloads the game too; doing that while someone
// is mid-move would throw away real work to deliver a change they never asked for. These
// cases pin the "is this moment free?" rule, including the one that is easy to get wrong:
// a member playing steadily INSIDE the game frame generates no events out in the hub
// document, so judging idleness by the hub alone would single out exactly the person who
// must not be interrupted.
//
// public/js/ui/version-watch.js is a browser ES module with no imports of its own, so it
// runs in a vm context with hand-built globals rather than needing a DOM.
//
// Run with: node src/utils/version-watch.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'version-watch.js'), 'utf8')
    .replace(/^export\s+/gm, '');

const IDLE_MS = 10 * 60 * 1000;

function build({ version = 'v1', hasFrame = true } = {}) {
    let now = 1_000_000;
    let reloads = 0;
    const notices = [];
    const intervals = [];
    const listeners = { doc: {}, frame: {}, frameDoc: {} };
    let served = version;

    const listenerBag = (bag) => ({
        addEventListener: (type, fn) => { (bag[type] = bag[type] || []).push(fn); },
    });
    const fire = (bag, type) => (bag[type] || []).forEach(fn => fn());

    const frameDoc = { ...listenerBag(listeners.frameDoc) };
    const frame = { ...listenerBag(listeners.frame), contentDocument: hasFrame ? frameDoc : null };

    const document = {
        ...listenerBag(listeners.doc),
        hidden: false,
        getElementById: (id) => (hasFrame && id === 'game-frame' ? frame : null),
    };

    const context = vm.createContext({
        Date: { now: () => now },
        document,
        window: { location: { reload: () => { reloads++; } } },
        fetch: async () => ({ ok: true, json: async () => ({ version: served }) }),
        setInterval: (fn) => { intervals.push(fn); return intervals.length; },
        console: { warn: () => {} },
    });
    vm.runInContext(`${src}\nglobalThis.__init = initVersionWatch;`, context, { filename: 'version-watch.js' });

    return {
        init: (onNotice = (v) => notices.push(v)) => context.__init(onNotice),
        // intervals[0] is the version check, intervals[1] the "is it a safe moment?" retry.
        check: () => intervals[0](),
        retryReload: () => intervals[1](),
        deploy: (v) => { served = v; },
        advance: (ms) => { now += ms; },
        activityInHub: () => fire(listeners.doc, 'pointerdown'),
        activityInGameFrame: () => fire(listeners.frameDoc, 'pointerdown'),
        hide: () => { document.hidden = true; fire(listeners.doc, 'visibilitychange'); },
        get reloads() { return reloads; },
        get notices() { return notices; },
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
    console.log('version-watch.test.js');

    console.log('\n── Nothing has changed: never reload ' + '─'.repeat(40));
    {
        const h = build({ version: 'v1' });
        h.init();
        await flush();
        await h.check();
        h.advance(IDLE_MS * 2);
        h.retryReload();
        ok('an unchanged build never reloads, however long the tab sits idle', h.reloads === 0);
        ok('and says nothing', h.notices.length === 0, h.notices);
    }

    console.log('\n── A new build, with the member actively using the hub ' + '─'.repeat(22));
    {
        const h = build({ version: 'v1' });
        h.init();
        await flush();
        h.deploy('v2');
        await h.check();
        ok('the member is told once', h.notices.length === 1 && h.notices[0] === 'v2', h.notices);
        ok('but is NOT interrupted mid-session', h.reloads === 0);

        h.advance(IDLE_MS - 1000);
        h.retryReload();
        ok('still not interrupted just short of the idle threshold', h.reloads === 0);

        h.advance(2000);
        h.retryReload();
        ok('reloads once they have been idle long enough', h.reloads === 1);
    }

    console.log('\n── Activity inside the GAME FRAME counts as being busy ' + '─'.repeat(22));
    {
        const h = build({ version: 'v1' });
        h.init();
        await flush();
        h.deploy('v2');
        await h.check();

        // Someone playing steadily in the frame touches nothing in the hub document.
        for (let i = 0; i < 5; i++) {
            h.advance(IDLE_MS - 1000);
            h.activityInGameFrame();
            h.retryReload();
        }
        ok('a member playing in the game frame is never yanked out of it, however long they play',
            h.reloads === 0);

        h.advance(IDLE_MS + 1000);
        h.retryReload();
        ok('and the reload lands as soon as they actually stop', h.reloads === 1);
    }

    console.log('\n── A hidden tab is free to reload immediately ' + '─'.repeat(31));
    {
        const h = build({ version: 'v1' });
        h.init();
        await flush();
        h.activityInHub(); // just used it — would be far too soon on the idle rule alone
        h.deploy('v2');
        await h.check();
        ok('a visible tab in active use holds off', h.reloads === 0);
        h.hide();
        ok('backgrounding it reloads at once — nobody is looking, let alone playing',
            h.reloads === 1);
    }

    console.log('\n── Repeat checks do not repeat themselves ' + '─'.repeat(35));
    {
        const h = build({ version: 'v1' });
        h.init();
        await flush();
        h.deploy('v2');
        await h.check();
        await h.check();
        await h.check();
        ok('the same new build is announced once, not once per poll', h.notices.length === 1, h.notices);

        h.advance(IDLE_MS * 2);
        h.retryReload();
        h.retryReload();
        ok('and reload is called once, not on every retry tick', h.reloads === 1);
    }

    console.log('\n── The server being unreachable is not a reason to do anything ' + '─'.repeat(14));
    {
        const h = build({ version: 'v1' });
        h.init();
        await flush();
        // A failed poll (offline, or the server mid-restart) must not be read as a change.
        const context = h;
        h.deploy(null);
        await h.check().catch(() => {});
        h.advance(IDLE_MS * 2);
        h.retryReload();
        ok('an unusable answer reloads nothing', context.reloads === 0);
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
