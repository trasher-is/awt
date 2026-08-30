// SQLite's CURRENT_TIMESTAMP (and anything stored in that same "YYYY-MM-DD HH:MM:SS" shape)
// is UTC but carries no timezone marker. `new Date("2026-08-30 17:50:03")` parses that as
// LOCAL time in every browser, silently shifting the display by the viewer's UTC offset —
// which is exactly backwards from what a "when did this happen" timestamp should do.
// Every UI surface that renders one of these must go through this parser first, never
// `new Date(ts)` directly, or the browser-local time it prints will be wrong.
//
// LOADING: written so that ONE file serves both runtimes without a build step, same
// pattern as travel-model.js/aw-api.js.
//   • Node:    require('../../public/js/utils/sqlite-time.js')
//   • Browser: import '../utils/sqlite-time.js';  then read globalThis.AWSqliteTime
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWSqliteTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function parseSqliteUtc(ts) {
        if (!ts) return null;
        const d = new Date(String(ts).replace(' ', 'T') + 'Z');
        return isNaN(d.getTime()) ? null : d;
    }

    // Common case: format straight to the viewer's local time, or a fallback string when
    // the value is missing/unparseable (never "Invalid Date").
    function formatSqliteUtc(ts, opts, fallback) {
        if (fallback === undefined) fallback = '—';
        const d = parseSqliteUtc(ts);
        return d ? d.toLocaleString(undefined, opts) : fallback;
    }

    return { parseSqliteUtc, formatSqliteUtc };
});
