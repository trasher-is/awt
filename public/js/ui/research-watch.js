// Research tracker (2026-09-28): reads the viewer's own /Game/Science page, so allies can see
// what they are researching and when it lands. Wrapper realm only.
//
// Member taps only (2026-10-17): this used to run every 15 minutes. Now it runs from the
// "Update my data" button — and spy.js reads the page for free when the member opens Science.
//
// This only READS the page. It never queues or changes research: that stays a member's
// own tap in the game.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseScienceResearchPage, postScienceResearch } from '../scrapers/science-research-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const SCIENCE_PATH = '/Game/Science';

// true when a fresh read reached the hub.
export async function forceResearchSync() {
    try {
        const pageRes = await gameFetch(SCIENCE_PATH);
        if (!pageRes.ok) return false;
        const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
        // null = the page did not parse the way we expect — leave the old snapshot in place.
        return (await postScienceResearch(parseScienceResearchPage(doc))) === true;
    } catch (err) {
        console.warn('[ResearchWatch] sync failed:', err.message);
        return false;
    }
}
