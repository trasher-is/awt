// Player API background sync — wrapper realm only, mirrors battle-sync.js's shape.
//
// Two independent jobs on two independent clocks:
//   1. ListPlayer pull: the full active-roster list, cheap (one API call), kept fresh.
//      Cadence decays with round age — frequent early (most members join in the first two
//      weeks, not day one, waiting for a better starting location), relaxed later.
//   2. Player/{id} sweep: a continuous, least-recently-scanned-first background scan
//      filling in the activity/status fields ListPlayer doesn't have. Claims a batch via
//      /hub-api/sync/player-scan-claim (see that route's comment for what "claim" means
//      here), then calls Player/{id} once per claimed id. The claim query has a SHORT
//      staleness floor (players.js's CLAIM_STALE_FLOOR_MINUTES, a few minutes — brought
//      back after a real incident: with no floor at all, several simultaneously-active
//      members' accounts each ran this same sweep with no idea another account had just
//      refreshed the same player, and endlessly re-scanned an already-fully-caught-up
//      roster between them, each spending its own 200/5min budget for zero benefit). Once
//      genuinely caught up, a tick's claim can come back empty — that's it correctly going
//      quiet, not a bug. SWEEP_BATCH_SIZE/SWEEP_INTERVAL_MS is what actually bounds real
//      traffic. The agreed ceiling is PER ACCOUNT, not pooled across the hub (see
//      docs/game-api.md and AGENTS.md's "Production game API: agreed, with boundaries") —
//      5 req/s AND 200 requests/5min, each measured against the one member whose session
//      this browser is using. At 1 call/30s this sweep spends only ~10 of that account's
//      200-per-5min budget (deliberately well under budget, not just under the ceiling —
//      2026-09-12: dialed down from the original 20/min after concerns that several
//      members' accounts running this at once could still tip into 429s in practice),
//      leaving nearly all of it free for that same member's own deliberate lookups
//      (search, travel calc, a manual deep scan) happening in the same window. Neither
//      ceiling is a tuning knob — raising either needs the game admin's renewed consent,
//      not a code change. A re-entrancy flag (`scanning`, shared with deepScanPlayers —
//      see its own comment) keeps a slow tick from overlapping the next scheduled one or a
//      manual deep scan.
//
// Cross-tab dedup follows battle-sync.js's localStorage-lock pattern exactly.

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';

const AWApi = globalThis.AWApi;

const LIST_LOCK_KEY = 'awt.playerListSync.lock.v1';
const LIST_LOCK_TTL_MS = 4 * 60 * 1000; // shorter than even the frequent 5-min cadence
const LIST_INTERVAL_FREQUENT_MS = 5 * 60 * 1000;   // first ~2 weeks of a round
const LIST_INTERVAL_RELAXED_MS = 6 * 60 * 60 * 1000; // after that
const FREQUENT_PHASE_DAYS = 14;

const SWEEP_LOCK_KEY = 'awt.playerSweepSync.lock.v1';
const SWEEP_LOCK_TTL_MS = 25 * 1000; // shorter than the 30s sweep interval
const SWEEP_INTERVAL_MS = 30 * 1000;
// Hardcoded for this landing — see this plan's Global Constraints re: not wiring this to
// app_settings yet. Tune here directly if the real budget usage needs adjusting.
const SWEEP_BATCH_SIZE = 1; // 1 call/30s — see the per-account budget math in the file header above

function claimLock(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ttlMs) return false;
        localStorage.setItem(key, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage (private mode etc.) — degrade to "always run", same as game-rate-limit.js's fallback philosophy
    }
}

let listIntervalHandle = null;

async function pickListCadence() {
    try {
        const res = await fetch('/hub-api/round-age');
        const data = await res.json().catch(() => ({}));
        if (data && Number.isInteger(data.days_since) && data.days_since > FREQUENT_PHASE_DAYS) {
            return LIST_INTERVAL_RELAXED_MS;
        }
    } catch (err) { /* default to frequent on any failure — safer than under-syncing early */ }
    return LIST_INTERVAL_FREQUENT_MS;
}

