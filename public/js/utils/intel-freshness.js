// Is the intel we are looking at LIVE, and is what we have on record still current?
//
// Two questions the hub used to answer from "did a report arrive", which turned out to be
// the wrong signal for both.
//
// 1. WHICH INTEL TABLES ON A PROFILE PAGE ARE THE GAME'S OWN (2026-09-27). A pinned Player
//    Note can hold a pasted old intel report — a real <table class="ir-summary"> inside the
//    notes list's `.overflow-auto` scroll container. page-injections.js learned to ignore
//    those when deciding whether to show its "last known" card, but player-parser.js kept a
//    document-wide selector, so every scrape of such a profile (the mass scanner's included)
//    read the NOTE as live intel: has_intel = 1, the note's old sciences written over the
//    record, and intel_updated_at stamped "now". Confirmed on player 144, whose recorded
//    sciences sat far below his public science level. One rule, used by both, so the
//    card and the scraper can never again disagree about what is live.
//
// 2. HOW FAR BEHIND ARE THE SCIENCES WE HOLD. The game's public science level (API
//    `scienceLevel`, profile "Science Level") is the player's HIGHEST single science, and it
//    is always current. Intel sciences are a snapshot. So when the public level is above the
//    highest science on record, the record is behind by at least that many levels — whatever
//    made it stale, and whatever intel_updated_at says. Checked against production on
//    2026-09-27: 81 of 89 players with intel matched exactly; the mismatches were exactly
//    the stale records, plus rows whose public level was never synced (0).
//
// LOADING: dual-runtime, same pattern as max-combat-value.js.
//   • Node:    require('../../public/js/utils/intel-freshness.js')
//   • Browser: import '../utils/intel-freshness.js';  then read globalThis.AWIntelFreshness
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWIntelFreshness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Note bodies render inside a `.overflow-auto` scroll container that the game's live
    // top-of-page intel tables are never part of.
    function isGenuineLiveIntelTable(el) {
        return !el.closest('.overflow-auto');
    }

    function genuineLiveIntelTables(root, selector) {
        if (!root || typeof root.querySelectorAll !== 'function') return [];
        return [...root.querySelectorAll(selector)].filter(isGenuineLiveIntelTable);
    }

    const SCIENCES = ['biology', 'economy', 'energy', 'mathematics', 'physics', 'social'];

    // Levels the recorded sciences are behind the player's public science level: 0 when
    // they agree, a positive number when the record is stale, null when it cannot be told
    // (no intel, or no public level on record — 0 is what an unsynced row carries). A public
    // level BELOW the recorded maximum is not staleness and reads as 0.
    function scienceLag(row = {}) {
        if (!row.has_intel) return null;
        const publicLevel = Number(row.science_level);
        if (!Number.isFinite(publicLevel) || publicLevel <= 0) return null;
        const levels = SCIENCES.map(k => Number(row[k]));
        if (!levels.every(Number.isFinite)) return null;
        return Math.max(0, publicLevel - Math.max(...levels));
    }

    return { isGenuineLiveIntelTable, genuineLiveIntelTables, scienceLag, SCIENCES };
});
