// What the hub keeps about each galaxy scan (galaxy_scan_runs) and how it vets what a client sends.
//
// Why: the hub could not say who ran a scan, when, or whether the data it carried was old. Two hubs
// then recorded phantom population drops (a read showing a planet one level low right after a growth
// tick) with no way to tell WHY a read was stale. The candidates are different and testable:
//   • the browser's HTTP cache answered         -> cache_state 'cache' / 'revalidated'
//   • a cache between the browser and the game  -> an Age header, or a Date older than the request
//   • the data was fine but posted late         -> a large fetch_age_ms on the system payloads
//   • the tab was throttled or hidden mid-run   -> went_hidden, a long duration
//   • the first scan after the tab opened       -> run_index 0, small tab_age_s
// Each scan therefore reports one summary row, and every /sync/system payload it sends carries the
// run id and the age of its data, so a trace row can be joined to the scan that produced it.
//
// The client is untrusted (a modified build can send anything): every field is clamped, strings are
// cut, and headers are filtered to a short list that can never carry a credential.

const HEADER_WHITELIST = ['date', 'age', 'cache-control', 'etag', 'last-modified', 'expires', 'via',
    'x-cache', 'cf-cache-status', 'server', 'content-encoding', 'content-length', 'vary'];
const TRIGGERS = new Set(['auto', 'manual']);
const CACHE_STATES = new Set(['network', 'cache', 'revalidated', 'unknown']);
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const int = (v, min, max) => {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.round(n)));
};
const flag = v => (v === true || v === 1 ? 1 : (v === false || v === 0 ? 0 : null));
const text = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

function sanitizeRunId(v) {
    return typeof v === 'string' && RUN_ID.test(v) ? v : null;
}

// How old a payload's data was when it was posted, in ms. A negative or non-numeric value is a
// client clock bug, not an age: it is "not reported", never clamped into a plausible-looking 0.
function sanitizeAgeMs(v) {
    return Number(v) >= 0 ? int(v, 0, MAX_AGE_MS) : null;
}

// A coarse browser family from the User-Agent the server already receives. Enough to ask "is this a
// Firefox thing?" without keeping the string itself.
function browserFamily(userAgent) {
    const ua = typeof userAgent === 'string' ? userAgent : '';
    const mobile = /Mobi|Android|iPhone|iPad/i.test(ua) ? 1 : 0;
    let browser = 'other';
    if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'opera';
    else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'firefox';
    else if (/Chrome\/|CriOS\//.test(ua)) browser = 'chrome';
    else if (/Safari\//.test(ua)) browser = 'safari';
    return { browser, mobile };
}

// "Sat, 03 Oct 2026 04:47:21 GMT" -> ms, or null.
function parseHttpDate(value) {
    if (typeof value !== 'string') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function pickHeaders(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const name of HEADER_WHITELIST) {
        const v = raw[name];
        if (typeof v === 'string' && v) out[name] = v.slice(0, 200);
    }
    return out;
}

// body: what the client POSTed. Returns the row to store, or null when there is no usable run id.
// receivedAtMs is the server's clock at receipt. The client reports how long ago its response ended
// (fetched_ago_ms, a duration, so its own clock never matters); subtracting that from receipt gives
// the server-time moment the game answered, and the gap to the response's Date header is date_lag_s:
// how old the game's own copy already was.
function sanitizeScanRun(body, { userAgent, receivedAtMs = Date.now() } = {}) {
    if (!body || typeof body !== 'object') return null;
    const runId = sanitizeRunId(body.run_id);
    if (!runId) return null;

    const headers = pickHeaders(body.headers);
    const fetchedAgoMs = sanitizeAgeMs(body.fetched_ago_ms);
    const dateMs = parseHttpDate(headers.date);
    const dateLagS = dateMs !== null && fetchedAgoMs !== null
        ? Math.round(((receivedAtMs - fetchedAgoMs - dateMs) / 1000) * 10) / 10
        : null;
    const { browser, mobile } = browserFamily(userAgent);

    return {
        run_id: runId,
        started_by: TRIGGERS.has(body.trigger) ? body.trigger : 'unknown',
        result: body.result === 'ok' ? 'ok' : 'error',
        error: text(body.error, 200),
        browser, mobile,
        tab_age_s: int(body.tab_age_s, 0, 30 * 24 * 3600),
        run_index: int(body.run_index, 0, 1e6),
        hidden_at_start: flag(body.hidden_at_start),
        went_hidden: flag(body.went_hidden),
        systems_total: int(body.systems_total, 0, 100000),
        systems_posted: int(body.systems_posted, 0, 100000),
        planets_posted: int(body.planets_posted, 0, 1000000),
        in_vision: int(body.in_vision, 0, 100000),
        duration_ms: int(body.duration_ms, 0, MAX_AGE_MS),
        fetch_ms: int(body.fetch_ms, 0, MAX_AGE_MS),
        post_ms_avg: int(body.post_ms_avg, 0, MAX_AGE_MS),
        post_ms_max: int(body.post_ms_max, 0, MAX_AGE_MS),
        response_status: int(body.response_status, 0, 999),
        cache_state: CACHE_STATES.has(body.cache_state) ? body.cache_state : 'unknown',
        transfer_size: int(body.transfer_size, 0, 1e10),
        encoded_body_size: int(body.encoded_body_size, 0, 1e10),
        delivery_type: text(body.delivery_type, 30),
        date_lag_s: dateLagS,
        headers_json: Object.keys(headers).length ? JSON.stringify(headers) : null,
    };
}

module.exports = { sanitizeScanRun, sanitizeRunId, sanitizeAgeMs, browserFamily, parseHttpDate, pickHeaders, HEADER_WHITELIST };
