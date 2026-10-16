// Battle-report ship-detail background sweep — wrapper realm only, mirrors
// player-api-sync.js's sweep half (Plan 3) almost exactly: claim a small batch of
// not-yet-scraped reports, scrape each one's page, sync the result back.
//
// Runs independently of battle-sync.js (which populates battle_reports rows from the API
// once a day, after the reset — see that file) — this sweep only ever touches rows that
// already exist, filling in the one thing the API doesn't provide. Once per game day
// (2026-10-16, was every 90s): reports only arrive at the reset, so ONE member's browser,
// rotating between members, drains the day's batch in a single run 30 minutes after it
// (src/repositories/sharedJobs.js, job 'battle-report-detail'). Every request rides on that
// member's own game session, which the game counts as them being active.
//
// Since the game's BattleReport change the search response carries the planet and the
// ship table itself, and /sync/battle-reports marks those reports done on arrival — so
// this sweep only still fetches pages for reports the API could not describe in full
// (older reports, the live API before the change, or a ship type mapApiDetail does not
// recognise). It needs no change of its own for that: the claim query simply finds less.

import '../utils/game-rate-limit.js'; // must load before either gameFetch or aw-api resolves the gate
import '../scrapers/battle-report-parser.js';
import { claimSharedJob } from '../utils/shared-job.js';

const { scrapeBattleReportShipDetail } = globalThis.BattleReportParser;

// How often this browser ASKS the hub whether today's run is due — a hub request, not game traffic.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const JOB = 'battle-report-detail';
// One run drains the day: ~80 reports a day (Oct 2026), and most need no page at all now.
const MAX_BATCHES_PER_RUN = 30;
const SWEEP_BATCH_SIZE = 5; // battle-report pages are heavier fetches than a player profile; keep batches small


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
    if (!globalThis.AWGameRate.isMemberActive()) return; // member away: no game traffic on their session (game-rate-limit.js)
    if (sweeping) return; // in-tab re-entrancy guard — a slow tick must not stack (see Plan 3's fix for the same class of bug)
    sweeping = true;
    try {
        if (!(await claimSharedJob(JOB))) return; // another member has it, or it already ran today
        await runClaimLoop('/hub-api/sync/battle-report-ship-detail-claim', MAX_BATCHES_PER_RUN);
        // The location backfill is a one-time legacy gap (reports scraped before planet
        // capture existed, or by a stale tab running old JS; see
        // getReportsNeedingLocationBackfill), so it rides along and self-terminates.
        await runClaimLoop('/hub-api/sync/battle-report-location-backfill-claim', MAX_BATCHES_PER_RUN);
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
    runSweepTick();
    setInterval(runSweepTick, CHECK_INTERVAL_MS);
}
