// Is it time to research Social? — the rule behind the marker on the Science page (issue #138).
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// Social caps population per planet (docs/game-rules.md, "Social (population cap)"). A
// planet at its cap shows +0 growth on the Planets page, but the decision — research Social
// now — is taken on the Science page, where nothing says so. Early in a round this costs
// days of growth before anyone notices. The marker is deliberately quiet: a small triangle
// next to the Social row, grey when one planet is capped, amber when half or more are.
//
// The cap does not rise at every level (1→2 raises it, 2→3 does not), so the message names
// the next level that actually does — researching a level that changes nothing is the other
// mistake this exists to prevent.
//
// The planet populations come from the hub's own database (system scans by any member), not
// from the Planets page, so they can lag; a set of planets that is entirely older than
// `staleMs` never gets past grey, and the message says how old the data is.
//
// LOADING: same dual Node/browser pattern as empire-model.js (which it borrows game-tables from).
//   • Node:    require('../../public/js/utils/social-hint.js')
//   • Browser: import '../utils/game-tables.js'; import '../utils/social-hint.js'; then globalThis.AWSocialHint
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWSocialHint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const isNode = typeof module === 'object' && module !== null && !!module.exports;
    const T = isNode ? require('./game-tables.js') : globalThis.AWTables;

    const HOUR = 3600 * 1000;
    const DEFAULT_STALE_MS = 48 * HOUR;

    function toMs(t) {
        if (t == null) return NaN;
        if (t instanceof Date) return t.getTime();
        if (typeof t === 'number') return t;
        const s = String(t);
        return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s).getTime();
    }

    // The first level above `level` whose cap is higher, or null when the table is exhausted.
    function nextCapRaise(level) {
        const cap = T.popCap(level);
        const top = T.SOCIAL_CAP.length - 1;
        for (let l = Math.floor(level) + 1; l <= top; l++) {
            if (T.popCap(l) > cap) return { level: l, cap: T.popCap(l) };
        }
        return null;
    }

    /**
     * @param {object} o
     * @param {number} o.socialLevel   current Social level, off the Science page
     * @param {Array}  o.planets       [{ population, updated_at }] — the member's own planets
     * @param {boolean} [o.queued]     Social is being researched or is in the queue already
     * @param {number} [o.now]
     * @param {number} [o.staleMs]     planet data older than this (all of it) caps the state at grey
     * @returns {{state:'none'|'low'|'high', capped:number, total:number, cap:number, socialLevel:number,
     *            nextRaise:{level:number,cap:number}|null, stale:boolean, newestAt:number|null, oldestAt:number|null}}
     */
    function evaluate({ socialLevel, planets, queued = false, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
        const level = Number.isFinite(Number(socialLevel)) ? Math.max(0, Math.floor(Number(socialLevel))) : 0;
        const cap = T.popCap(level);
        // A planet whose population the hub never read (NULL) is neither capped nor not — it is
        // left out of both counts rather than counted as population 0.
        const list = (Array.isArray(planets) ? planets : [])
            .filter(p => p && p.population != null && p.population !== '' && Number.isFinite(Number(p.population)));
        const total = list.length;
        const capped = list.filter(p => Number(p.population) >= cap).length;

        const stamps = list.map(p => toMs(p.updated_at)).filter(Number.isFinite);
        const newestAt = stamps.length ? Math.max(...stamps) : null;
        const oldestAt = stamps.length ? Math.min(...stamps) : null;
        // Stale means the freshest scan is already too old — if even that one is out of
        // date, nothing here is current.
        const stale = total > 0 && (newestAt === null || now - newestAt > staleMs);

        const nextRaise = nextCapRaise(level);

        let state = 'none';
        if (total > 0 && capped > 0 && !queued && nextRaise) {
            state = (capped * 2 >= total && !stale) ? 'high' : 'low';
        }
        return { state, capped, total, cap, socialLevel: level, nextRaise, stale, newestAt, oldestAt };
    }

    // Tooltip text for a non-'none' result.
    function message(r, now = Date.now()) {
        if (!r || r.state === 'none') return '';
        const parts = [];
        parts.push(`${r.capped} of ${r.total} planet${r.total === 1 ? '' : 's'} at the population cap (Social ${r.socialLevel} → max ${r.cap}).`);
        if (r.nextRaise) {
            const skipped = r.nextRaise.level - r.socialLevel - 1;
            parts.push(skipped > 0
                ? `Social ${r.socialLevel + 1} does not raise the cap; ${r.nextRaise.level} does (max ${r.nextRaise.cap}).`
                : `Social ${r.nextRaise.level} raises it to ${r.nextRaise.cap}.`);
        }
        if (r.newestAt != null) {
            const ageH = Math.round((now - r.newestAt) / HOUR);
            const oldH = r.oldestAt != null ? Math.round((now - r.oldestAt) / HOUR) : ageH;
            parts.push(`Planet data from hub scans, ${ageH === oldH ? `${ageH}h` : `${ageH}–${oldH}h`} old${r.stale ? ' — stale, check the Planets page' : ''}.`);
        } else {
            parts.push('Planet data from hub scans of unknown age.');
        }
        return parts.join(' ');
    }

    return { DEFAULT_STALE_MS, nextCapRaise, evaluate, message };
});
