// Battle-report background sync — wrapper realm only.
//
// Pulls the newest battle reports from the game API — GLOBALLY, every report on the
// server, not scoped to any one alliance (see pullOnce) — and hands them to the hub (POST
// /hub-api/sync/battle-reports), which stores them idempotently and announces the
// genuinely new, alliance-relevant ones on Discord (the alliance filter lives server-side
// now, at announce time — see routes/sync.js).
//
// Once per game day, for the whole hub (2026-10-17): battle reports are only posted at the
// 00:00 CET/CEST reset, so the hub hands today's pull to ONE member's browser, rotating
// between members (src/repositories/sharedJobs.js, job 'battle-sync', due 5 minutes after
// the reset). Until then every member's browser made the same pull every day, each with its
// own localStorage day-lock. The call rides on that member's own game session, which the
// game counts as them being active.
//
// A claim is recorded the moment it is granted. The hub marks it done when the pull's POST
// lands; a claim that has not after 15 minutes (tab reloaded, game session expired) lapses
// and another member's browser may claim it again the same day (sharedJobs.js leaseMs).
// Overlapping pulls cost nothing: the hub stores reports idempotently.
//
// This is background housekeeping: every failure is console.warn'd and swallowed.
// No toasts — nobody wants a popup because their session expired hours ago.

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';
import { claimSharedJob } from '../utils/shared-job.js';

// How often this browser ASKS the hub whether today's pull is due — a hub request, not game traffic.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const JOB = 'battle-sync';
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

let pulling = false;

async function tick() {
    if (!globalThis.AWGameRate.isMemberActive()) return; // member away: no game traffic on their session (game-rate-limit.js)
    if (pulling) return; // in-tab re-entrancy guard — a slow pull must not stack
    pulling = true;
    try {
        if (!(await claimSharedJob(JOB))) return; // another member has it, or it already ran today
        const result = await pullOnce();
        if (!result || !result.ok) console.warn('[BattleSync] pull failed:', result && result.error);
    } catch (err) {
        console.warn('[BattleSync] pull failed:', err.message);
    } finally {
        pulling = false;
    }
}

let started = false;
export function initBattleSync() {
    if (started) return; // one scheduler per dashboard document
    started = true;
    tick();
    setInterval(tick, CHECK_INTERVAL_MS);
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
    // often, the daily claim running too late in the day is more suspect than TAKE itself;
    // raising TAKE past what's confirmed to work is not the first thing to try.
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
