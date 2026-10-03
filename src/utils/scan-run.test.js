// What the hub keeps about a galaxy scan, and how it vets what a client sends (src/utils/scan-run.js).
//
// Run with:  node src/utils/scan-run.test.js
//
// The client is untrusted, so every field is clamped or dropped; the header list can never carry a
// credential; a negative age is "not reported". All inputs are synthetic.

const { sanitizeScanRun, sanitizeRunId, sanitizeAgeMs, browserFamily, parseHttpDate, pickHeaders, HEADER_WHITELIST } = require('./scan-run');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('scan-run.test.js');

console.log('\n── run ids ' + '─'.repeat(64));
ok('a UUID is accepted', sanitizeRunId('3f2b8c1e-5d4a-4b7e-9c2f-1a6d8e0b7c44') === '3f2b8c1e-5d4a-4b7e-9c2f-1a6d8e0b7c44');
ok('the plain fallback form (base36-random) is accepted', sanitizeRunId('lq3x9a-k2m8z1p0q4') === 'lq3x9a-k2m8z1p0q4');
ok('too short, too long, spaces, quotes and non-strings are all refused',
    [ 'short', 'x'.repeat(65), 'has space in it', "bad'id-injection", '../etc/passwd', 12345678, null, undefined, {} ].every(v => sanitizeRunId(v) === null));

console.log('\n── ages ' + '─'.repeat(67));
ok('an age is whole milliseconds', sanitizeAgeMs(1500.4) === 1500 && sanitizeAgeMs('2500') === 2500 && sanitizeAgeMs(0) === 0);
ok('a negative or non-numeric age is not reported (a client clock bug, not a 0)',
    sanitizeAgeMs(-5) === null && sanitizeAgeMs('soon') === null && sanitizeAgeMs(null) === null && sanitizeAgeMs(undefined) === null);
ok('an absurd age is capped at a week', sanitizeAgeMs(1e15) === 7 * 24 * 3600 * 1000);

console.log('\n── browser family ' + '─'.repeat(57));
const UA = {
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
    chromeMobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};
ok('Firefox', browserFamily(UA.firefox).browser === 'firefox' && browserFamily(UA.firefox).mobile === 0);
ok('Chrome (and not mistaken for Safari, which its string also contains)', browserFamily(UA.chrome).browser === 'chrome');
ok('Edge and Opera are not mistaken for Chrome, whose string theirs also contain',
    browserFamily(UA.edge).browser === 'edge' && browserFamily(UA.opera).browser === 'opera');
ok('Safari', browserFamily(UA.safari).browser === 'safari');
ok('mobile is flagged separately from the family', browserFamily(UA.chromeMobile).browser === 'chrome' && browserFamily(UA.chromeMobile).mobile === 1);
ok('a missing or odd User-Agent is "other", never a failure',
    browserFamily(undefined).browser === 'other' && browserFamily('curl/8.0').browser === 'other' && browserFamily(42).mobile === 0);

console.log('\n── HTTP dates ' + '─'.repeat(61));
ok('an HTTP date parses', parseHttpDate('Sat, 03 Oct 2026 04:47:21 GMT') === Date.UTC(2026, 9, 3, 4, 47, 21));
ok('garbage and non-strings do not', parseHttpDate('yesterday-ish') === null && parseHttpDate(null) === null && parseHttpDate(5) === null);

