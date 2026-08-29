// Battle-report ship-detail background sweep — wrapper realm only, mirrors
// player-api-sync.js's sweep half (Plan 3) almost exactly: claim a small batch of
// not-yet-scraped reports, scrape each one's page, sync the result back.
//
// Runs independently of battle-sync.js (which populates battle_reports rows from the API
// on its own 30-min clock) — this sweep only ever touches rows that already exist,
// filling in the one thing the API doesn't provide.

import '../utils/game-rate-limit.js'; // must load before either gameFetch or aw-api resolves the gate
import './battle-report-parser.js';

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

let sweeping = false;

async function runSweepTick() {
    if (sweeping) return; // in-tab re-entrancy guard — a slow tick must not stack (see Plan 3's fix for the same class of bug)
    if (!claimLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)) return; // cross-tab guard
    sweeping = true;
    try {
        const claimRes = await fetch('/hub-api/sync/battle-report-ship-detail-claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: SWEEP_BATCH_SIZE }),
        });
        if (!claimRes.ok) { console.warn('[BattleReportDetailSync] claim failed:', claimRes.status); return; }
        const claimed = await claimRes.json().catch(() => ({}));
        if (!claimed.success) { console.warn('[BattleReportDetailSync] claim response not successful:', claimed); return; }
        const ids = Array.isArray(claimed.ids) ? claimed.ids : [];

        for (const id of ids) {
            const detail = await scrapeBattleReportShipDetail(id);
            if (!detail) continue; // scrape/parse failed — report stays claimed (already scraped=now), acceptable data gap, not retried
            const syncRes = await fetch('/hub-api/sync/battle-report-ship-detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...detail }),
            });
            if (!syncRes.ok) { console.warn('[BattleReportDetailSync] sync failed for report', id, syncRes.status); continue; }
            const syncBody = await syncRes.json().catch(() => ({}));
            if (!syncBody.success) console.warn('[BattleReportDetailSync] sync response not successful for report', id, syncBody);
        }
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
