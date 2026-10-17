// My Savings (2026-09-18): reads the viewer's own /Game/Planets overview for per-planet
// production — wrapper realm only. /Game/Planets is the viewer's own planet list, so it's a
// single fetch, no member links to follow.
//
// Member taps only (2026-10-17): this used to run every 15 minutes and whenever the My Savings
// tab opened. Now it runs from the "Update my data" button and My Savings' Reload button —
// and spy.js reads the page for free when the member opens Planets.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseMyPlanetsPage, postMyPlanets } from '../utils/my-planets-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const PLANETS_PATH = '/Game/Planets';

// true when a fresh read reached the hub.
export async function forceMyPlanetsSync() {
    try {
        const pageRes = await gameFetch(PLANETS_PATH);
        if (!pageRes.ok) return false;
        const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
        return await postMyPlanets(parseMyPlanetsPage(doc));
    } catch (err) {
        console.warn('[MyPlanetsWatch] sync failed:', err.message);
        return false;
    }
}