// Unconditional — no lock check, no cadence decision. This is the actual work; both the
// scheduled background puller (runListPull, below) and a member's manual "force it now"
// request (dashboard.js's deep-scan flow) call this directly.
export async function pullPlayerList() {
    const res = await AWApi.getPlayers();
    if (!res.ok) return { ok: false, error: res.reason === 'session' ? 'session' : (res.reason || 'request failed') };
    if (!Array.isArray(res.data) || !res.data.length) return { ok: false, error: 'no active players returned' };
    // The ONE shared API->sync mapper (aw-api.js) — never a local copy of it.
    const { players } = AWApi.mapPlayersToSyncPayload(res.data);
    const syncRes = await fetch('/hub-api/sync/player-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ players }),
    });
    const syncBody = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok || !syncBody.success) return { ok: false, error: syncBody.error || `HTTP ${syncRes.status}` };
    return { ok: true, count: players.length };
}

async function runListPull() {
    if (!claimLock(LIST_LOCK_KEY, LIST_LOCK_TTL_MS)) return;
    try {
        const result = await pullPlayerList();
        if (!result.ok) console.warn('[PlayerApiSync] list pull failed:', result.error);
    } catch (err) {
        console.warn('[PlayerApiSync] list pull failed:', err.message);
    }
}

async function scheduleNextListPull() {
    if (listIntervalHandle) clearTimeout(listIntervalHandle);
    const cadence = await pickListCadence();
    listIntervalHandle = setTimeout(async () => {
        await runListPull();
        scheduleNextListPull();
    }, cadence);
}

// Claims `limit` stale ids and scans each one — the one loop shared by the quiet
// background tick (SWEEP_BATCH_SIZE, no progress reporting) and a member's manual "deep
// scan" (a much larger one-shot limit, reported through onProgress). Claiming is what
// /hub-api/sync/player-scan-claim calls an optimistic claim: it bumps last_api_scan_at
// immediately, so a second caller — another member's browser, or this same one again in
// SWEEP_INTERVAL_MS/the deep-scan cooldown — naturally gets handed the NEXT stale batch
// instead of racing this one for the same ids.
async function scanClaimedBatch(limit, onProgress = () => {}) {
    const claimRes = await fetch(`/hub-api/sync/player-scan-claim?limit=${limit}`, { method: 'POST' });
    const claimed = await claimRes.json().catch(() => ({}));
    if (!claimRes.ok || !claimed.success) {
        return { ok: false, error: claimed.error || `HTTP ${claimRes.status}` };
    }
    const ids = Array.isArray(claimed.ids) ? claimed.ids : [];
    let scanned = 0;
    let failed = 0;
    for (const id of ids) {
        onProgress(`Scanning player ${id}…`, scanned + failed, ids.length);
        const res = await AWApi.getPlayer(id);
        if (!res.ok || !res.data) { failed++; continue; }
        // The ONE shared API->sync mapper (aw-api.js) — never a local copy of it. This is
        // the mapper that drifted from the server's expectations in the race_growth bug
        // (2026-08-30); keeping exactly one copy is what makes that class of bug impossible
        // now, not just fixed once.
        const player = AWApi.mapPlayerDetailToSyncPayload(res.data);
        const detailRes = await fetch('/hub-api/sync/player-detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player }),
        });
        const detailBody = await detailRes.json().catch(() => ({}));
        if (!detailRes.ok || !detailBody.success) {
            console.warn('[PlayerApiSync] player-detail sync failed for', id, detailRes.status, detailBody.error || '');
            failed++;
        } else {
            scanned++;
        }
        onProgress(`Scanned ${scanned + failed}/${ids.length} players…`, scanned + failed, ids.length);
    }
    return { ok: true, claimed: ids.length, scanned, failed };
}

