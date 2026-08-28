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
const TAKE = 50;

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
    // Whose reports? allianceId is resolved server-side via the name bridge and is null
    // when the bridge cannot match — the contract says treat null as "skip", not error.
    const meRes = await fetch('/hub-api/me');
    if (!meRes.ok) {
        console.warn('[BattleSync] /hub-api/me failed:', meRes.status);
        return;
    }
    const me = await meRes.json();
    if (me.allianceId == null) {
        console.warn('[BattleSync] no allianceId for this account (name bridge unresolved) — skipping sync.');
        return;
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
        for (const r of extractReports(result.data)) {
            const id = r && r.id;
            if (id != null) {
                if (seen.has(id)) continue;
                seen.add(id);
            }
            reports.push(r);
        }
    }
    if (!anySearchOk) return; // both searches failed — nothing to say to the hub

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
        return;
    }
    const d = await syncRes.json();
    if (d.newest_started_at) newestStartedAt = d.newest_started_at;
    if (d.inserted > 0) console.log(`[BattleSync] synced ${d.inserted} new battle report(s).`);
}
