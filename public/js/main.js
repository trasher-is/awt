import { initSpy } from './core/spy.js';

console.log("[Alliance Tools] Booting modular system...");

// 1. Start the URL observer to tell the sidebar where we are
initSpy();

// 2. Load background alliance parser when hitting the core overview route
if (window.location.pathname.toLowerCase().includes('/game/alliance')) {
    import('./scrapers/alliance-parser.js').then(module => module.scrapeAllianceMembers());
}