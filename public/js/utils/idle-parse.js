// Parses the game's "Idle" duration string ("3h 10m", "2d 5h", "Active", "Online") into
// seconds. Shared between the display layer (stat-columns.js's idle badges) and the
// scrapers that turn it into an actual last_activity_at timestamp (player-parser.js) —
// one parser, not two copies that can drift (2026-09-12: extracted from stat-columns.js,
// which used to be the only place this logic lived).
//
// LOADING: same dual Node/browser pattern as capture-freshness.js/daily-reset.js.
//   • Node:    require('../../public/js/utils/idle-parse.js')
//   • Browser: import '../utils/idle-parse.js'; then read globalThis.AWIdleParse
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWIdleParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // -1 means "not a parseable duration" (unknown/empty). 0 means "active right now".
    function parseIdleStringToSeconds(idleStr) {
        if (!idleStr || idleStr === 'Unknown') return -1;
        if (/active|online/i.test(idleStr)) return 0;
        let secs = 0;
        const d = idleStr.match(/(\d+)\s*d/);
        const h = idleStr.match(/(\d+)\s*h/);
        const m = idleStr.match(/(\d+)\s*m/);
        const s = idleStr.match(/(\d+)\s*s/);
        if (!d && !h && !m && !s) return -1;
        if (d) secs += parseInt(d[1], 10) * 86400;
        if (h) secs += parseInt(h[1], 10) * 3600;
        if (m) secs += parseInt(m[1], 10) * 60;
        if (s) secs += parseInt(s[1], 10);
        return secs;
    }

    return { parseIdleStringToSeconds };
});
