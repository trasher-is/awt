// When is a player reliably away? — the quiet-window analysis behind the profile card (issue #137).
//
// ─── WHAT THE HUB ACTUALLY KNOWS ──────────────────────────────────────────────
// The hub never sees a login TIME. Each scan of a player carries the game's login counter,
// and that is all: between two scans the counter either moved (the player logged in at
// least once, somewhere in that interval) or it did not (the player was away for the WHOLE
// interval). So an interval between two consecutive observations is one of two things:
//
//   active — the counter rose (or fell: a restart). The login happened somewhere inside;
//            no hour of the interval can be called quiet.
//   quiet  — the counter was unchanged. Every minute of the interval is proven quiet.
//
// Everything here follows from that. A grid cell (one local hour of one day) is "quiet" only
// when quiet intervals cover the whole hour, "active" when any active interval touches it,
// and "unknown" otherwise — including an hour half-covered by a quiet interval, because the
// uncovered half says nothing. A "window" is a run of hours of the day that were quiet on
// every day they were observed, observed at least twice, because one quiet day is a
// coincidence and a pattern needs a second look.
//
// The samples are UTC (SQLite CURRENT_TIMESTAMP); the grid is in the VIEWER's local time,
// so the rotation is done here with an explicit offset rather than by the server.
//
// LOADING: same dual Node/browser pattern as column-prefs.js.
//   • Node:    require('../../public/js/utils/login-gaps.js')
//   • Browser: import '../utils/login-gaps.js'; then read globalThis.AWLoginGaps
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWLoginGaps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;

    // A Date, epoch ms, ISO string, or SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker).
    function toMs(t) {
        if (t instanceof Date) return t.getTime();
        if (typeof t === 'number') return t;
        if (typeof t === 'string') {
            const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t;
            return new Date(iso).getTime();
        }
        return NaN;
    }

    // [{t, n}] → sorted, numeric, with anything unparseable dropped.
    function normalise(samples) {
        return (Array.isArray(samples) ? samples : [])
            .map(s => ({ t: toMs(s && s.t), n: Number(s && s.n) }))
            .filter(s => Number.isFinite(s.t) && Number.isFinite(s.n))
            .sort((a, b) => a.t - b.t);
    }

    // Consecutive observations → the intervals between them, clipped to [from, to].
    function bands(samples, from, to) {
        const s = normalise(samples);
        const out = [];
        for (let i = 1; i < s.length; i++) {
            const a = s[i - 1], b = s[i];
            const start = Math.max(a.t, from);
            const end = Math.min(b.t, to);
            if (!(end > start)) continue;
            out.push({ start, end, kind: b.n === a.n ? 'quiet' : 'active', delta: b.n - a.n });
        }
        return out;
    }

    // `days` rows (oldest first, today last) × 24 local hours. tzOffsetMin is the number of
    // minutes to ADD to UTC to get the viewer's clock (-new Date().getTimezoneOffset()).
    // Cell values: 'quiet' | 'active' | 'unknown' | 'future'.
    function grid(bandList, { now, tzOffsetMin = 0, days = 7 }) {
        const shift = tzOffsetMin * 60 * 1000;
        const todayStartLocal = Math.floor((now + shift) / DAY) * DAY;
        const rows = [];
        for (let d = 0; d < days; d++) {
            const dayStartLocal = todayStartLocal - (days - 1 - d) * DAY;
            const cells = [];
            for (let h = 0; h < 24; h++) {
                const cellStart = dayStartLocal + h * HOUR - shift;
                const cellEnd = cellStart + HOUR;
                if (cellStart >= now) { cells.push('future'); continue; }
                let active = 0, quiet = 0;
                for (const b of bandList) {
                    const overlap = Math.min(b.end, cellEnd) - Math.max(b.start, cellStart);
                    if (overlap <= 0) continue;
                    if (b.kind === 'active') active += overlap; else quiet += overlap;
                }
                // The current hour only runs up to `now`; a second of slack absorbs clock
                // rounding in the sample timestamps.
                const span = Math.min(cellEnd, now) - cellStart;
                cells.push(active > 0 ? 'active' : quiet >= span - 1000 ? 'quiet' : 'unknown');
            }
            rows.push({ dayStartUtc: dayStartLocal - shift, cells });
        }
        return rows;
    }

    // Per hour of the day, how many days were quiet / active; then the runs of hours that
    // were quiet on every observed day (observed on at least `minObserved` days), as
    // windows over a circular clock so a run across midnight is one window.
    function hourStats(rows) {
        return Array.from({ length: 24 }, (_, hour) => {
            let quiet = 0, active = 0;
            for (const r of rows) {
                if (r.cells[hour] === 'quiet') quiet++;
                else if (r.cells[hour] === 'active') active++;
            }
            return { hour, quiet, active, observed: quiet + active };
        });
    }

    function windows(rows, { minObserved = 2, minHours = 2 } = {}) {
        const stats = hourStats(rows);
        const safe = stats.map(x => x.observed >= minObserved && x.active === 0);
        if (safe.every(Boolean)) {
            return [{ startHour: 0, endHour: 0, hours: 24, minObserved: Math.min(...stats.map(x => x.observed)) }];
        }
        const firstUnsafe = safe.findIndex(v => !v);
        const out = [];
        let run = null;
        for (let i = 1; i <= 24; i++) {
            const h = (firstUnsafe + i) % 24;
            if (safe[h]) {
                if (!run) run = { startHour: h, hours: 0, minObserved: Infinity };
                run.hours++;
                run.minObserved = Math.min(run.minObserved, stats[h].observed);
            } else if (run) {
                out.push(run);
                run = null;
            }
        }
        if (run) out.push(run);
        return out
            .filter(w => w.hours >= minHours)
            .map(w => ({ ...w, endHour: (w.startHour + w.hours) % 24 }))
            .sort((a, b) => b.hours - a.hours || b.minObserved - a.minObserved || a.startHour - b.startHour);
    }

    // The most recent scan that found the counter moved, and how long the scans after it
    // have kept finding it unchanged. Null when the counter was never seen to move.
    function quietSince(samples) {
        const s = normalise(samples);
        let lastChange = null, unchangedScans = 0;
        for (let i = 1; i < s.length; i++) {
            if (s[i].n !== s[i - 1].n) { lastChange = s[i]; unchangedScans = 0; }
            else if (lastChange) unchangedScans++;
        }
        if (!lastChange) return null;
        const lastScanAt = s[s.length - 1].t;
        return { at: lastChange.t, unchangedScans, lastScanAt, confirmedQuietMs: lastScanAt - lastChange.t };
    }

    function analyze(samples, { now = Date.now(), tzOffsetMin = 0, days = 7 } = {}) {
        const from = now - days * DAY;
        const s = normalise(samples);
        const bandList = bands(s, from, now);
        const rows = grid(bandList, { now, tzOffsetMin, days });
        const observed = rows.reduce((n, r) => n + r.cells.filter(c => c === 'quiet' || c === 'active').length, 0);
        const past = rows.reduce((n, r) => n + r.cells.filter(c => c !== 'future').length, 0);
        return {
            from, now,
            sampleCount: s.filter(x => x.t >= from && x.t <= now).length,
            bands: bandList,
            rows,
            hours: hourStats(rows),
            windows: windows(rows),
            quietSince: quietSince(s),
            coverage: past ? observed / past : 0,
        };
    }

    return { HOUR, DAY, toMs, normalise, bands, grid, hourStats, windows, quietSince, analyze };
});
