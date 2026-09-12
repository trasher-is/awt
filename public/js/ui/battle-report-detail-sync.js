// Battle-report ship-detail background sweep — wrapper realm only, mirrors
// player-api-sync.js's sweep half (Plan 3) almost exactly: claim a small batch of
// not-yet-scraped reports, scrape each one's page, sync the result back.
//
// Runs independently of battle-sync.js (which populates battle_reports rows from the API
// once a day, after the reset — see that file) — this sweep only ever touches rows that
// already exist, filling in the one thing the API doesn't provide. Its own 90s clock is
// unchanged by that: it self-limits (the claim query only ever returns what still needs
// scraping), so it quietly drains each day's new batch over a couple of hours and then
// goes idle until the next one, with no need for its own once-a-day schedule.

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
