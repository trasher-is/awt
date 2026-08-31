// Battle-report background sync — wrapper realm only.
//
// While a dashboard is open it periodically pulls the alliance's newest battle reports
// from the game API and hands them to the hub (POST /hub-api/sync/battle-reports), which
// stores them idempotently and announces the genuinely new ones on Discord. First pull
// 10 s after load, then every 30 minutes.
//
// A setInterval here does NOT violate the no-polling rule: that rule bans polling the
// game's DOM inside the injected frame (the 200ms interval spy.js was rewritten to
// remove). This is the wrapper document making rate-gated API calls on a slow clock —
// two requests per pull, through the same shared 5/s budget as everything else.
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
    // Whose reports? allianceId is resolved server-side via the name bridge. It's null in
    // two different situations that must not share one message: bridgeResolved=false means
    // the hub username doesn't match any in-game player at all (a real config problem);
    // bridgeResolved=true with allianceId still null means the match worked fine and that
    // player simply has no alliance right now (e.g. a fresh round, before joining one) —
    // an expected, temporary state, not an error to fix.
    const meRes = await fetch('/hub-api/me');
    if (!meRes.ok) {
        console.warn('[BattleSync] /hub-api/me failed:', meRes.status);
        return { ok: false, error: `/hub-api/me failed (${meRes.status})` };
    }
    const me = await meRes.json();
    if (me.allianceId == null) {
        if (!me.bridgeResolved) {
            console.warn('[BattleSync] hub username does not match any in-game player — skipping sync.');
            return { ok: false, reason: 'bridge', error: 'your hub username does not match an in-game player name — check it in Settings' };
        }
        // Not a failure — reason: 'no-alliance' lets callers (e.g. the manual sync button)
        // show this as a plain status instead of an error.
        console.warn('[BattleSync] account is not currently in an alliance — skipping sync.');
        return { ok: false, reason: 'no-alliance', error: 'not currently in an alliance — nothing to sync yet' };
    }

    const { searchBattleReports } = globalThis.AWApi;

    // Both sides of the alliance's battles: initiated (FirstParty) and received
    // (SecondParty). gameFetch serializes these through the shared 5/s window anyway.
    const base = {
        OrderBy: 'DateTime',
        OrderDirection: 'Descending',
        Take: TAKE,
        BattleDateFrom: newestStartedAt, // omitted from the query while null
    };
    const [asAttacker, asDefender] = await Promise.all([
        searchBattleReports({ ...base, 'FirstParty.AllianceId': me.allianceId }),
        searchBattleReports({ ...base, 'SecondParty.AllianceId': me.allianceId }),
    ]);

    // An intra-alliance battle matches both searches — dedupe by report id. Reports
    // without an id pass through untouched; the server-side mapper is the validator.
    const seen = new Set();
    const reports = [];
    let anySearchOk = false;
    for (const result of [asAttacker, asDefender]) {
        if (!result.ok) {
            console.warn('[BattleSync] battle-report search failed:', result.status, result.reason);
            continue;
        }
        anySearchOk = true;
        const pageReports = extractReports(result.data);
        // A page exactly at the Take cap means the API may hold MORE matches for this
        // window than we asked for — Descending order means those extra ones are older
        // than everything here, and with no confirmed way to page past this, they are
        // silently gone from this pull. Fail loudly instead of pretending the window was
        // fully covered (same philosophy as extractReports' "unrecognized shape" warning).
        if (pageReports.length >= TAKE) {
            console.warn(`[BattleSync] search page hit the Take cap (${TAKE}) — older reports in this window may have been missed.`);
        }
        for (const r of pageReports) {
            const id = r && r.id;
            if (id != null) {
                if (seen.has(id)) continue;
                seen.add(id);
            }
            reports.push(r);
        }
    }
    if (!anySearchOk) return { ok: false, error: 'both battle-report searches failed' };

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