// Shared across BOTH the background tick and a manual deep scan — real production
// incident (2026-09-11): the two used separate flags, so a 60s-interval sweep tick could
// fire WHILE a 150-player deep scan's own getPlayer loop was still running, adding its
// own SWEEP_BATCH_SIZE calls on top from the SAME account. Deep Scan alone (plus its own
// forced list pull) already uses a large share of the account's 200/5min budget — a
// concurrent sweep tick landing on top of that is what tipped it over and cost the tail
// of that run to 429s. One flag for "this account's browser is already spending calls on
// player detail scans" means the two now take turns instead of racing.
let scanning = false;
async function runSweepTick() {
    // Re-entrancy guard: a tick can easily run long (up to SWEEP_BATCH_SIZE sequential
    // getPlayer calls + POSTs can exceed the 60s interval), and the cross-tab
    // claimLock/localStorage check above solves a DIFFERENT problem (another tab/window
    // running its own tick), not this one — an overlapping tick in the SAME tab, OR a
    // manual deep scan already in flight, would otherwise both draw from the same budget
    // at once.
    if (scanning) return;
    if (!claimLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)) return;
    scanning = true;
    try {
        const result = await scanClaimedBatch(SWEEP_BATCH_SIZE);
        if (!result.ok) console.warn('[PlayerApiSync] scan-claim failed:', result.error);
    } catch (err) {
        console.warn('[PlayerApiSync] sweep tick failed:', err.message);
    } finally {
        scanning = false;
    }
}

const DEEP_SCAN_LOCK_KEY = 'awt.playerDeepScan.lock.v1';
const DEEP_SCAN_LOCK_TTL_MS = 5 * 60 * 1000; // "the same player in 5 mins" — a fresh
// browser/tab (another member) is a different localStorage origin-instance in practice
// only when it's a different machine; same-machine tabs share it, which is the point —
// one person mashing the button doesn't restart the claim ahead of the batch actually
// finishing scanning.

// Manual, immediate, much bigger cousin of the background sweep: forces the roster list
// fresh right now instead of waiting on scheduleNextListPull's own clock, then claims and
// scans up to `limit` stale players in one shot instead of trickling SWEEP_BATCH_SIZE per
// minute. Self-cooldown only guards
// against the SAME browser re-claiming before a prior run's batch could even finish; the
// claim endpoint itself is what makes it safe for a DIFFERENT member to run this at the
// same time — they simply get handed whatever the first claim didn't take.
export async function deepScanPlayers(limit, onProgress = () => {}) {
    if (!claimLock(DEEP_SCAN_LOCK_KEY, DEEP_SCAN_LOCK_TTL_MS)) {
        return { ok: false, error: 'cooldown' };
    }
    // Shares `scanning` with the background sweep (see runSweepTick's comment): a manual
    // deep scan already spends a large share of this account's 5-minute budget on its own,
    // so the quiet background tick must not ALSO be spending calls on the same account for
    // the several tens of seconds this loop runs. If a sweep tick is already mid-flight
    // when this starts, that one tick is left to finish rather than aborted — only new
    // ticks are held off.
    if (scanning) {
        return { ok: false, error: 'A background scan is already using this account\'s budget — try again in a moment.' };
    }
    scanning = true;
    try {
        onProgress('Refreshing the player roster…', 0, 0);
        const listResult = await pullPlayerList();
        if (!listResult.ok && listResult.error === 'session') {
            return { ok: false, error: 'session' };
        }
        onProgress('Claiming stale players…', 0, 0);
        const scanResult = await scanClaimedBatch(limit, onProgress);
        if (!scanResult.ok) return scanResult;
        return { ok: true, listUpdated: listResult.ok ? listResult.count : null, ...scanResult };
    } finally {
        scanning = false;
    }
}

let started = false;
export function initPlayerApiSync() {
    if (started) return;
    started = true;
    scheduleNextListPull();
    setInterval(runSweepTick, SWEEP_INTERVAL_MS);
}
