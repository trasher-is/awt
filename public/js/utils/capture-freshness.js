// Whether a Map/sectors system capture is fresh enough to trust as a live reading.
//
// Real production bug (2026-08-31): the API can report isInVision:true for a system while
// still handing back a snapshot frozen at the last periodic capture, not a live read —
// confirmed live against a real response: capturedAt was exactly "...T00:00:00+02:00" (the
// daily reset boundary), 20+ hours stale, for a system the requesting account had no
// personal vision on but an ally did. isInVision means "the alliance has SOME record of
// this", not "this data is current" — trusting it alone let a stale midnight population
// value get written and compared against as if it were a fresh reading, logging a false
// population-drop history event.
//
// LOADING: same dual Node/browser pattern as travel-model.js/sqlite-time.js.
//   • Node:    require('../../public/js/utils/capture-freshness.js')
//   • Browser: import '../utils/capture-freshness.js'; then read globalThis.AWCaptureFreshness
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWCaptureFreshness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STALE_CAPTURE_MS = 3 * 60 * 60 * 1000; // 3 hours

    // A capture old enough to predate the last few hours should be routed through the SAME
    // fog-of-war guard as genuinely out-of-vision data, even when the API's own isInVision
    // flag says true.
    function isStaleCapture(capturedAt, now) {
        if (!capturedAt) return false; // no timestamp at all — nothing to distrust it by
        const capturedMs = Date.parse(capturedAt);
        const nowMs = now === undefined ? Date.now() : now;
        return Number.isFinite(capturedMs) && (nowMs - capturedMs) > STALE_CAPTURE_MS;
    }

    return { isStaleCapture, constants: { STALE_CAPTURE_MS } };
});
