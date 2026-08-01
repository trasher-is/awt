// Scraper instrumentation: address columns structurally, match labels across languages,
// and count what did NOT parse so a broken scrape looks broken.
//
// LOADING: no import/export statements — Node require()s it, the browser runs it as a
// side-effect module import with the API on globalThis. Same pattern as battle-model.js.
//   • Node:    require('../../public/js/utils/scrape-report.js')
//   • Browser: import '../utils/scrape-report.js';  then globalThis.AWScrape
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// The worst failure mode here is not a crash — it is wrong data that looks right.
//
// The parsers addressed cells by position (tds[1], fTds[1..5]) and matched one English
// label string ('Local Time', 'CV Limit', 'Planets<br>(Next Culture)'). So:
//
//   • one new column in the game shifts every fleet stat by one, and plausible-looking
//     numbers land in the database with no error raised;
//   • the game is localised — fleet-time.js already documents Lithuanian, English,
//     German, Finnish and Spanish — so a member playing in another language syncs zeros;
//   • empty catch {} blocks in the scan path let a partial galaxy scan report success.
//
// fleet-time.js solved its own version of this by ignoring the localised month name and
// reading the digits instead. Same principle applies here: prefer structure (header text,
// href shapes, data attributes) over words, and when a word is unavoidable, make a miss
// LOUD instead of returning 0.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWScrape = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Normalise a label for comparison: lowercase, strip punctuation and collapse all
    // space-likes (including NBSP). "Local Time:" and "local  time" become "local time".
    function normalise(text) {
        return String(text == null ? '' : text)
            .replace(/[\s    ]+/g, ' ')
            .replace(/[:：.]+\s*$/, '')
            .trim()
            .toLowerCase();
    }

    /**
     * Known labels, as synonym sets.
     *
     * Only English entries are listed because English is the only wording confirmed from
     * the live game. Nothing here is a guess at a translation — a wrong translation would
     * silently match the wrong cell, which is the very failure this file exists to stop.
     *
     * To add a language, append the exact strings that language shows. Missing entries do
     * not corrupt anything: they get counted as misses and reported.
     */
    const LABELS = {
        localTime:       ['local time'],
        idle:            ['idle', 'idle time'],
        joined:          ['joined'],
        logins:          ['logins'],
        cvLimit:         ['cv limit'],
        cvUsed:          ['cv used'],
        origin:          ['origin'],
        playerLevel:     ['player level'],
        scienceLevel:    ['science level'],
        cultureLevel:    ['culture level'],
        ranking:         ['ranking'],
        points:          ['points'],
        name:            ['name'],
        tag:             ['tag'],
        leader:          ['leader'],
        biology:         ['biology'],
        economy:         ['economy'],
        energy:          ['energy'],
        mathematics:     ['mathematics'],
        physics:         ['physics'],
        social:          ['social'],
        population:      ['population'],
        economyBonus:    ['economy bonus'],
        tradeRevenue:    ['trade revenue'],
        astroDollars:    ['astro dollars'],
        productionPoints:['production points'],
        productionRate:  ['production'],
        scienceRate:     ['science'],
        cultureRate:     ['culture'],
        artefact:        ['artefact', 'artifact'],
        sum:             ['sum'],
    };

    function matchesLabel(text, synonyms) {
        const t = normalise(text);
        if (!t) return false;
        return synonyms.some(s => t === normalise(s));
    }

    function containsLabel(text, synonyms) {
        const t = normalise(text);
        if (!t) return false;
        return synonyms.some(s => t.includes(normalise(s)));
    }

    /**
     * Column index from the table's own header row, so an inserted column moves the index
     * instead of shifting every value by one.
     * Returns -1 when the header is absent or no synonym matches.
     */
    function headerIndex(table, synonyms) {
        if (!table || typeof table.querySelectorAll !== 'function') return -1;
        const cells = table.querySelectorAll('thead th, thead td');
        for (let i = 0; i < cells.length; i++) {
            if (matchesLabel(cells[i].innerText, synonyms) || containsLabel(cells[i].innerText, synonyms)) return i;
        }
        return -1;
    }

    /**
     * The value cell sitting next to a label cell. Returns { found, value, cell } so the
     * caller can tell "the label was not on this page" from "the value was empty" — the
     * distinction the old helpers threw away by returning '' for both.
     */
    function labelledValue(root, synonyms, { exact = true, accept = null } = {}) {
        if (!root || typeof root.querySelectorAll !== 'function') return { found: false, value: '', cell: null };
        const cells = root.querySelectorAll('td, th');
        for (const cell of cells) {
            const hit = exact ? matchesLabel(cell.innerText, synonyms) : containsLabel(cell.innerText, synonyms);
            if (!hit) continue;
            const next = cell.nextElementSibling;
            if (!next) continue;
            const value = String(next.innerText == null ? '' : next.innerText).trim();
            // `accept` exists for rows that share a label prefix — "Economy" the science
            // level and "Economy Bonus" the percentage both start with the same word, and
            // the old code skipped any value containing '%' for exactly that reason.
            if (accept && !accept(value)) continue;
            return { found: true, value, cell: next };
        }
        return { found: false, value: '', cell: null };
    }

    /**
     * A scrape's tally. Every scraper builds one, feeds it as it goes, and hands the
     * summary to the UI. A scrape that parsed nothing must not report success.
     */
    class ScrapeReport {
        constructor(name) {
            this.name = name;
            this.rowsSeen = 0;
            this.rowsParsed = 0;
            this.rowsSkipped = 0;
            this.labelsWanted = 0;
            this.labelsMissed = 0;
            this.problems = [];   // { reason, detail, count }
        }

        row(parsed) {
            this.rowsSeen++;
            if (parsed) this.rowsParsed++;
            else this.rowsSkipped++;
        }

        /** Record a label lookup, so a locale mismatch shows up as a ratio, not a zero. */
        label(found, which) {
            this.labelsWanted++;
            if (!found) {
                this.labelsMissed++;
                this.problem('label not found', which);
            }
        }

        problem(reason, detail) {
            const key = `${reason}|${detail == null ? '' : detail}`;
            const existing = this.problems.find(p => p.key === key);
            if (existing) { existing.count++; return; }
            this.problems.push({ key, reason, detail: detail == null ? '' : String(detail), count: 1 });
        }

        /** Wrap a per-row parse so a throw becomes a counted skip instead of a silent one. */
        tryRow(fn, context) {
            try {
                const out = fn();
                this.row(out !== null && out !== undefined && out !== false);
                return out;
            } catch (err) {
                this.row(false);
                this.problem('row threw', `${context || ''}: ${err.message}`);
                return null;
            }
        }

        /**
         * The check that turns "silently wrong" into "obviously broken": extracting zero
         * rows from a table that visibly has rows is an error, not an empty result.
         */
        get emptyFromNonEmpty() {
            return this.rowsSeen > 0 && this.rowsParsed === 0;
        }

        /** More than half the labels missing almost always means a non-English client. */
        get likelyWrongLanguage() {
            return this.labelsWanted >= 4 && this.labelsMissed > this.labelsWanted / 2;
        }

        get ok() {
            return !this.emptyFromNonEmpty && !this.likelyWrongLanguage;
        }

        summary() {
            const bits = [`${this.rowsParsed}/${this.rowsSeen} rows`];
            if (this.rowsSkipped) bits.push(`${this.rowsSkipped} skipped`);
            if (this.labelsWanted) bits.push(`${this.labelsWanted - this.labelsMissed}/${this.labelsWanted} fields`);
            let s = `${this.name}: ${bits.join(', ')}`;
            if (this.emptyFromNonEmpty) s += ' — NOTHING PARSED from a non-empty table';
            if (this.likelyWrongLanguage) s += ' — most labels not found; is the game interface set to English?';
            return s;
        }

        /** Console output plus the string the UI should show. Never throws. */
        finish() {
            const line = this.summary();
            if (!this.ok) {
                console.error(`[Scrape] ${line}`);
                this.problems.slice(0, 8).forEach(p => console.error(`[Scrape]   ${p.reason}: ${p.detail}${p.count > 1 ? ` (×${p.count})` : ''}`));
            } else if (this.rowsSkipped || this.labelsMissed) {
                console.warn(`[Scrape] ${line}`);
                this.problems.slice(0, 8).forEach(p => console.warn(`[Scrape]   ${p.reason}: ${p.detail}${p.count > 1 ? ` (×${p.count})` : ''}`));
            } else {
                console.log(`[Scrape] ${line}`);
            }
            return { ok: this.ok, line, problems: this.problems, counts: this.counts };
        }

        get counts() {
            return {
                rowsSeen: this.rowsSeen, rowsParsed: this.rowsParsed, rowsSkipped: this.rowsSkipped,
                labelsWanted: this.labelsWanted, labelsMissed: this.labelsMissed
            };
        }
    }

    return { ScrapeReport, LABELS, headerIndex, labelledValue, matchesLabel, containsLabel, normalise };
});
