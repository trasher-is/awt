// Outbound request throttle for the GAME server.
//
// LOADING: no import/export statements — Node require()s it, the browser runs it as a
// side-effect module import with the API on globalThis. Same pattern as the other shared
// modules in this directory.
//   • Browser: import '../utils/game-rate-limit.js';  then globalThis.AWGameRate
//   • Node:    require('../../public/js/utils/game-rate-limit.js')   (for the tests)
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// The game's administrator permits this tool at most FIVE requests per second. That
// number was previously honoured only by four hand-placed `await sleep(200)` calls in
// mass-scanner.js, and not at all elsewhere:
//
//   • alliance-parser.js fetched every member page back to back with no delay, so an
//     alliance roster refresh went out as fast as the network allowed
//   • archives.js does the same for the war-room and alliance-stats scans
//   • the mass player scan makes TWO requests per player behind ONE 200 ms sleep, so it
//     could reach ten per second whenever latency was low
//
// A sleep between iterations is not a rate limit. It bounds one loop, it does not bound
// the process, and two loops running at once each get their own budget. This queue is a
// single shared gate: every request to the game goes through it, wherever it comes from,
// and the cap holds across all of them at once.
//
// The limit is a promise made to someone, not a performance tuning knob. Raising
// MAX_PER_SECOND needs their agreement, not a code review.
//
// ─── WHY THE WINDOW LIVES IN localStorage ─────────────────────────────────────
// The paragraph above used to be false in the one configuration this tool actually runs
// in. `recent` and `queue` are module state, and module state belongs to ONE JavaScript
// realm — but the hub always has two of them open at once:
//
//   • the dashboard document loads ui/dashboard.js -> ui/archives.js -> this file
//   • src/proxy.js injects /hub-assets/js/main.js into every proxied game page, and that
//     iframe loads core/spy.js, the scrapers -> this file AGAIN, as a second instance
//     with its own empty `recent` and its own `queue`
//
// Two instances, two budgets, ~10 requests per second out of one tab. Extra tabs add
// more. So the rolling window is kept in localStorage, which every same-origin document
// in the browser profile shares, and the reservation is written there before a request
// is allowed to start.
//
// The parent document and a same-origin iframe share one event loop, so the
// read-modify-write below cannot interleave between them. Separate tabs can be separate
// processes, so the write is followed by a re-read: if someone else's entry beat ours
// into the window we withdraw and wait instead of sending.
//
// If localStorage is unavailable (private mode, disabled, Node) the gate silently falls
// back to per-realm state — the behaviour this file already had. That is a degradation,
// not a hole: server.js runs the same cap again on the proxy, where every one of these
// requests has to pass through anyway.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWGameRate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MAX_PER_SECOND = 5;
    const WINDOW_MS = 1000;
    const SHARED_KEY = 'awt.gameRate.window.v1';

    // Start times of the requests inside the current rolling window. Used when no shared
    // store is reachable; otherwise the window lives in localStorage (see the header).
    let recent = [];
    const queue = [];
    let draining = false;

    // Identifies THIS realm's entries in the shared window. Two documents of the same
    // origin each evaluate this module once, so each gets its own token.
    const realmId = 'r' + Math.random().toString(36).slice(2, 10);
    let seq = 0;
    let sharedBroken = false;

    const stats = {
        sent: 0,
        queued: 0,
        maxQueueDepth: 0,
        maxObservedPerSecond: 0,
        firstAt: null,
        lastAt: null,
    };

    const now = () => Date.now();

    // Resolved on every call rather than once at load: a test installs a fake store after
    // requiring the module, and a browser can revoke storage access mid-session.
    function store() {
        if (sharedBroken) return null;
        try {
            const s = globalThis.localStorage;
            if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') return s;
        } catch (err) {
            // Accessing localStorage throws outright when storage is blocked by policy.
            sharedBroken = true;
        }
        return null;
    }

    // Entries are [startedAt, id]; ordering by start time, then id, gives every realm the
    // same total order over the same data.
    const byStart = (a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

    function readShared(s, t) {
        let parsed;
        try {
            parsed = JSON.parse(s.getItem(SHARED_KEY) || '[]');
        } catch (err) {
            parsed = [];   // someone else wrote garbage under our key; start over
        }
        if (!Array.isArray(parsed)) parsed = [];
        const cutoff = t - WINDOW_MS;
        return parsed
            .filter(e => Array.isArray(e) && typeof e[0] === 'number' && e[0] >= cutoff)
            .sort(byStart);
    }

    function writeShared(s, entries) {
        try {
            s.setItem(SHARED_KEY, JSON.stringify(entries));
            return true;
        } catch (err) {
            // Quota exhausted or storage turned read-only. Fall back for good rather than
            // throwing inside a scan.
            sharedBroken = true;
            return false;
        }
    }

    // Strictly older than the window, not "as old as". Dropping an entry that is exactly
    // WINDOW_MS old makes the window half-open — (t-1000, t] — and combined with the way
    // setTimeout can fire a hair early, that let two bursts land 999 ms apart and put TEN
    // requests inside one real second. Found by the test in src/utils/game-rate-limit.test.js,
    // which measures closed [t, t+1000) windows the way an observer on the other end would.
    function prune(t) {
        const cutoff = t - WINDOW_MS;
        while (recent.length && recent[0] < cutoff) recent.shift();
    }

    // Take a slot for a request starting now, or report how long to wait for one.
    // Returns { wait, inWindow }: wait === 0 means the slot is taken and the caller MUST
    // send. The extra millisecond on a wait is deliberate — timers are allowed to fire
    // early, and being a millisecond late is free while being early is a breach.
    function reserve(t) {
        const s = store();
        if (!s) {
            prune(t);
            if (recent.length < MAX_PER_SECOND) {
                recent.push(t);
                return { wait: 0, inWindow: recent.length };
            }
            return { wait: recent[0] + WINDOW_MS - t + 1, inWindow: recent.length };
        }

        const before = readShared(s, t);
        if (before.length >= MAX_PER_SECOND) {
            return { wait: before[0][0] + WINDOW_MS - t + 1, inWindow: before.length };
        }

        const id = realmId + ':' + (++seq);
        before.push([t, id]);
        before.sort(byStart);
        if (!writeShared(s, before)) return reserve(t);   // store just died; retry locally

        // Another tab may have written between our read and our write. Re-read and check
        // where we actually landed: at most MAX_PER_SECOND - 1 entries may precede us.
        const after = readShared(s, t);
        const idx = after.findIndex(e => e[1] === id);
        if (idx === -1) return { wait: 1, inWindow: after.length };     // our write was lost
        if (idx >= MAX_PER_SECOND) {
            writeShared(s, after.filter(e => e[1] !== id));             // withdraw and wait
            return { wait: after[0][0] + WINDOW_MS - t + 1, inWindow: after.length };
        }
        return { wait: 0, inWindow: after.length };
    }

    function drain() {
        if (draining) return;
        draining = true;
        const step = () => {
            if (queue.length === 0) { draining = false; return; }
            const t = now();
            const { wait, inWindow } = reserve(t);
            if (wait > 0) { setTimeout(step, wait); return; }

            const job = queue.shift();
            stats.sent++;
            stats.firstAt = stats.firstAt == null ? t : stats.firstAt;
            stats.lastAt = t;
            stats.maxObservedPerSecond = Math.max(stats.maxObservedPerSecond, inWindow);

            // Fire and immediately consider the next slot: the cap is on how often
            // requests START, not on how many are in flight.
            Promise.resolve()
                .then(job.run)
                .then(job.resolve, job.reject);

            step();
        };
        step();
    }

    /**
     * Queue a request against the game. Resolves with whatever `run` resolves to.
     * Order is preserved, so a scan still walks its list in sequence.
     */
    function schedule(run) {
        return new Promise((resolve, reject) => {
            queue.push({ run, resolve, reject });
            stats.queued++;
            stats.maxQueueDepth = Math.max(stats.maxQueueDepth, queue.length);
            drain();
        });
    }

    /**
     * Drop-in replacement for fetch() when the target is the game. Hub endpoints
     * (/hub-api, /hub-assets) must NOT go through here — they hit our own server and are
     * not covered by the agreement.
     */
    // Marks the request as tool-generated so the server-side gate in server.js can tell
    // our automation apart from the browser loading a page the member clicked on. It is
    // an operations signal, not a security boundary — the member's own browser sends it,
    // and the member is the party the agreement binds. src/proxy.js strips it before the
    // request leaves for the game.
    function withMarker(init) {
        try {
            const headers = new Headers((init && init.headers) || undefined);
            headers.set('X-AWT-Automated', '1');
            return Object.assign({}, init || {}, { headers });
        } catch (err) {
            // No Headers implementation, or headers in a shape it rejects. A missing
            // marker costs us a server-side count, never the request itself.
            return init;
        }
    }

    function gameFetch(input, init) {
        return schedule(() => fetch(input, withMarker(init)));
    }

    function snapshot() {
        // Deliberately no "average per second": averaging between the first and last
        // start time reads above the cap for a bursty-but-legal pattern (five at once,
        // then a pause), which would look like a violation that never happened. The
        // number that matters is the worst rolling window, and that is maxObservedPerSecond.
        const t = now();
        const s = store();
        return {
            ...stats,
            limit: MAX_PER_SECOND,
            pending: queue.length,
            inCurrentWindow: s ? readShared(s, t).length : (prune(t), recent.length),
            // false means this tab is counting on its own. Every other same-origin
            // document is then doing the same, and the real ceiling is whatever
            // server.js enforces on the proxy.
            shared: !!s,
        };
    }

    function reset() {
        recent = [];
        queue.length = 0;
        draining = false;
        const s = store();
        if (s) writeShared(s, []);
        Object.assign(stats, { sent: 0, queued: 0, maxQueueDepth: 0, maxObservedPerSecond: 0, firstAt: null, lastAt: null });
    }

    return { gameFetch, schedule, snapshot, reset, MAX_PER_SECOND, WINDOW_MS, SHARED_KEY };
});
