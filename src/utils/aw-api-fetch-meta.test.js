// Per-request diagnostics in the game-API client: which cache-relevant headers came back and whether
// the bytes were served from the network, the browser's cache or by revalidation.
//
// Run with:  node src/utils/aw-api-fetch-meta.test.js
//
// Opt-in only: without { meta: true } a result is exactly what it always was, so no existing caller
// or test can be affected. The in-browser capture (PerformanceObserver) cannot run under Node, where
// it correctly answers "unknown"; its classification is tested directly on timing-entry-shaped data.
// The injected fake network is still scheduled through the real rate gate, so this takes a moment.
// All data is synthetic.

const path = require('path');
const fs = require('fs');

const AWApi = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'aw-api.js'));
const R = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-rate-limit.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const headersOf = map => ({ get: h => (h && Object.prototype.hasOwnProperty.call(map, h.toLowerCase()) ? map[h.toLowerCase()] : null) });
const respond = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, headers: headersOf(headers), text: async () => body });

let nextResponse = null;
AWApi._setFetch(() => (typeof nextResponse === 'function' ? nextResponse() : nextResponse));

(async () => {
    R.reset();
    console.log('aw-api-fetch-meta.test.js');

    console.log('\n── picking headers ' + '─'.repeat(56));
    {
        const kept = AWApi.pickHeaders(headersOf({
            date: 'Sat, 03 Oct 2026 04:47:21 GMT', age: '240', 'cache-control': 'private, max-age=60', etag: '"v1"',
            'set-cookie': 'a=b', authorization: 'Bearer x', 'content-type': 'application/json', vary: 'x'.repeat(400),
        }));
        ok('the cache-relevant headers are read by name', kept.date && kept.age === '240' && kept['cache-control'] === 'private, max-age=60' && kept.etag === '"v1"', kept);
        ok('cookies, authorization and anything else off the list are never read', !('set-cookie' in kept) && !('authorization' in kept) && !('content-type' in kept), kept);
        ok('a long value is cut', kept.vary.length === 200, kept.vary.length);
        ok('a response with no usable headers object yields nothing', Object.keys(AWApi.pickHeaders(null)).length === 0 && Object.keys(AWApi.pickHeaders({})).length === 0);
        ok('no header on the list is credential-shaped', !AWApi.META_HEADERS.some(h => /cookie|authorization|token|secret/i.test(h)), AWApi.META_HEADERS);
    }

    console.log('\n── network, cache or revalidation ' + '─'.repeat(41));
    {
        const body = 408110;
        ok('headers + body on the wire: the network', AWApi.classifyTransfer({ transferSize: 408440, encodedBodySize: body }).cache_state === 'network');
        ok('nothing on the wire but a body: the browser\'s cache', AWApi.classifyTransfer({ transferSize: 0, encodedBodySize: body }).cache_state === 'cache');
        ok('a few hundred bytes against a big body: a 304 revalidation', AWApi.classifyTransfer({ transferSize: 310, encodedBodySize: body }).cache_state === 'revalidated');
        ok('a browser that says so (deliveryType "cache") is believed', AWApi.classifyTransfer({ deliveryType: 'cache', transferSize: 500, encodedBodySize: 10 }).cache_state === 'cache');
        ok('a small body with its headers is still the network (headers outweigh it)', AWApi.classifyTransfer({ transferSize: 520, encodedBodySize: 40 }).cache_state === 'network');
        ok('no entry, or sizes the browser withheld, is "unknown", not a guess',
            [null, undefined, {}, { transferSize: 0, encodedBodySize: 0 }, { transferSize: NaN, encodedBodySize: NaN }, 'x'].every(e => AWApi.classifyTransfer(e).cache_state === 'unknown'));
        ok('the sizes are carried through for later questions', AWApi.classifyTransfer({ transferSize: 7, encodedBodySize: 9, deliveryType: '' }).transfer_size === 7
            && AWApi.classifyTransfer({ transferSize: 7, encodedBodySize: 9, deliveryType: '' }).encoded_body_size === 9);
    }

    console.log('\n── opt-in: results are untouched unless asked ' + '─'.repeat(29));
    {
        nextResponse = respond(200, JSON.stringify([{ id: 1 }]), { 'content-type': 'application/json', date: 'Sat, 03 Oct 2026 04:47:21 GMT', age: '12', 'set-cookie': 'a=b' });
        const plain = await AWApi.getMapSectors({ x1: -40, y1: -40, x2: 40, y2: 40 });
        ok('without the option a result is exactly {ok, data}: no meta key, nothing else added',
            JSON.stringify(plain) === JSON.stringify({ ok: true, data: [{ id: 1 }] }), plain);

        const withMeta = await AWApi.getMapSectors({ x1: -40, y1: -40, x2: 40, y2: 40 }, { meta: true });
        ok('with { meta: true } the same data comes back, plus meta', withMeta.ok === true && JSON.stringify(withMeta.data) === JSON.stringify([{ id: 1 }]) && withMeta.meta, withMeta);
        ok('...with the status and the cache-relevant headers, and no cookie',
            withMeta.meta.status === 200 && withMeta.meta.headers.age === '12' && withMeta.meta.headers.date && !('set-cookie' in withMeta.meta.headers), withMeta.meta);
        ok('...how long the call took, as a number', Number.isFinite(withMeta.meta.fetch_ms) && withMeta.meta.fetch_ms >= 0, withMeta.meta.fetch_ms);
        ok('...and, under Node where no browser timing exists, an honest "unknown" cache state', withMeta.meta.cache_state === 'unknown' && withMeta.meta.transfer_size === null, withMeta.meta);
    }

    console.log('\n── meta on failures too ' + '─'.repeat(51));
    {
        nextResponse = respond(500, 'boom', { 'content-type': 'text/plain', age: '3' });
        const http = await AWApi.getMapSectors({}, { meta: true });
        ok('an HTTP error keeps its reason and gains the headers', http.ok === false && http.reason === 'http' && http.status === 500 && http.meta.headers.age === '3', http);

        nextResponse = respond(200, '<html>login</html>', { 'content-type': 'text/html' });
        const login = await AWApi.getMapSectors({}, { meta: true });
        ok('a login page is still reason "session", with meta', login.reason === 'session' && login.meta && login.meta.status === 200, login);

        nextResponse = () => { throw new Error('offline'); };
        const down = await AWApi.getMapSectors({}, { meta: true });
        ok('a network failure still says so, with a (header-less) meta', down.reason === 'network' && down.meta && Object.keys(down.meta.headers).length === 0, down);

        nextResponse = respond(500, 'boom', { 'content-type': 'text/plain' });
        const bare = await AWApi.getMapSectors({});
        ok('and without the option a failure is still exactly what it was', JSON.stringify(bare) === JSON.stringify({ ok: false, status: 500, reason: 'http' }), bare);
    }

    console.log('\n── the file stays scannable ' + '─'.repeat(47));
    {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'aw-api.js'), 'utf8');
        ok('aw-api.js has no block-comment terminator (aw-api.test.js strips comments naively; one would swallow the code)', !src.includes('*' + '/'));
        ok('and still no import/export, which would break one of its two runtimes', !/^\s*(import|export)\b/m.test(src));
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
