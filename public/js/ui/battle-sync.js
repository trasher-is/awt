// Battle-report background sync — wrapper realm only.
//
// While a dashboard is open it periodically pulls the newest battle reports from the game
// API — GLOBALLY, every report on the server, not scoped to any one alliance (see pullOnce)
// — and hands them to the hub (POST /hub-api/sync/battle-reports), which stores them
// idempotently and announces the genuinely new, alliance-relevant ones on Discord (the
// alliance filter lives server-side now, at announce time — see routes/sync.js). First
// pull 10 s after load, then every 30 minutes.
//
// A setInterval here does NOT violate the no-polling rule: that rule bans polling the
// game's DOM inside the injected frame (the 200ms interval spy.js was rewritten to
// remove). This is the wrapper document making rate-gated API calls on a slow clock — one
// request per pull, through the same shared 5/s budget as everything else.
//
// Two open dashboards must not double-pull, so a pull first claims a localStorage
// timestamp lock (25-min TTL — shorter than the 30-min interval, so a pull that died
// mid-flight is retried on the next tick instead of wedging the sync forever).
//
// This is background housekeeping: every failure is console.warn'd and swallowed.
// No toasts — nobody wants a popup every half hour because their session expired.

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';

const FIRST_PULL_DELAY_MS = 10 * 1000;
const PULL_INTERVAL_MS = 30 * 60 * 1000;
const LOCK_KEY = 'awt.battleSync.lock.v1';
const LOCK_TTL_MS = 25 * 60 * 1000;
// 500 confirmed to work against production (2026-08-30, ?Take=500) — no confirmed offset/
// paging parameter exists to walk past a full page, so this is a bigger safety margin, not
// a hard guarantee. See the full-page warning below: results are Descending by DateTime, so
// if a single window (the initial no-BattleDateFrom pull, or activity since the last
// watermark) has MORE than TAKE reports, the oldest ones in that window are silently
// dropped by the API's own Take cap, not by this code.
const TAKE = 500;

// BattleDateFrom for the next pull: the newest started_at the hub holds, learned from
// each sync response (newest_started_at). Null until the first sync answers — the first
// search then simply omits BattleDateFrom and takes the latest TAKE reports; the
// server's INSERT OR IGNORE makes the overlap free.
let newestStartedAt = null;

let started = false;

export function initBattleSync() {
    if (started) return; // one scheduler per dashboard document
    started = true;
    setTimeout(runPull, FIRST_PULL_DELAY_MS);
    setInterval(runPull, PULL_INTERVAL_MS);
}

// Claim the cross-dashboard lock: true means "this document pulls now". Claimed at pull
// START, not on success — a failed pull just waits for the next 30-min tick, by which
// time the 25-min TTL has expired. localStorage is same-origin shared, so two open
// dashboards see one lock (same mechanism the rate gate uses for its window).
function claimPullLock() {
    try {
        const ts = Number(localStorage.getItem(LOCK_KEY));
        if (Number.isFinite(ts) && Date.now() - ts < LOCK_TTL_MS) return false;
        localStorage.setItem(LOCK_KEY, String(Date.now()));
        return true;
    } catch (err) {
        return true; // no localStorage — no second dashboard to race with either
    }
}

async function runPull() {
    if (!claimPullLock()) return; // another dashboard pulled recently
    try {
        await pullOnce();
    } catch (err) {
        console.warn('[BattleSync] pull failed:', err);
    }
}

// Manual "sync now" — a sidebar button, not the background clock. Bypasses the
// cross-dashboard lock (an explicit click should always run, unlike the periodic timer)
// but still refreshes it afterward so the next automatic tick doesn't immediately re-pull.
// Unlike runPull, this surfaces a result to the caller (for a toast) instead of only
// console.warn'ing — a user who clicked a button deserves to see what happened.
export async function triggerManualSync() {
    try {
        const result = await pullOnce();
        try { localStorage.setItem(LOCK_KEY, String(Date.now())); } catch (err) { /* no-op */ }
        return result || { ok: true, inserted: 0 };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// The search-response envelope is SPEC-DERIVED (OpenAPI 3.0.1), never observed against
// production — so accept a bare array or the usual paged-envelope keys, and complain
// loudly when a non-empty answer matches neither (silently reading "unrecognized" as
// "no reports" is the fail-plausibly mode this codebase was rewritten to eliminate).
function extractReports(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
        for (const key of ['items', 'results', 'reports', 'data']) {
            if (Array.isArray(data[key])) return data[key];
        }
        console.warn('[BattleSync] unrecognized search response shape:', Object.keys(data));
    }
    return [];
}

async function pullOnce() {
    // GLOBAL, unfiltered pull — every battle report on the server, not just the tracked
    // account's own alliance/battles. Confirmed against production (2026-09-02): omitting
    // FirstParty/SecondParty entirely returns results for arbitrary, unrelated players (same
    // "no filter" shape as getPlayers()), so there is no need to resolve "my alliance" here
    // at all any more — the old alliance-or-own-battles scoping just meant this hub only
    // ever learned about combat involving whichever account's dashboard happened to be open,
    // and (in a fresh round, before alliances have real rosters) essentially nothing. Storing
    // everything now means there is no gap to backfill later if a wider view is ever wanted;
    // Discord's announcer is what stays alliance-scoped (see routes/sync.js), by filtering
    // AFTER sync rather than restricting what gets pulled in the first place.
    const { searchBattleReports } = globalThis.AWApi;

    const result = await searchBattleReports({
        OrderBy: 'DateTime',
        OrderDirection: 'Descending',
        Take: TAKE,
        BattleDateFrom: newestStartedAt, // omitted from the query while null
    });
    if (!result.ok) {
        console.warn('[BattleSync] battle-report search failed:', result.status, result.reason);
        return { ok: false, error: `battle-report search failed (${result.status || result.reason})` };
    }
    const reports = extractReports(result.data);
    // A page exactly at the Take cap means the API may hold MORE matches for this window
    // than we asked for — Descending order means those extra ones are older than everything
    // here, and with no confirmed way to page past this, they are silently gone from this
    // pull. Fail loudly instead of pretending the window was fully covered (same philosophy
    // as extractReports' "unrecognized shape" warning). A global feed fills this cap far
    // faster than the old alliance-scoped one did, so this is far more likely to fire now —
    // if it does often, PULL_INTERVAL_MS needs shortening, not TAKE raising past what's
    // confirmed to work.
    if (reports.length >= TAKE) {
        console.warn(`[BattleSync] search page hit the Take cap (${TAKE}) — older reports in this window may have been missed.`);
    }

    // POST even when empty: the response's newest_started_at is the only way to learn
    // the hub's watermark (including advances other members' dashboards pushed), and
    // that is what keeps the next search window from re-reading history.
    const syncRes = await fetch('/hub-api/sync/battle-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports }),
    });
    if (!syncRes.ok) {
        console.warn('[BattleSync] /hub-api/sync/battle-reports failed:', syncRes.status);
        return { ok: false, error: `/hub-api/sync/battle-reports failed (${syncRes.status})` };
    }
    const d = await syncRes.json();
    if (d.newest_started_at) newestStartedAt = d.newest_started_at;
    if (d.inserted > 0) console.log(`[BattleSync] synced ${d.inserted} new battle report(s).`);
    return { ok: true, inserted: d.inserted || 0, skipped: d.skipped || 0 };
}
