// The inbound half of hub-to-hub sharing: read each partner hub's feed with the token
// they gave us, and keep what arrives in peer_intel. See docs/peer-sharing.md.
//
// Everything a partner sends is untrusted input. A page is reduced to the kinds and fields
// peer-kinds.js knows, timestamps must look like timestamps and not sit in the future, and
// sizes are capped — a partner can send us nonsense, but not more than a bounded amount of
// it, and nothing outside the shape we store.
//
// This never talks to the game. A partner's address is refused if it points at the game's
// own host (see validateBaseUrl), so a mistyped or malicious source cannot turn this
// scheduler into unsanctioned automated traffic against astrowars.
const peersRepo = require('../repositories/peers');
const { KINDS, shape } = require('./peer-kinds');

// What we read from partners. Only player intelligence reports for now: they are all the
// hub shows (the profile's Hub Intel card), and pulling the rest would store data nobody
// sees. A partner may offer more; it is not requested.
const PULL_KINDS = ['players'];

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const KEY_RE = /^\d{1,15}$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGES_PER_KIND = 40;           // 40 × 500 rows per pull is plenty to catch up
const FETCH_TIMEOUT_MS = 20000;
const FUTURE_SLACK_MS = 60 * 60 * 1000;  // clocks drift; a day-ahead timestamp is a lie

function gameHosts() {
    const hosts = new Set(['astrowars.games']);
    try { hosts.add(new URL(process.env.TARGET_URL || 'https://astrowars.games').hostname.toLowerCase()); } catch (e) { /* default stays */ }
    return hosts;
}

// Normalise and vet a partner hub's address. Returns { url } or { error }.
function validateBaseUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch (e) { return { error: 'Not a valid URL' }; }
    const allowHttp = /^(1|true|on)$/i.test(process.env.PEER_ALLOW_HTTP || '');
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
        return { error: 'The partner hub must be reached over https://' };
    }
    if (u.username || u.password) return { error: 'Put the token in the token field, not in the URL' };
    const host = u.hostname.toLowerCase();
    for (const g of gameHosts()) {
        if (host === g || host.endsWith('.' + g)) return { error: 'That is the game, not a partner hub' };
    }
    return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

function tsMs(ts) { return Date.parse(ts.replace(' ', 'T') + 'Z'); }

// Reduce one received page to what we are willing to store. Never throws on bad items —
// they are dropped and counted — but a page that is not a page at all is an error.
function validatePage(kind, body, now = Date.now()) {
    if (!KINDS[kind]) return { error: 'unknown kind' };
    if (!body || typeof body !== 'object' || body.kind !== kind || !Array.isArray(body.items)) {
        return { error: 'malformed page' };
    }
    const items = [];
    let dropped = 0;
    for (const it of body.items.slice(0, 1000)) {
        const ok = it && typeof it === 'object'
            && typeof it.key === 'string' && KEY_RE.test(it.key)
            && typeof it.changedAt === 'string' && TS_RE.test(it.changedAt)
            && tsMs(it.changedAt) <= now + FUTURE_SLACK_MS;
        const data = ok ? shape(kind, it.data) : null;
        if (!data) { dropped++; continue; }
        items.push({ key: it.key, changedAt: it.changedAt, data });
    }
    const next = typeof body.next === 'string' && /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|\d{1,15}$/.test(body.next) ? body.next : null;
    return { items, dropped, next, more: body.more === true };
}

// Read at most MAX_BODY_BYTES, stopping the download as soon as it goes over rather than
// buffering whatever a partner chooses to send.
async function readCapped(res) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const t = await res.text();
        if (Buffer.byteLength(t) > MAX_BODY_BYTES) throw new Error('response too large');
        return t;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('response too large'); }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function getJson(url, token, fetchImpl) {
    const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await readCapped(res);
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* reported below */ }
    if (!res.ok) throw new Error(`HTTP ${res.status}${body && body.error ? `: ${body.error}` : ''}`);
    if (!body) throw new Error('response was not JSON');
    return body;
}

// Pull everything new from one source. Returns { ok, received, dropped, error? }.
async function pullSource(sourceId, { fetchImpl = globalThis.fetch } = {}) {
    const src = peersRepo.getSource(sourceId, { withToken: true });
    if (!src) return { ok: false, error: 'no such source' };
    let received = 0, dropped = 0, offered = null;
    try {
        const hello = await getJson(`${src.baseUrl}/peer-api/v1/hello`, src.token, fetchImpl);
        offered = Array.isArray(hello.kinds) ? hello.kinds.filter(k => KINDS[k]) : [];
        for (const kind of offered.filter(k => PULL_KINDS.includes(k))) {
            let cursor = src.cursors[kind] || '';
            for (let page = 0; page < MAX_PAGES_PER_KIND; page++) {
                const body = await getJson(
                    `${src.baseUrl}/peer-api/v1/feed?kind=${encodeURIComponent(kind)}&after=${encodeURIComponent(cursor)}`,
                    src.token, fetchImpl);
                const v = validatePage(kind, body);
                if (v.error) throw new Error(`${kind}: ${v.error}`);
                dropped += v.dropped;
                // A profile without an intelligence report is not what we read partners for.
                const items = kind === 'players' ? v.items.filter(it => it.data.has_intel === 1) : v.items;
                received += peersRepo.storePage(src.id, kind, items, v.next);
                // Stop when the partner says so, or when its cursor stops moving — a
                // partner that keeps answering "more" with the same cursor would
                // otherwise loop us forever.
                if (!v.more || !v.next || v.next === cursor) break;
                cursor = v.next;
            }
        }
        peersRepo.recordPull(src.id, { ok: true, received, offeredKinds: offered });
        return { ok: true, received, dropped, kinds: offered };
    } catch (err) {
        const error = err && err.name === 'TimeoutError' ? 'timed out' : (err && err.message) || String(err);
        peersRepo.recordPull(src.id, { ok: false, error, received, offeredKinds: offered });
        return { ok: false, received, dropped, error };
    }
}

let running = false;
async function pullAll(opts) {
    if (running) return { skipped: true };
    running = true;
    try {
        const results = {};
        for (const s of peersRepo.listSources()) {
            if (s.enabled) results[s.id] = await pullSource(s.id, opts);
        }
        peersRepo.pruneIntel();
        return results;
    } finally {
        running = false;
    }
}

// PEER_PULL_MINUTES: how often to read partners. Blank = 5. 0 = never automatically
// (the admin page's "Pull now" still works).
function startPeerPullScheduler() {
    const raw = process.env.PEER_PULL_MINUTES;
    const minutes = raw === undefined || raw === '' ? 5 : Number(raw);
    if (!(minutes > 0)) return null;
    const tick = () => pullAll().then(r => {
        for (const [id, x] of Object.entries(r || {})) {
            if (x && !x.ok) console.warn(`[Peers] Pull from source ${id} failed: ${x.error}`);
        }
    }).catch(err => console.error('[Peers] Pull failed:', err.message));
    setTimeout(tick, 30 * 1000).unref();
    return setInterval(tick, Math.max(1, minutes) * 60 * 1000).unref();
}

module.exports = { validateBaseUrl, validatePage, pullSource, pullAll, startPeerPullScheduler, PULL_KINDS };
