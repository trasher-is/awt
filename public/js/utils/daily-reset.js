// The next occurrence of "N minutes after the game's daily reset" — 00:00 Europe/Berlin
// (matches !dist's CET/CEST assumption and page-injections.js's nextPLUpdate, which
// already uses this exact zone for the twice-daily PL growth tick). Europe/Berlin
// auto-shifts UTC+1/+2 across the DST boundary, so this never needs a manual switch.
//
// Why this exists (2026-09-12): several background syncs (galaxy seed, battle reports)
// used to poll every few minutes all day, on the mistaken assumption that out-of-vision
// map data and the battle-report list refresh continuously. In production they don't --
// confirmed against how the game actually behaves: the whole galaxy (outside your own
// bio-range vision, see vision-model.js) only gets a fresh snapshot once a day, at the
// 00:00 CET/CEST reset, and battle reports are likewise only posted once a day at that
// same reset. Polling every few minutes the rest of the day just re-reads the same
// snapshot and burns API budget for nothing -- the real fix is to pull once, shortly
// after the reset actually lands, not to poll faster.
//
// LOADING: same dual Node/browser pattern as capture-freshness.js/sqlite-time.js.
//   • Node:    require('../../public/js/utils/daily-reset.js')
//   • Browser: import '../utils/daily-reset.js'; then read globalThis.AWDailyReset
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWDailyReset = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function berlinParts(now) {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(now);
        const get = t => parseInt(parts.find(p => p.type === t).value, 10);
        return { hour: get('hour') % 24, minute: get('minute'), second: get('second') };
    }

    // Returns a Date: the next moment that is `bufferMinutes` minutes after 00:00
    // Europe/Berlin. If `now` is already past today's window, that's tomorrow's.
    function nextDailyWindow(bufferMinutes, now) {
        const nowDate = now === undefined ? new Date() : now;
        const { hour, minute, second } = berlinParts(nowDate);
        const secsSinceMidnight = hour * 3600 + minute * 60 + second;
        const targetSecs = bufferMinutes * 60;
        const secsToNext = secsSinceMidnight < targetSecs
            ? (targetSecs - secsSinceMidnight)
            : (86400 - secsSinceMidnight + targetSecs);
        return new Date(nowDate.getTime() + secsToNext * 1000);
    }

    // The current Europe/Berlin calendar date as a sortable "YYYY-MM-DD" string -- used to
    // remember "have we already run today's window", independent of the viewer's own
    // timezone and stable across a page reload (unlike a plain setInterval/setTimeout).
    function berlinDateKey(now) {
        const nowDate = now === undefined ? new Date() : now;
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(nowDate);
        const get = t => parts.find(p => p.type === t).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
    }

    return { nextDailyWindow, berlinDateKey };
});
