// What a member is researching, what is queued after it, and when each level lands.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// Allies could see each other's science LEVELS on the alliance member sheet, but not what
// anyone was researching or when it would finish — that only shows on each member's own
// /Game/Science page. The member's browser now reads that page (on a visit, and in the
// background — see science-research-parser.js and research-watch.js) and reports the raw
// rows; this module turns them into an ordered, time-stamped queue. It runs on the server
// (the sync route) and in the Discord bot, so the ordering rule exists once.
//
// ─── THE PAGE, AS THE HUB ALREADY READS IT ────────────────────────────────────
// The same markup initScienceTimers (page-injections.js) has relied on since July:
//   • the science being researched carries a live `.timer-active` countdown (seconds left);
//   • queued research shows a numbered icon (bi-1/2/3-circle, or bi-repeat) in the queue
//     cell, paired by position with a `.timer` holding that item's own duration;
//   • the durations are NOT cumulative — item 2 starts when item 1 ends.
// A queue item can be the active one (its timer is the active timer) or come after it.
//
// ─── WHAT THE TIMES MEAN ──────────────────────────────────────────────────────
// The active item's finish is exact at the moment the page was read. Queued items were
// timed by the game at the rate of that moment; a new lab or population growth moves them,
// so they are estimates and the caller should say so. After a `repeat` item nothing is
// projected: what the game does next is not recorded here.
//
// LOADING: same dual Node/browser pattern as research-time.js.
//   • Node:    require('../../public/js/utils/research-queue.js')
//   • Browser: import '../utils/research-queue.js'; then read globalThis.AWResearchQueue
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWResearchQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Culture is left out on purpose: it has its own track and its own timer, already on
    // the member sheet as next_culture_at.
    const SCIENCES = ['Biology', 'Economy', 'Energy', 'Mathematics', 'Physics', 'Social'];
    const SLOT_ORDER = { '1': 1, '2': 2, '3': 3, 'repeat': 4 };
    // A timer longer than this is a misread, not research.
    const MAX_SECONDS = 90 * 24 * 3600;

    // null means "no timer", not zero seconds: Number(null) is 0, which would make every
    // row look like it was being researched.
    function validSeconds(v) {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= MAX_SECONDS ? Math.round(n) : null;
    }

    /**
     * Rows as the parser reports them → the research order.
     * @param {Array<{science:string, level:number, active_seconds?:number|null,
     *                queued?:Array<{slot:string, seconds:number, active?:boolean}>}>} sciences
     * @returns {Array<{science:string, target_level:number, seconds:number, active:boolean, repeat:boolean}>}
     */
    function buildQueue(sciences) {
        // First row per science wins; a second one is a misread, not a second track.
        const seen = new Set();
        const rows = (Array.isArray(sciences) ? sciences : [])
            .filter(r => r && SCIENCES.includes(r.science) && Number.isInteger(r.level) && r.level >= 0)
            .filter(r => !seen.has(r.science) && seen.add(r.science));

        const items = [];
        let order = 0;
        let activeRow = null;
        for (const row of rows) {
            const activeSecs = validSeconds(row.active_seconds);
            if (activeSecs != null && !activeRow) activeRow = { row, seconds: activeSecs };
            for (const q of Array.isArray(row.queued) ? row.queued : []) {
                const rank = SLOT_ORDER[String(q && q.slot)];
                const seconds = validSeconds(q && q.seconds);
                if (!rank || seconds == null) continue;
                items.push({ science: row.science, rank, order: order++, seconds, active: !!q.active, repeat: q.slot === 'repeat' });
            }
        }
        items.sort((a, b) => a.rank - b.rank || a.order - b.order);

        // The active research leads. When its timer is one of the queue's own timers the
        // parser flags that item; otherwise it is an item of its own, ahead of the queue.
        const flagged = items.findIndex(i => i.active);
        if (flagged > 0) items.unshift(items.splice(flagged, 1)[0]);
        if (activeRow && flagged === -1) {
            items.unshift({ science: activeRow.row.science, seconds: activeRow.seconds, active: true, repeat: false });
        } else if (activeRow && flagged !== -1) {
            // The live countdown is the better number for the item in progress.
            items[0].seconds = activeRow.seconds;
        }
        for (const i of items) i.active = i === items[0] && (!!activeRow || i.active);

        // Each further item of the same science is one level higher.
        const next = {};
        rows.forEach(r => { if (next[r.science] == null) next[r.science] = r.level; });
        let afterRepeat = false;
        return items.filter(i => {
            if (afterRepeat) return false;
            if (i.repeat) afterRepeat = true;
            return true;
        }).map(i => {
            next[i.science] += 1;
            return { science: i.science, target_level: next[i.science], seconds: i.seconds, active: i.active, repeat: i.repeat };
        });
    }

    /** Absolute finish times: each item starts when the one before it ends. */
    function schedule(queue, observedAtMs) {
        let t = Number(observedAtMs);
        return (queue || []).map(i => {
            const startsAt = t;
            t += i.seconds * 1000;
            return { science: i.science, target_level: i.target_level, active: !!i.active, repeat: !!i.repeat, starts_at_ms: startsAt, finishes_at_ms: t };
        });
    }

    /**
     * Where a stored snapshot stands NOW. Items whose finish has passed are done; the first
     * one still running is `current`.
     * @param {{observed_at_ms:number, items:Array}} snap  scheduled items as schedule() returns
     */
    function statusAt(snap, nowMs) {
        const items = (snap && snap.items) || [];
        const done = items.filter(i => i.finishes_at_ms <= nowMs);
        const pending = items.filter(i => i.finishes_at_ms > nowMs);
        const current = pending[0] || null;
        const last = items[items.length - 1] || null;
        return {
            current,
            // Rolled forward past the page read: the timer of `current` is exact only when it
            // was the item in progress at the read.
            current_exact: !!(current && current === items[0] && current.active),
            upcoming: pending.slice(1),
            done,
            idle_since_ms: current ? null : (last ? last.finishes_at_ms : null),
            was_researching: items.length > 0 && items[0].active,
            ends_with_repeat: !!(last && last.repeat),
        };
    }

    function formatDuration(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        if (d) return `${d}d ${h}h`;
        if (h) return `${h}h ${m}m`;
        if (m) return `${m}m`;
        return `${s}s`;
    }

    return { SCIENCES, MAX_SECONDS, buildQueue, schedule, statusAt, formatDuration };
});
