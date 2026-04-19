import { initSpy } from './core/spy.js';

console.log("[Alliance Tools] Booting modular system...");

// 1. Start the URL observer to tell the sidebar where we are
initSpy();

// 2. We will import and run specific scrapers here later based on the URL
// if (window.location.pathname.toLowerCase().includes('/game/system')) {
//     import('./scrapers/system-parser.js').then(module => module.scrapeSystem());
// }