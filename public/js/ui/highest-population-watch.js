// Various Changes: Highest Population coverage — same shape as best-planets-watch.js
// (see that file's comment for why this stays standalone from the SECRET bonus-goals
// ranking_match mechanism even though it, too, could be pointed at this ranking page).

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { claimSharedJob } from '../utils/shared-job.js';
import { parseRankingPage } from '../utils/ranking-page-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const RANKING_PATH = '/Ranking/HighestPopulation';
// The ranking only changes once a day in-game, so the hub runs this once per game day,
// from ONE member's browser, rotating between members (src/repositories/sharedJobs.js).
// This interval only decides how often this browser ASKS the hub — not game traffic.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const JOB = 'ranking-highest-population';

async function runCheck() {
    if (!globalThis.AWGameRate.isMemberActive()) return; // member away: no game traffic on their session (game-rate-limit.js)
    if (!(await claimSharedJob(JOB))) return; // another member has it, or it already ran today
    try {
        const pageRes = await gameFetch(RANKING_PATH);
        if (!pageRes.ok) return;
        const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
        const rows = parseRankingPage(doc);
        if (!rows.length) return; // page didn't parse the way we expect — leave the old snapshot in place rather than wiping it with nothing
        await fetch('/hub-api/sync/highest-population-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: rows.map(r => ({ rank: r.rank, game_planet_id: r.game_planet_id })) }),
        });
    } catch (err) {
        console.warn('[HighestPopulationWatch] check failed:', err.message);
    }
}

let started = false;
export function initHighestPopulationWatch() {
    if (started) return;
    started = true;
    runCheck(); // don't wait a full interval on first load
    setInterval(runCheck, CHECK_INTERVAL_MS);
}
