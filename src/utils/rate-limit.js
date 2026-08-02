// Minimal in-process rate limiter. Deliberately dependency-free: the hub runs as a
// single pm2 process, so an in-memory counter is enough and adding express-rate-limit
// would mean a native-free but still extra install on the server.
//
// Caveat if this ever runs clustered: each worker keeps its own window, so the
// effective limit becomes max*workers. Swap in a shared store before scaling out.
//
// Keys on req.ip by default, which is only meaningful because server.js sets
// `trust proxy` — behind a TLS terminator every request would otherwise carry the proxy's
// address and all users would share one bucket.
//
// Pass `keyOf` to bucket by something else. The proxy ceiling keys on the session instead,
// because several alliance members behind one home connection share an address and must
// not throttle each other, while one member with four tabs open is still one member.

function rateLimit({ windowMs, max, message = 'Too many requests. Please slow down.', keyOf = null }) {
    const buckets = new Map(); // key -> { count, resetAt }

    // Drop expired buckets so the map cannot grow unbounded from one-off IPs.
    // unref() keeps this timer from holding the process open during shutdown.
    setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= now) buckets.delete(key);
        }
    }, windowMs).unref();

    return function rateLimitMiddleware(req, res, next) {
        if (!(max > 0)) return next(); // max=0 disables the limiter via config

        const key = (keyOf ? keyOf(req) : req.ip) || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.count += 1;

        if (bucket.count > max) {
            const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({ error: message, retryAfter });
        }

        return next();
    };
}

module.exports = { rateLimit };