console.log('\n── headers: only a short list, never a credential ' + '─'.repeat(24));
{
    const kept = pickHeaders({
        date: 'Sat, 03 Oct 2026 04:47:21 GMT', age: '240', 'cache-control': 'private, max-age=60', etag: '"abc"',
        'set-cookie': 'session=secret', cookie: 'session=secret', authorization: 'Bearer secret', 'x-secret': 'nope',
        via: 'x'.repeat(500), server: 123, vary: '',
    });
    ok('credential-shaped and unknown headers are dropped', !('set-cookie' in kept) && !('cookie' in kept) && !('authorization' in kept) && !('x-secret' in kept), kept);
    ok('the cache-relevant ones are kept', kept.date && kept.age === '240' && kept['cache-control'] === 'private, max-age=60' && kept.etag === '"abc"', kept);
    ok('a long value is cut, and a non-string or empty one is ignored', kept.via.length === 200 && !('server' in kept) && !('vary' in kept), kept);
    ok('the list itself contains no credential header',
        !HEADER_WHITELIST.some(h => /cookie|authorization|token|secret|key/i.test(h)), HEADER_WHITELIST);
    ok('a non-object yields nothing', Object.keys(pickHeaders(null)).length === 0 && Object.keys(pickHeaders('x')).length === 0);
}

console.log('\n── a whole scan report ' + '─'.repeat(52));
{
    const T = 1_790_000_000_000; // receipt time on the server
    const body = {
        run_id: '3f2b8c1e-5d4a-4b7e-9c2f-1a6d8e0b7c44', trigger: 'auto', result: 'ok',
        tab_age_s: 5400.7, run_index: 0, hidden_at_start: true, went_hidden: true,
        systems_total: 381, systems_posted: 380, planets_posted: 3100, in_vision: 111,
        duration_ms: 41250, fetch_ms: 830, post_ms_avg: 105, post_ms_max: 910, response_status: 200,
        cache_state: 'network', transfer_size: 408440, encoded_body_size: 408110, delivery_type: '',
        fetched_ago_ms: 2000,
        headers: { date: new Date(T - 2000 - 90_000).toUTCString(), 'cache-control': 'no-cache', 'set-cookie': 'x=1' },
    };
    const row = sanitizeScanRun(body, { userAgent: UA.firefox, receivedAtMs: T });
    ok('a well-formed report is stored as sent (numbers rounded)', row.run_id === body.run_id && row.started_by === 'auto' && row.result === 'ok'
        && row.tab_age_s === 5401 && row.systems_posted === 380 && row.in_vision === 111 && row.post_ms_max === 910 && row.cache_state === 'network', row);
    ok('flags become 0/1 and the browser comes from the User-Agent, not from the body',
        row.hidden_at_start === 1 && row.went_hidden === 1 && row.browser === 'firefox' && row.mobile === 0, row);
    ok('how old the game\'s own copy already was is the receipt time, minus how long ago the response ended, minus its Date: 90s',
        row.date_lag_s === 90, row.date_lag_s);
    ok('only whitelisted headers are stored', JSON.parse(row.headers_json)['cache-control'] === 'no-cache' && !('set-cookie' in JSON.parse(row.headers_json)), row.headers_json);

    ok('no usable run id means no row', sanitizeScanRun({ ...body, run_id: 'x' }, { userAgent: UA.firefox }) === null
        && sanitizeScanRun(null) === null && sanitizeScanRun('nope') === null && sanitizeScanRun({}) === null);
    const odd = sanitizeScanRun({ run_id: body.run_id, trigger: 'sometimes', result: 'maybe', cache_state: 'quantum', systems_total: 1e12, tab_age_s: -4,
        hidden_at_start: 'yes', headers: { date: 'not a date' }, fetched_ago_ms: 1000 }, { userAgent: UA.chrome, receivedAtMs: T });
    ok('an unknown trigger or cache state is stored as unknown, an unknown result as an error',
        odd.started_by === 'unknown' && odd.cache_state === 'unknown' && odd.result === 'error', odd);
    ok('absurd numbers are clamped, negatives and non-booleans become "not reported"',
        odd.systems_total === 100000 && odd.tab_age_s === 0 && odd.hidden_at_start === null, odd);
    ok('an unreadable Date header means no lag figure, not a made-up one', odd.date_lag_s === null, odd.date_lag_s);
    ok('with nothing reported the optional fields are null, not zero',
        sanitizeScanRun({ run_id: body.run_id }, {}).fetch_ms === null && sanitizeScanRun({ run_id: body.run_id }, {}).headers_json === null);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
