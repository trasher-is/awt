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

    // Hub timestamps without a zone are UTC. Explicit ISO offsets already identify an
    // instant and must survive unchanged; adding a second Z makes them invalid. Do not
    // guess a locale-dependent date such as 09/10/2026 or a scraped countdown.
    function parseTimestamp(value) {
        if (value instanceof Date || typeof value === 'number') {
            const date = new Date(value instanceof Date ? value.getTime() : value);
            return Number.isFinite(date.getTime()) ? date : null;
        }
        if (typeof value !== 'string') return null;
        const text = value.trim();
        const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/i.exec(text);
        if (!parts) return null;
        const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', offset = 'Z'] = parts;
        const daysInMonth = new Date(Date.UTC(2000 + Number(year) % 400, Number(month), 0)).getUTCDate();
        if (+month < 1 || +month > 12 || +day < 1 || +day > daysInMonth || +hour > 23 || +minute > 59 || +second > 59) return null;
        const normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.slice(0, 3).padEnd(3, '0')}${offset.toUpperCase()}`;
        const date = new Date(normalized);
        return Number.isFinite(date.getTime()) ? date : null;
    }

    function parseSqliteUtc(ts) {
        return parseTimestamp(ts);
    }

    function localOptions(opts) {
        const options = { ...opts, hourCycle: 'h23' };
        // hour12 overrides hourCycle in Intl; hour12:false alone can render midnight
        // as 24:00 in en-US. h23 guarantees 00..23 in every browser locale.
        delete options.hour12;
        delete options.timeZone;
        return options;
    }

    function formatLocalDateTime(value, opts, fallback = '—') {
        const date = parseTimestamp(value);
        return date ? date.toLocaleString(undefined, localOptions(opts)) : fallback;
    }

    function formatLocalTime(value, opts, fallback = '—') {
        const date = parseTimestamp(value);
        return date ? date.toLocaleTimeString(undefined, localOptions(opts)) : fallback;
    }

    // Common case: format straight to the viewer's local time, or a fallback string when
    // the value is missing/unparseable (never "Invalid Date").
    function formatSqliteUtc(ts, opts, fallback) {
        return formatLocalDateTime(ts, opts, fallback);
    }

    return { parseTimestamp, parseSqliteUtc, formatLocalDateTime, formatLocalTime, formatSqliteUtc };
});
