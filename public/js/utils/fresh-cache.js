// A cache that knows how old it is, and what it does not know.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// The route planner kept its systems and players lists in module-level variables,
// forever. Open the planner against an empty database and it cached []; a galaxy or
// player sync a minute later changed nothing until the whole dashboard was reloaded,
// because no further request was ever issued after the first successful one. A failed
// load was worse: it fell back to [] as well, and [] looked exactly like "the database
// really is empty" (issue #133).
//
// This gives a value a lifetime and a shape:
//   • a non-empty result is fresh for `ttlMs` and then fetched again on the next ask —
//     a bounded freshness policy, not a refetch per keystroke;
//   • an EMPTY result is fresh only for `emptyTtlMs`, because "nothing here yet" is the
//     state most likely to change under a sync;
//   • a FAILED load keeps whatever was cached before, records the error so the caller
//     can offer a retry, and waits `errorRetryMs` before trying again on its own;
//   • concurrent asks share one in-flight load; `invalidate()` and `{ force: true }`
//     skip the wait.
//
// LOADING: same dual Node/browser pattern as travel-model.js/sqlite-time.js.
//   • Node:    require('../../public/js/utils/fresh-cache.js')
//   • Browser: import '../utils/fresh-cache.js'; then read globalThis.AWFreshCache
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWFreshCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULTS = {
        ttlMs: 60 * 1000,        // a full list is trusted for a minute
        emptyTtlMs: 5 * 1000,    // an empty one only briefly — a sync may be landing
        errorRetryMs: 5 * 1000,  // after a failure, do not hammer the server
    };

    function defaultIsEmpty(value) {
        if (value == null) return true;
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'object') return Object.keys(value).length === 0;
        return false;
    }

    /**
     * @param {object} [options]
     * @param {number} [options.ttlMs]
     * @param {number} [options.emptyTtlMs]
     * @param {number} [options.errorRetryMs]
     * @param {() => number} [options.now]   injectable clock, for tests
     * @param {(value) => boolean} [options.isEmpty]
     */
    function createFreshCache(options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
        const isEmpty = typeof opts.isEmpty === 'function' ? opts.isEmpty : defaultIsEmpty;

        let value;                 // last successful result (undefined = never loaded)
        let fetchedAt = null;      // when `value` was loaded
        let lastError = null;      // Error from the most recent failed load, or null
        let erroredAt = null;
        let inFlight = null;       // Promise of the load currently running, or null

        function hasValue() { return fetchedAt !== null; }

        function isFresh(at) {
            if (!hasValue()) return false;
            const ttl = isEmpty(value) ? opts.emptyTtlMs : opts.ttlMs;
            return (at - fetchedAt) < ttl;
        }

        function inErrorBackoff(at) {
            return lastError !== null && erroredAt !== null && (at - erroredAt) < opts.errorRetryMs;
        }

        function snapshot(at, fromCache) {
            return {
                data: hasValue() ? value : null,
                error: lastError,
                fromCache,
                stale: hasValue() && !isFresh(at),
                ageMs: hasValue() ? at - fetchedAt : null,
                loaded: hasValue(),
            };
        }

        /**
         * @param {() => Promise<any>} loader
         * @param {{ force?: boolean }} [o]
         * @returns {Promise<{data, error, fromCache, stale, ageMs, loaded}>}
         */
        async function get(loader, o) {
            const force = !!(o && o.force);
            const at = now();

            if (!force) {
                if (isFresh(at)) return snapshot(at, true);
                // A recent failure: answer with what we have (possibly nothing) and the
                // error, instead of retrying on every keystroke.
                if (inErrorBackoff(at)) return snapshot(at, true);
            }

            if (inFlight) return inFlight;

            inFlight = (async () => {
                try {
                    const result = await loader();
                    value = result;
                    fetchedAt = now();
                    lastError = null;
                    erroredAt = null;
                    return snapshot(fetchedAt, false);
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    erroredAt = now();
                    // Previously cached data survives a failed refresh — it is still the
                    // best answer available, just flagged.
                    return snapshot(erroredAt, hasValue());
                } finally {
                    inFlight = null;
                }
            })();
            return inFlight;
        }

        // Next get() loads, whatever the age. Cached data stays readable meanwhile.
        function invalidate() {
            fetchedAt = hasValue() ? -Infinity : null;
            lastError = null;
            erroredAt = null;
            if (fetchedAt === null) value = undefined;
        }

        function peek() { return snapshot(now(), true); }

        return { get, invalidate, peek, options: opts };
    }

    return { createFreshCache, defaultIsEmpty, DEFAULTS };
});
