// Research tracker (2026-09-28): background read of the viewer's own /Game/Science page, so
// allies can see what they are researching and when it lands without the member having to
// open Science. Wrapper realm only; mirrors my-planets-watch.js exactly — one page, one
// read per interval, lock-gated across tabs through localStorage.
//
// This only READS the page. It never queues or changes research: that stays a member's
// own tap in the game.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseScienceResearchPage, postScienceResearch } from '../scrapers/science-research-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const SCIENCE_PATH = '/Game/Science';
// A level can finish inside an hour, and a new lab moves every timer, so the same cadence
// as My Planets.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'awt.researchWatch.lock.v1';
const LOCK_TTL_MS = 13 * 60 * 1000; // shorter than the interval

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

async function syncResearch() {
    const pageRes = await gameFetch(SCIENCE_PATH);
    if (!pageRes.ok) return;
    const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
    // null = the page did not parse the way we expect — leave the old snapshot in place.
    await postScienceResearch(parseScienceResearchPage(doc));
}

export async function runResearchCheck() {
    if (!claimLock()) return;
    try { await syncResearch(); }
    catch (err) { console.warn('[ResearchWatch] check failed:', err.message); }
}

let started = false;
export function initResearchWatch() {
    if (started) return;
    started = true;
    runResearchCheck(); // don't wait a full interval on first load
    setInterval(runResearchCheck, CHECK_INTERVAL_MS);
}
