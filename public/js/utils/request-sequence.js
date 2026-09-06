// Only the LATEST request for a panel may touch the panel.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// The sidebar search and the route-planner preview debounce the START of a request, but
// every response still wrote to the DOM when it arrived. Two requests in flight for the
// same box — the user typed again before the first answered — race, and the slower one
// wins the screen even when it is the OLDER one. Clearing the field while a request was
// pending repopulated it with obsolete results; in the planner, an ETA could be shown for
// parameters the member had already changed (issue #129).
//
// A sequencer hands out a token per request. Before rendering anything — results, an
// error, even a loading spinner — the caller asks whether its token is still the current
// one. Typing again, clearing the field or closing the panel moves the token on, and
// everything older becomes a no-op. Nothing is aborted: the fetch still completes, its
// result is simply not shown. The game request budget is untouched because no new
// requests are created here, and none are avoided either.
//
// LOADING: same dual Node/browser pattern as travel-model.js/sqlite-time.js.
//   • Node:    require('../../public/js/utils/request-sequence.js')
//   • Browser: import '../utils/request-sequence.js'; then read globalThis.AWRequestSeq
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWRequestSeq = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // One sequencer per independent surface: a results box, a preview pane, a dropdown.
    function createSequencer() {
        let current = 0;
        return {
            // A new request begins; whatever was pending is now stale.
            next() { current += 1; return current; },
            // May the holder of this token still render?
            isCurrent(token) { return token === current; },
            // Nothing pending may render (field cleared, panel closed). No new request.
            cancel() { current += 1; return current; },
            // For tests and debugging.
            get token() { return current; },
        };
    }

    // Independent sequencers by key — the three search types must not invalidate each
    // other, so a search for a player never hides the result of a search for a system.
    function createKeyedSequencers() {
        const map = new Map();
        return {
            for(key) {
                if (!map.has(key)) map.set(key, createSequencer());
                return map.get(key);
            },
            cancelAll() { for (const s of map.values()) s.cancel(); },
        };
    }

    return { createSequencer, createKeyedSequencers };
});
