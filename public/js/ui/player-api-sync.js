// Player API sync — wrapper realm only. Member taps only (2026-10-17): nothing here runs on
// a timer.
//
//   1. ListPlayer pull: the full active-roster list, one API call, pulled right before a
//      scan so the scan works from who is playing now (pullPlayerList below).
//   2. Player/{id} scans: from the "Player API scan" button (deepScanPlayers below). There
//      used to be a continuous background sweep here, one Player/{id} call every 30s from
//      every open hub tab; it was removed on 2026-10-16 because every call rides on the
//      member's own game session and the game counted them as active around the clock. The
//      per-account budget (5 req/s and 200 requests/5min, see docs/game-api.md and
//      AGENTS.md's "Production game API: agreed, with boundaries") still bounds what a
//      manual scan may spend. Claiming via /hub-api/sync/player-scan-claim hands two members
//      scanning at once different players (the claim bumps last_api_scan_at immediately).

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';

const AWApi = globalThis.AWApi;

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

// The ListPlayer pull. Member taps only (2026-10-17): it runs right before a Player API scan
// (deepScanPlayers below) or a Players page scan (dashboard.js), so either scan works from
// the current roster. It used to refresh on its own clock — every 5 minutes early in a
// round, every 6 hours later.
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

// Claims `limit` stale ids and scans each one, reporting through onProgress. Claiming is
// what /hub-api/sync/player-scan-claim calls an optimistic claim: it bumps
// last_api_scan_at immediately, so a second caller — another member's browser, or this
// same one again after the cooldown — naturally gets handed the NEXT stale batch instead
// of racing this one for the same ids.
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

// Re-entrancy guard: one manual scan at a time from this page (a second click while the
// first is still claiming and scanning would spend the same account's budget twice).
let scanning = false;

const DEEP_SCAN_LOCK_KEY = 'awt.playerDeepScan.lock.v1';
const DEEP_SCAN_LOCK_TTL_MS = 5 * 60 * 1000; // "the same player in 5 mins" — a fresh
// browser/tab (another member) is a different localStorage origin-instance in practice
// only when it's a different machine; same-machine tabs share it, which is the point —
// one person mashing the button doesn't restart the claim ahead of the batch actually
// finishing scanning.

// The "Player API scan" button: pulls the roster list fresh, then claims and
// scans up to `limit` stale players in one shot. Self-cooldown only guards
// against the SAME browser re-claiming before a prior run's batch could even finish; the
// claim endpoint itself is what makes it safe for a DIFFERENT member to run this at the
// same time — they simply get handed whatever the first claim didn't take.
export async function deepScanPlayers(limit, onProgress = () => {}) {
    if (!claimLock(DEEP_SCAN_LOCK_KEY, DEEP_SCAN_LOCK_TTL_MS)) {
        return { ok: false, error: 'cooldown' };
    }
    if (scanning) {
        return { ok: false, error: 'A Player API scan is already running — try again in a moment.' };
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

