// Various Changes: Best Planets coverage — wrapper realm only, mirrors bonus-goals-sync.js's
// shape exactly (same reasoning: no server-side game session, so /Ranking/BestPlanets has
// to be fetched from a member's own browser). Deliberately standalone from the SECRET
// bonus-goals ranking_match mechanism even though both watch the same page — see
// /sync/best-planets-snapshot's own comment for why the two must never be merged.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { claimSharedJob } from '../utils/shared-job.js';
import { parseBestPlanetsPage } from '../utils/best-planets-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const RANKING_PATH = '/Ranking/BestPlanets';
// The ranking only changes once a day in-game, so the hub runs this once per game day,
// from ONE member's browser, rotating between members (src/repositories/sharedJobs.js).
// This interval only decides how often this browser ASKS the hub — not game traffic.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const JOB = 'ranking-best-planets';

async function runCheck() {
    if (!globalThis.AWGameRate.isMemberActive()) return; // member away: no game traffic on their session (game-rate-limit.js)
    if (!(await claimSharedJob(JOB))) return; // another member has it, or it already ran today
    try {
        const pageRes = await gameFetch(RANKING_PATH);
        if (!pageRes.ok) return;
        const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
        const rows = parseBestPlanetsPage(doc);
        if (!rows.length) return; // page didn't parse the way we expect — leave the old snapshot in place rather than wiping it with nothing
        await fetch('/hub-api/sync/best-planets-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: rows.map(r => ({ rank: r.rank, game_planet_id: r.game_planet_id, buildings: r.buildings })) }),
        });
    } catch (err) {
        console.warn('[BestPlanetsWatch] check failed:', err.message);
    }
}

let started = false;
export function initBestPlanetsWatch() {
    if (started) return;
    started = true;
    runCheck(); // don't wait a full interval on first load
    setInterval(runCheck, CHECK_INTERVAL_MS);
}
