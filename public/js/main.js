import { initSpy } from './core/spy.js';

console.log("[Alliance Tools] Extension Core Engine Loaded.");

initSpy();

// The alliance scrape walks every member's profile one request at a time, so it has to run
// once per visit to that page - not once per DOM mutation. The observer below fires on
// every repaint the game makes, and its clocks tick constantly, so each tick used to start
// another full pass and they stacked into overlapping bursts of requests at the game.
// Narrowing the observer to <main> (see the original comment) reduced how often it fired,
// but nothing limited what it started.
//
// Three guards, because each covers a different case: the debounce collapses a burst of
// mutations into one pass, inFlight stops a second pass beginning while one is running,
// and lastScrapedUrl stops re-scraping a page that has already been done.
let allianceScanInFlight = false;
let lastScrapedUrl = '';
let processTimer = null;

function scrapeAllianceOnce() {
    const url = window.location.href.toLowerCase();
    if (allianceScanInFlight || url === lastScrapedUrl) return;

    allianceScanInFlight = true;
    lastScrapedUrl = url;

    import('./scrapers/alliance-parser.js')
        .then(module => module.scrapeAllianceMembers())
        .catch(err => {
            // Clear the URL guard so the next navigation retries, rather than letting one
            // failure wedge this page shut for the rest of the session.
            lastScrapedUrl = '';
            console.error('[Alliance Tools] Alliance scrape failed:', err);
        })
        .finally(() => { allianceScanInFlight = false; });
}

function processActiveView() {
    // Plan badges on the system table are spy.js's job now (INJECT_TACTICAL_OVERLAYS,
    // sent whenever the sidebar loads a system's plans) — a separate, older pill renderer
    // used to live here too and ran independently of that system, so a planet with a plan
    // ended up with BOTH a "Plan" badge (spy.js) and a "PLAN" badge (this one) stacked on
    // the same row.

    if (window.location.href.toLowerCase().includes('/game/alliance')) {
        scrapeAllianceOnce();
    } else if (lastScrapedUrl) {
        // Navigated away, so re-opening the alliance page should scrape it again.
        lastScrapedUrl = '';
    }
}

// Collapse a burst of mutations into a single pass.
function scheduleProcessActiveView() {
    clearTimeout(processTimer);
    processTimer = setTimeout(processActiveView, 300);
}

// Fire once upon initialization pass
processActiveView();

// Isolate mutations to the primary main body container.
// This completely stops high-frequency execution loops caused by clock timers and updates.
const mainArea = document.querySelector("main");
if (mainArea) {
    const navObserver = new MutationObserver(() => {
        scheduleProcessActiveView();
    });
    navObserver.observe(mainArea, { childList: true });
} else {
    // Structural Fallback if the DOM isn't fully ready
    const fallbackObserver = new MutationObserver((mutations) => {
        const hasNewElements = mutations.some(m => m.addedNodes.length > 0);
        if (hasNewElements) {
            scheduleProcessActiveView();
        }
    });
    fallbackObserver.observe(document.body, { childList: true });
}
