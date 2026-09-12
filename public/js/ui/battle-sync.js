// Battle-report background sync — wrapper realm only.
//
// Pulls the newest battle reports from the game API — GLOBALLY, every report on the
// server, not scoped to any one alliance (see pullOnce) — and hands them to the hub (POST
// /hub-api/sync/battle-reports), which stores them idempotently and announces the
// genuinely new, alliance-relevant ones on Discord (the alliance filter lives server-side
// now, at announce time — see routes/sync.js).
//
// Once a day, shortly after the reset, not a poll (2026-09-12, replacing a 30-min
// setInterval): confirmed against how the game actually behaves, battle reports are only
// posted once a day, at the 00:00 CET/CEST reset — pulling every 30 minutes all day just
// re-asked for the same (empty) window over and over. Scheduling follows the exact same
// day-lock/attempt-lock/retry pattern as api-galaxy-seed.js — see that file's comment for
// the full reasoning; the two were unified deliberately, not independently invented.
//
// A setInterval/setTimeout here does NOT violate the no-polling rule: that rule bans
// polling the game's DOM inside the injected frame (the 200ms interval spy.js was
// rewritten to remove). This is the wrapper document making a rate-gated API call once a
// day, through the same shared 5/s budget as everything else.
//
// This is background housekeeping: every failure is console.warn'd and swallowed.
// No toasts — nobody wants a popup because their session expired hours ago.

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';
import '../utils/daily-reset.js';

const AWDailyReset = globalThis.AWDailyReset;

const RESET_BUFFER_MINUTES = 5; // pull at 00:05 Europe/Berlin — a few minutes after the reset lands
const DAY_LOCK_KEY = 'awt.battleSync.lastPullDay.v2'; // Berlin-date of the last SUCCESSFUL pull
const ATTEMPT_LOCK_KEY = 'awt.battleSync.attemptLock.v2'; // short cross-tab mutex, not a daily gate
const ATTEMPT_LOCK_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 60 * 1000; // a failed attempt retries in 30 min, not a full day later
const CATCHUP_DELAY_MS = 10 * 1000; // let the page settle before the very first check
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

function getLastPulledDay() {
    try { return localStorage.getItem(DAY_LOCK_KEY); } catch (err) { return null; }
}
function setLastPulledDay(day) {
    try { localStorage.setItem(DAY_LOCK_KEY, day); } catch (err) { console.warn('[BattleSync] could not persist last-pulled day:', err.message); }
}
function claimAttemptLock() {
    try {
        const raw = localStorage.getItem(ATTEMPT_LOCK_KEY);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ATTEMPT_LOCK_TTL_MS) return false;
        localStorage.setItem(ATTEMPT_LOCK_KEY, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same as player-api-sync.js
    }
}

function scheduleWake(when) {
    const delay = Math.max(1000, when.getTime() - Date.now());
    setTimeout(tick, delay);
}

// Always checks "did today's pull already succeed" first (across tabs and reloads, via
// the Berlin-date day-lock) rather than assuming a fixed clock tick means work is due —
// see api-galaxy-seed.js's identical tick() for the full reasoning.
async function tick() {
    const today = AWDailyReset.berlinDateKey();
    if (getLastPulledDay() === today) {
        scheduleWake(AWDailyReset.nextDailyWindow(RESET_BUFFER_MINUTES));
        return;
    }
    if (!claimAttemptLock()) {
        scheduleWake(new Date(Date.now() + RETRY_DELAY_MS));
        return;
    }
    try {
        const result = await pullOnce();
        if (result && result.ok) setLastPulledDay(today);
        else console.warn('[BattleSync] pull failed:', result && result.error);
    } catch (err) {
        console.warn('[BattleSync] pull failed:', err.message);
    }
    scheduleWake(getLastPulledDay() === today
        ? AWDailyReset.nextDailyWindow(RESET_BUFFER_MINUTES)
        : new Date(Date.now() + RETRY_DELAY_MS));
}

let started = false;
export function initBattleSync() {
    if (started) return; // one scheduler per dashboard document
    started = true;
    setTimeout(tick, CATCHUP_DELAY_MS);
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
    // as extractReports' "unrecognized shape" warning). Now that a pull only happens once a
    // day, this window covers a full day's worth of global battle activity — if this fires
    // often, RESET_BUFFER_MINUTES pulling too late in the day is more suspect than TAKE
    // itself; raising TAKE past what's confirmed to work is not the first thing to try.
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
