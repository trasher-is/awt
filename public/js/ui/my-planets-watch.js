// My Savings (2026-09-18): background sync of the viewer's own per-planet production —
// wrapper realm only, mirrors best-planets-watch.js's shape. Unlike that watcher this
// never walks the alliance: /Game/Planets is the viewer's own planet list, so it's a
// single fetch, no member links to follow.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseMyPlanetsPage } from '../utils/my-planets-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const PLANETS_PATH = '/Game/Planets';
// Building progress can move much faster than the Best Planets ranking (issue: a level can
// finish in under an hour near the end of a queue), so this checks more often.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'awt.myPlanetsWatch.lock.v1';
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

async function syncMyPlanets() {
    const pageRes = await gameFetch(PLANETS_PATH);
    if (!pageRes.ok) return;
    const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
    const planets = parseMyPlanetsPage(doc);
    if (!planets.length) return; // page didn't parse the way we expect — leave the old snapshot in place
    await fetch('/hub-api/sync/my-planets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planets }),
    });
}

// Lock-gated: for the timer and for opening the tab, where hammering the game on every
// switch would be wasteful. Silently a no-op within the lock window — see forceMyPlanetsSync
// for the explicit "Reload my planets" button, which must not silently do nothing.
export async function runMyPlanetsCheck() {
    if (!claimLock()) return;
    try { await syncMyPlanets(); }
    catch (err) { console.warn('[MyPlanetsWatch] check failed:', err.message); }
}

// Bypasses the lock: a member who explicitly clicked "reload" and gets back the same
// stale list because a background check happened to run 2 minutes ago is a worse
// experience than one extra game request.
export async function forceMyPlanetsSync() {
    try { await syncMyPlanets(); }
    catch (err) { console.warn('[MyPlanetsWatch] forced sync failed:', err.message); }
}

let started = false;
export function initMyPlanetsWatch() {
    if (started) return;
    started = true;
    runMyPlanetsCheck(); // don't wait a full interval on first load
    setInterval(runMyPlanetsCheck, CHECK_INTERVAL_MS);
}
