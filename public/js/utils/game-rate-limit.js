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
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWGameRate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MAX_PER_SECOND = 5;
    const WINDOW_MS = 1000;

    // Start times of the requests inside the current rolling window.
    let recent = [];
    const queue = [];
    let draining = false;

    const stats = {
        sent: 0,
        queued: 0,
        maxQueueDepth: 0,
        maxObservedPerSecond: 0,
        firstAt: null,
        lastAt: null,
    };

    const now = () => Date.now();

    // Strictly older than the window, not "as old as". Dropping an entry that is exactly
    // WINDOW_MS old makes the window half-open — (t-1000, t] — and combined with the way
    // setTimeout can fire a hair early, that let two bursts land 999 ms apart and put TEN
    // requests inside one real second. Found by the test in src/utils/game-rate-limit.test.js,
    // which measures closed [t, t+1000) windows the way an observer on the other end would.
    function prune(t) {
        const cutoff = t - WINDOW_MS;
        while (recent.length && recent[0] < cutoff) recent.shift();
    }

    // Milliseconds until a slot frees up; 0 when one is available right now.
    // The extra millisecond is deliberate: timers are allowed to fire early, and being
    // one millisecond slow than the agreement is free while being early is a breach.
    function waitFor(t) {
        prune(t);
        if (recent.length < MAX_PER_SECOND) return 0;
        return recent[0] + WINDOW_MS - t + 1;
    }

    function drain() {
        if (draining) return;
        draining = true;
        const step = () => {
            if (queue.length === 0) { draining = false; return; }
            const t = now();
            const wait = waitFor(t);
            if (wait > 0) { setTimeout(step, wait); return; }

            const job = queue.shift();
            recent.push(t);
            stats.sent++;
            stats.firstAt = stats.firstAt == null ? t : stats.firstAt;
            stats.lastAt = t;
            prune(t);
            stats.maxObservedPerSecond = Math.max(stats.maxObservedPerSecond, recent.length);

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
    function gameFetch(input, init) {
        return schedule(() => fetch(input, init));
    }

    function snapshot() {
        // Deliberately no "average per second": averaging between the first and last
        // start time reads above the cap for a bursty-but-legal pattern (five at once,
        // then a pause), which would look like a violation that never happened. The
        // number that matters is the worst rolling window, and that is maxObservedPerSecond.
        return {
            ...stats,
            limit: MAX_PER_SECOND,
            pending: queue.length,
            inCurrentWindow: (prune(now()), recent.length),
        };
    }

    function reset() {
        recent = [];
        queue.length = 0;
        draining = false;
        Object.assign(stats, { sent: 0, queued: 0, maxQueueDepth: 0, maxObservedPerSecond: 0, firstAt: null, lastAt: null });
    }

    return { gameFetch, schedule, snapshot, reset, MAX_PER_SECOND, WINDOW_MS };
});
