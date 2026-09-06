// Cached systems and players refresh after a sync instead of living forever.
//
// Run with:  node src/utils/fresh-cache.test.js
//
// route-planner.js kept loadSystems/loadPlayers results in module-level variables with no
// TTL and no invalidation: open the planner against an empty database, [] is cached, and a
// sync a minute later is invisible until the dashboard is reloaded. A failed load ALSO
// produced [], indistinguishable from "really empty" (issue #133).
//
// The clock is injected, so "a minute later" is a number, not a wait.

const path = require('path');
const fs = require('fs');

const { createFreshCache, DEFAULTS } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'fresh-cache.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance(ms) { t += ms; } };
}

// A loader whose answers are scripted, so the test decides what "the server" says.
function scriptedLoader() {
    const calls = [];
    let answer = () => [];
    return {
        calls,
        set(fn) { answer = fn; },
        fn: async () => { calls.push(Date.now()); return answer(); },
    };
}

(async () => {
    console.log('── Empty data is refreshed once a sync has landed ' + '─'.repeat(25));
    {
        const c = clock();
        const cache = createFreshCache({ now: c.now });
        const server = scriptedLoader();

        let r = await cache.get(server.fn);
        ok('an empty database loads as an empty list', Array.isArray(r.data) && r.data.length === 0 && r.error === null, r);
        ok('the first load is not "from cache"', r.fromCache === false);

        c.advance(1000);
        r = await cache.get(server.fn);
        ok('a second ask a second later does not refetch (no request per keystroke)', server.calls.length === 1 && r.fromCache === true, server.calls.length);

        // The galaxy sync lands.
        server.set(() => [{ id: 1, name: 'Achird' }, { id: 2, name: 'Rana' }]);
        c.advance(DEFAULTS.emptyTtlMs + 1);
        r = await cache.get(server.fn);
        ok('once the short empty-TTL is over, reopening/searching refetches', server.calls.length === 2, server.calls.length);
        ok('and the newly synced systems are there — no page reload needed', r.data.length === 2 && r.data[1].name === 'Rana', r.data);

        c.advance(DEFAULTS.emptyTtlMs + 1);
        r = await cache.get(server.fn);
        ok('a non-empty list is trusted for the full TTL, not the short one', server.calls.length === 2 && r.fromCache === true, server.calls.length);
        c.advance(DEFAULTS.ttlMs);
        r = await cache.get(server.fn);
        ok('and refetched once the full TTL has passed', server.calls.length === 3, server.calls.length);
    }

    console.log('\n── A failed load is an error to retry, not authoritative empty data ' + '─'.repeat(7));
    {
        const c = clock();
        const cache = createFreshCache({ now: c.now });
        const server = scriptedLoader();
        server.set(() => { throw new Error('HTTP 503'); });

        let r = await cache.get(server.fn);
        ok('the failure is reported', r.error instanceof Error && /503/.test(r.error.message), r.error && r.error.message);
        ok('with no data pretending to be a result', r.data === null && r.loaded === false, r);

        c.advance(1000);
        r = await cache.get(server.fn);
        ok('asking again immediately does not hammer the server', server.calls.length === 1 && r.error !== null, server.calls.length);

        c.advance(DEFAULTS.errorRetryMs);
        server.set(() => [{ id: 9 }]);
        r = await cache.get(server.fn);
        ok('after the back-off the next ask retries on its own', server.calls.length === 2, server.calls.length);
        ok('and a successful retry clears the error', r.error === null && r.data.length === 1, r);

        // Explicit retry (the Retry button) goes straight through the back-off.
        server.set(() => { throw new Error('HTTP 500'); });
        r = await cache.get(server.fn, { force: true });
        ok('force ignores freshness and refetches', server.calls.length === 3);
        r = await cache.get(server.fn, { force: true });
        ok('...and ignores the error back-off too', server.calls.length === 4);
    }

    console.log('\n── A failed REFRESH keeps the previously cached data ' + '─'.repeat(23));
    {
        const c = clock();
        const cache = createFreshCache({ now: c.now });
        const server = scriptedLoader();
        server.set(() => [{ id: 1 }, { id: 2 }, { id: 3 }]);
        await cache.get(server.fn);

        c.advance(DEFAULTS.ttlMs + 1);
        server.set(() => { throw new Error('network'); });
        const r = await cache.get(server.fn);
        ok('the stale list is still returned', Array.isArray(r.data) && r.data.length === 3, r.data);
        ok('flagged as stale and from cache', r.stale === true && r.fromCache === true, r);
        ok('with the error alongside, so the panel can offer a retry', r.error && r.error.message === 'network', r.error);
        ok('peek() shows the same picture without loading', cache.peek().loaded === true && cache.peek().error !== null && server.calls.length === 2);
    }

    console.log('\n── Concurrency and invalidation ' + '─'.repeat(43));
    {
        const c = clock();
        const cache = createFreshCache({ now: c.now });
        let resolveLoad;
        const loader = () => new Promise(res => { resolveLoad = res; });
        const a = cache.get(loader), b = cache.get(loader);
        resolveLoad([1]);
        const [ra, rb] = await Promise.all([a, b]);
        ok('two overlapping asks share one load', ra.data === rb.data && ra.data.length === 1);

        const server = scriptedLoader();
        server.set(() => ['x']);
        await cache.get(server.fn, { force: true });
        c.advance(1000);
        await cache.get(server.fn);
        ok('fresh data is served from cache', server.calls.length === 1);
        cache.invalidate();
        const r = await cache.get(server.fn);
        ok('invalidate() makes the next ask load again', server.calls.length === 2 && r.fromCache === false);
        ok('ageMs reports how old the data is', cache.peek().ageMs === 0 && (c.advance(2500), cache.peek().ageMs === 2500));
    }

    console.log('\n── Shape and defaults ' + '─'.repeat(53));
    {
        ok('a full list is trusted for a minute', DEFAULTS.ttlMs === 60 * 1000, DEFAULTS);
        ok('an empty one only for seconds', DEFAULTS.emptyTtlMs < DEFAULTS.ttlMs && DEFAULTS.emptyTtlMs <= 10 * 1000, DEFAULTS);
        const cache = createFreshCache({ ttlMs: 10, emptyTtlMs: 1, errorRetryMs: 1, isEmpty: v => v === 'nothing' });
        ok('a custom emptiness rule is honoured', cache.options.ttlMs === 10 && typeof cache.options.isEmpty === 'function');
        const r = await cache.get(async () => { throw 'plain string'; });
        ok('a thrown non-Error becomes an Error', r.error instanceof Error && r.error.message === 'plain string');
    }

    // ─── THE PLANNER ACTUALLY USES IT ────────────────────────────────────────────
    console.log('\n── route-planner.js is wired to it ' + '─'.repeat(40));
    const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const planner = readCode('public/js/ui/route-planner.js');
    ok('route-planner.js imports the cache module', /import '\.\.\/utils\/fresh-cache\.js'/.test(planner));
    ok('systems and players each get a cache', /systemsCache = createFreshCache\(/.test(planner) && /playersCache = createFreshCache\(/.test(planner));
    ok('the forever-caches are gone', !/let sysCache\b/.test(planner) && !/if \(sysCache\) return sysCache/.test(planner) && !/if \(playerCache\) return playerCache/.test(planner));
    ok('a failed load surfaces as an error, not as an empty list',
        /if \(!d\.success\) throw new Error/.test(planner));
    ok('reopening the panel refreshes stale data', /MutationObserver/.test(planner) && /refreshReferenceData\(/.test(planner));
    ok('there is an explicit refresh/retry control', /rp-data-refresh/.test(planner) && /force: true/.test(planner));
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'components', 'route-planner.html'), 'utf8');
    ok('the panel markup has the status line and the refresh button', /id="rp-data-status"/.test(html) && /id="rp-data-refresh"/.test(html));
    const utilSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'fresh-cache.js'), 'utf8');
    ok('the shared module stays dual-runtime: no import/export statements', !/^\s*(import|export)\b/m.test(utilSrc));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
