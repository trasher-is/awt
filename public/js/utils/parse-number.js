// THE number parser. One copy, used by every caller in this repo.
//
// LOADING: no import/export statements, so Node require()s it as CommonJS and the browser
// runs it as a side-effect module import with the API on globalThis — the same trick
// battle-model.js and travel-model.js use. No build step.
//   • Node:    require('../../public/js/utils/parse-number.js')
//   • Browser: import '../utils/parse-number.js';  then globalThis.AWNumber
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// There were at least three incompatible parsers on the server and several more in the
// browser, and the same database column went through different ones depending on the
// code path:
//
//   trade.js       parseLocaleNumber  — locale-aware, correct
//   interceptors.js cleanInt          — strips . and ,  ->  "1.5" became 15
//   intel.js       toInt              — strips every non-digit  ->  "1,5" became 15
//
// astro_dollars and production_points were read by the first in one place and the second
// in another, so one row could yield two different numbers. Several browser regexes also
// omitted the NON-BREAKING SPACE the game uses as a thousands separator, which made
// ranking and points come back empty rather than wrong — silently.
//
// ─── THE RULE ─────────────────────────────────────────────────────────────────
// The game is localised (the fleet-arrival parser already notes Lithuanian, English,
// German, Finnish and Spanish), so a number can arrive as any of:
//
//   1,234.5     1.234,5     1 234,5     1 234.5 (NBSP)    1234      -1 234
//
// Disambiguation, in order:
//   • both separators present  -> the LAST one is the decimal point
//   • exactly one separator, with exactly three digits after it -> thousands, not decimal
//   • exactly one separator otherwise -> decimal point
//   • no separator -> plain integer
//
// That last rule is the one that matters: "1.234" is one thousand two hundred and
// thirty-four, while "1.5" is one and a half. Both appear in this game's output.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWNumber = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Every space-like character the game has been seen to use as a thousands separator:
    // plain space, NBSP (U+00A0), narrow NBSP (U+202F), thin space (U+2009), figure space
    // (U+2007). Missing NBSP is what made the old client regexes return empty strings.
    const SPACES = /[\s    ]/g;

    /**
     * Parse a localised number into a JS number. Returns 0 for anything unparseable, so
     * callers that used `|| 0` keep working.
     */
    function parseLocaleNumber(value) {
        if (value == null) return 0;
        if (typeof value === 'number') return isFinite(value) ? value : 0;

        // Drop spaces first (thousands separators), then everything that is not a digit,
        // a separator or a leading sign.
        let s = String(value).replace(SPACES, '').replace(/[^\d.,+-]/g, '');
        if (!s) return 0;

        // Keep only a leading sign; "+5" and "-5" are both real in this game's output
        // (race modifiers), but "1-2" is a range and should read as 1.
        let sign = 1;
        if (s[0] === '-') sign = -1;
        const signless = s.replace(/[+-]/g, '');
        if (!signless) return 0;
        s = signless;

        const commas = (s.match(/,/g) || []).length;
        const dots = (s.match(/\./g) || []).length;

        let decimal = null;
        if (commas && dots) {
            decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
        } else if (commas === 1 || dots === 1) {
            const sep = commas ? ',' : '.';
            // three trailing digits means thousands ("1.234"), anything else a decimal
            if (s.length - s.lastIndexOf(sep) - 1 !== 3) decimal = sep;
        }

        if (decimal) {
            const thousands = decimal === ',' ? '.' : ',';
            s = s.split(thousands).join('').replace(decimal, '.');
        } else {
            s = s.replace(/[.,]/g, '');
        }

        const n = parseFloat(s);
        return isNaN(n) ? 0 : sign * n;
    }

    /** Same, rounded to an integer. Replaces cleanInt and toInt. */
    function parseLocaleInt(value) {
        return Math.round(parseLocaleNumber(value));
    }

    /**
     * Comparator for sorting columns that hold localised numbers as text. Sorting those
     * as strings put "999.9" above "1,000"; sorting them with parseInt read "999.9" as
     * 999 and "1,000" as 1.
     */
    function compareNumeric(a, b) {
        const na = parseLocaleNumber(a), nb = parseLocaleNumber(b);
        return na === nb ? 0 : (na < nb ? -1 : 1);
    }

    /**
     * True when the text contains something that looks like a number at all. Used by the
     * scrapers to tell "this cell is empty" from "this cell did not parse", which is the
     * difference between a quiet zero and a real problem.
     */
    function looksNumeric(value) {
        if (value == null) return false;
        return /\d/.test(String(value));
    }

    return { parseLocaleNumber, parseLocaleInt, compareNumeric, looksNumeric, SPACES };
});
