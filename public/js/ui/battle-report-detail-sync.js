// Battle-report ship-detail background sweep — wrapper realm only, mirrors
// player-api-sync.js's sweep half (Plan 3) almost exactly: claim a small batch of
// not-yet-scraped reports, scrape each one's page, sync the result back.
//
// Runs independently of battle-sync.js (which populates battle_reports rows from the API
// on its own 30-min clock) — this sweep only ever touches rows that already exist,
// filling in the one thing the API doesn't provide.

import '../utils/game-rate-limit.js'; // must load before either gameFetch or aw-api resolves the gate
import '../scrapers/battle-report-parser.js';

const { scrapeBattleReportShipDetail } = globalThis.BattleReportParser;

const SWEEP_INTERVAL_MS = 90 * 1000; // slower than the player sweep — battle reports are much lower volume
const SWEEP_LOCK_KEY = 'awt.battleReportDetailSync.lock.v1';
const SWEEP_LOCK_TTL_MS = 80 * 1000; // shorter than the interval
const SWEEP_BATCH_SIZE = 5; // battle-report pages are heavier fetches than a player profile; keep batches small

function claimLock(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ttlMs) return false;
        localStorage.setItem(key, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same fallback philosophy as game-rate-limit.js
    }
}

// Shared claim/scrape/sync loop for both endpoints below — the two claim routes
// (battle-report-ship-detail-claim, battle-report-location-backfill-claim) return the
// same {success, ids} shape and both hand their ids to the same scrape+sync pair, so
// there is nothing endpoint-specific happening inside the loop itself.
async function runClaimLoop(claimUrl, maxBatches) {
    let scraped = 0;
    let claimed = 0;
    for (let i = 0; i < maxBatches; i++) {
        const claimRes = await fetch(claimUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: SWEEP_BATCH_SIZE }),
        });
        if (!claimRes.ok) return { ok: false, error: `claim failed (${claimRes.status})`, scraped, claimed };
        const claimedBody = await claimRes.json().catch(() => ({}));
        if (!claimedBody.success) return { ok: false, error: 'claim response not successful', scraped, claimed };
        const ids = Array.isArray(claimedBody.ids) ? claimedBody.ids : [];
        if (!ids.length) break; // caught up
        claimed += ids.length;

        for (const id of ids) {
            const detail = await scrapeBattleReportShipDetail(id);
            if (!detail) continue; // scrape/parse failed — stays claimed, acceptable data gap, not retried
            const syncRes = await fetch('/hub-api/sync/battle-report-ship-detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...detail }),
            });
            if (!syncRes.ok) continue;
            const syncBody = await syncRes.json().catch(() => ({}));
            if (syncBody.success) scraped++;
        }
        if (ids.length < SWEEP_BATCH_SIZE) break; // a partial page means nothing is left to claim
    }
    return { ok: true, scraped, claimed };
}

let sweeping = false;

async function runSweepTick() {
    if (sweeping) return; // in-tab re-entrancy guard — a slow tick must not stack (see Plan 3's fix for the same class of bug)
    if (!claimLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)) return; // cross-tab guard
    sweeping = true;
    try {
        await runClaimLoop('/hub-api/sync/battle-report-ship-detail-claim', 1);
        // One backfill batch per tick too — this is a one-time legacy gap (reports
        // scraped before planet capture existed, or by a stale tab running old JS; see
        // getReportsNeedingLocationBackfill), so it self-terminates as it catches up
        // rather than needing its own separate timer.
        await runClaimLoop('/hub-api/sync/battle-report-location-backfill-claim', 1);
    } catch (err) {
        console.warn('[BattleReportDetailSync] sweep tick failed:', err.message);
    } finally {
        sweeping = false;
    }
}

let started = false;
export function initBattleReportDetailSync() {
    if (started) return;
    started = true;
    setInterval(runSweepTick, SWEEP_INTERVAL_MS);
}

// Manual "scrape now" — a sidebar button paired with battle-sync.js's triggerManualSync,
// so clicking once both pulls new reports AND immediately backfills their planet/CV
// location instead of waiting up to SWEEP_INTERVAL_MS for the background timer. Unlike
// runSweepTick this loops across multiple claim batches (a fresh resync can easily bring
// in more than SWEEP_BATCH_SIZE reports at once) until it catches up or hits the safety
// cap, and it bypasses the lock — an explicit click should always run even if the
// background timer just claimed the lock a moment ago.
let manualSweeping = false;
export async function triggerManualSweep(maxBatches = 10) {
    if (manualSweeping) return { ok: false, error: 'a sweep is already running' };
    manualSweeping = true;
    try {
        return await runClaimLoop('/hub-api/sync/battle-report-ship-detail-claim', maxBatches);
    } catch (err) {
        return { ok: false, error: err.message, scraped: 0, claimed: 0 };
    } finally {
        manualSweeping = false;
    }
}

// Manual "backfill legacy locations now" — same idea as triggerManualSweep but for
// reports already scraped with no system_id (see getReportsNeedingLocationBackfill).
let manualBackfilling = false;
export async function triggerManualLocationBackfill(maxBatches = 10) {
    if (manualBackfilling) return { ok: false, error: 'a backfill is already running' };
    manualBackfilling = true;
    try {
        return await runClaimLoop('/hub-api/sync/battle-report-location-backfill-claim', maxBatches);
    } catch (err) {
        return { ok: false, error: err.message, scraped: 0, claimed: 0 };
    } finally {
        manualBackfilling = false;
    }
}
