import { initSpy } from './core/spy.js';
import { initPersistentPlanPills } from './core/page-injections.js';

console.log("[Alliance Tools] Extension Core Engine Loaded.");

initSpy();

function processActiveView() {
    if (document.getElementById("solarSystem")) {
        initPersistentPlanPills();
    }
    
    if (window.location.href.toLowerCase().includes('/game/alliance')) {
        import('./scrapers/alliance-parser.js').then(module => module.scrapeAllianceMembers());
    }
}

// Fire once upon initialization pass
processActiveView();

// Isolate mutations to the primary main body container.
// This completely stops high-frequency execution loops caused by clock timers and updates.
const mainArea = document.querySelector("main");
if (mainArea) {
    const navObserver = new MutationObserver(() => {
        processActiveView();
    });
    navObserver.observe(mainArea, { childList: true });
} else {
    // Structural Fallback if the DOM isn't fully ready
    const fallbackObserver = new MutationObserver((mutations) => {
        const hasNewElements = mutations.some(m => m.addedNodes.length > 0);
        if (hasNewElements) {
            processActiveView();
        }
    });
    fallbackObserver.observe(document.body, { childList: true });
}