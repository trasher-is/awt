// Server-side floor under the five-requests-per-second agreement with the game's
// administrator.
//
// ─── WHY A SECOND COPY OF THE SAME LIMIT ──────────────────────────────────────
// public/js/utils/game-rate-limit.js gates the browser side. It is necessary and it is
// not sufficient, because it is code running in the member's own browser:
//
//   • it is per-origin state, so it depends on localStorage being available
//   • an old tab left open from before a deploy runs the previous version
//   • anything typed into a console, or any file that forgets to use gameFetch, walks
//     straight past it
//
// Every one of those requests still has to come through this server: the scrapers fetch
// relative paths (/Game/..., /Info/..., /Ranking/..., /About/...) on the hub's own origin,
// which server.js hands to the proxy. So the hub is the one place where the promise can
// actually be kept, and this is that place.
//
// ─── WHAT COUNTS ──────────────────────────────────────────────────────────────
// Only tool-generated requests. A member browsing the game inside the iframe pulls dozens
// of assets per page; capping that at five per second would make the game unusable and
// would not be honouring the agreement, it would be misreading it. gameFetch marks its
// requests with X-AWT-Automated: 1 and this gate counts those.
//
// The marker is trivially forgeable. That is fine and it is the point: the party bound by
// the agreement is the member whose browser is sending the requests, so this is an
// operations control that keeps honest code honest, not a security boundary. What catches
// a *dishonest* or broken client is the coarse ceiling server.js puts on all proxied
// traffic, and the unmarkedXhr counter below, which reports fetch/XHR traffic to the game
// that arrived without a marker so it can be found rather than guessed at.
//
// ─── WHAT HAPPENS AT THE LIMIT ────────────────────────────────────────────────
// The request WAITS instead of failing. A scan that runs slightly slower is invisible; a
// scan that dies half way through loses intel. Only when the wait would exceed maxWaitMs,
// or too many are already waiting, does it answer 429 — at which point something is
// genuinely wrong and failing loudly beats queueing forever.

const WINDOW_MS = 1000;

function gameTrafficGate({
    maxPerSecond = 5,
    maxWaitMs = 8000,
    maxWaiting = 40,
    keyOf = req => (req.session && req.session.userId) || req.ip || 'anonymous',
    isAutomated = req => req.headers['x-awt-automated'] === '1',
    isXhr = req => req.headers['sec-fetch-dest'] === 'empty',
} = {}) {
    const buckets = new Map();   // key -> { recent: number[], waiting: number, lastSeen: number }

    const counters = {
        admitted: 0,
        delayed: 0,
        rejected: 0,
        // Requests that look like fetch/XHR to the game but carried no marker: either a
        // caller that bypassed gameFetch, or the game's own page scripts. Reported rather
        // than throttled, because throttling the game's own AJAX would break the UI it
        // belongs to and we do not know yet which of the two this is.
        unmarkedXhr: 0,
        maxObservedPerSecond: 0,
    };

    // Buckets for members who stopped scanning must not accumulate forever.
    const sweeper = setInterval(() => {
        const cutoff = Date.now() - 60 * 1000;
        for (const [key, bucket] of buckets) {
            if (bucket.waiting === 0 && bucket.lastSeen < cutoff) buckets.delete(key);
        }
    }, 60 * 1000);
    if (typeof sweeper.unref === 'function') sweeper.unref();

    function bucketFor(key) {
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { recent: [], waiting: 0, lastSeen: 0 };
            buckets.set(key, bucket);
        }
        return bucket;
    }

    // Strictly older than the window — the same closed-window rule the browser-side gate
    // uses, and for the same reason: dropping an entry that is exactly WINDOW_MS old makes
    // the window half-open and lets two bursts 999 ms apart both count as legal.
    function prune(bucket, t) {
        const cutoff = t - WINDOW_MS;
        while (bucket.recent.length && bucket.recent[0] < cutoff) bucket.recent.shift();
    }

    function middleware(req, res, next) {
        if (!(maxPerSecond > 0)) return next();   // maxPerSecond=0 disables the gate

        if (!isAutomated(req)) {
            if (isXhr(req)) counters.unmarkedXhr++;
            return next();
        }

        const key = keyOf(req);
        const bucket = bucketFor(key);
        bucket.lastSeen = Date.now();

        if (bucket.waiting >= maxWaiting) {
            counters.rejected++;
            res.setHeader('Retry-After', '1');
            return res.status(429).json({
                error: `Too many queued game requests (${maxWaiting}). The tool is limited to ${maxPerSecond} requests per second by agreement with the game administrator.`,
            });
        }

        const startedAt = Date.now();
        let timer = null;
        let settled = false;
        let counted = false;   // `delayed` counts requests that had to wait, not wait cycles

        // A member who closes the tab or cancels a scan must not keep a slot reserved.
        const abandon = () => {
            if (settled) return;
            settled = true;
            bucket.waiting--;
            if (timer) clearTimeout(timer);
        };
        res.on('close', abandon);

        const attempt = () => {
            if (settled) return;
            const t = Date.now();
            prune(bucket, t);

            if (bucket.recent.length < maxPerSecond) {
                settled = true;
                bucket.waiting--;
                bucket.recent.push(t);
                bucket.lastSeen = t;
                counters.admitted++;
                counters.maxObservedPerSecond = Math.max(counters.maxObservedPerSecond, bucket.recent.length);
                return next();
            }

            const wait = bucket.recent[0] + WINDOW_MS - t + 1;
            if (t - startedAt + wait > maxWaitMs) {
                settled = true;
                bucket.waiting--;
                counters.rejected++;
                res.setHeader('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
                return res.status(429).json({
                    error: `Game request queue is backed up beyond ${maxWaitMs} ms. The tool is limited to ${maxPerSecond} requests per second by agreement with the game administrator.`,
                });
            }

            if (!counted) { counters.delayed++; counted = true; }
            timer = setTimeout(attempt, wait);
        };

        bucket.waiting++;
        attempt();
    }

    middleware.snapshot = () => ({
        ...counters,
        limit: maxPerSecond,
        buckets: buckets.size,
        waiting: [...buckets.values()].reduce((n, b) => n + b.waiting, 0),
    });

    // Tests only: drop all state so one process can exercise several scenarios.
    middleware.reset = () => {
        buckets.clear();
        Object.assign(counters, { admitted: 0, delayed: 0, rejected: 0, unmarkedXhr: 0, maxObservedPerSecond: 0 });
    };

    return middleware;
}

module.exports = { gameTrafficGate, WINDOW_MS };
