// Various Changes: Best Planets coverage — wrapper realm only, mirrors bonus-goals-sync.js's
// shape exactly (same reasoning: no server-side game session, so /Ranking/BestPlanets has
// to be fetched from a member's own browser). Deliberately standalone from the SECRET
// bonus-goals ranking_match mechanism even though both watch the same page — see
// /sync/best-planets-snapshot's own comment for why the two must never be merged.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseRankingPage } from '../utils/ranking-page-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const RANKING_PATH = '/Ranking/BestPlanets';
// The ranking itself only updates once/day in-game (confirmed via bonus-goals-sync.js) —
// hourly is more than enough to catch that within an hour, without spending calls chasing
// a page that hasn't changed.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'awt.bestPlanetsWatch.lock.v1';
const LOCK_TTL_MS = 55 * 60 * 1000; // shorter than the interval

function claimLock() {
    try {
        const raw = localStorage.getItem(LOCK_KEY);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < LOCK_TTL_MS) return false;
        localStorage.setItem(LOCK_KEY, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same fallback as game-rate-limit.js
    }
}

async function runCheck() {
    if (!claimLock()) return;
    try {
        const pageRes = await gameFetch(RANKING_PATH);
        if (!pageRes.ok) return;
        const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
        const rows = parseRankingPage(doc);
        if (!rows.length) return; // page didn't parse the way we expect — leave the old snapshot in place rather than wiping it with nothing
        await fetch('/hub-api/sync/best-planets-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: rows.map(r => ({ rank: r.rank, game_planet_id: r.game_planet_id })) }),
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
