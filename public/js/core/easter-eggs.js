// A squadron flyby, for anyone who still remembers the Konami code.
//
// ─── THE RULES AN EASTER EGG IN THIS TOOL HAS TO KEEP ─────────────────────────
// This file is injected into the proxied GAME page (src/proxy.js injects main.js, which
// imports this). That is the one place in the repository where a bit of fun could do real
// damage, so it is built to be provably harmless:
//
//   • it never touches the network. No fetch, no gameFetch, no XMLHttpRequest. The rate
//     limit in game-rate-limit.js is a promise made to the game's administrator, and a
//     decoration is not a reason to spend any part of it. easter-eggs.test.js scans this
//     file's source and fails if a request of any kind appears in it.
//   • it never touches the game's DOM. Everything it draws lives in one fixed-position
//     overlay appended to <body> with pointer-events:none, and that overlay removes
//     itself when the animation ends. The scrapers read the game's markup; a decoration
//     that inserted anything into it could shift a column and write wrong data silently,
//     which is exactly the failure AWScrape exists to catch.
//   • it is deliberate. Ten keys in the right order is not something anyone does by
//     accident, so nobody gets an animation they did not ask for.
//   • it respects prefers-reduced-motion by not animating at all — the toast still fires,
//     so the egg is still findable by someone who has motion turned off.
//
// The sequence detector is pulled out as a plain function so the tests can run it without
// a DOM, the same way page-injection-clock.test.js lifts its helpers.

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

const OVERLAY_ID = 'awt-squadron-overlay';
const FLIGHT_MS = 4200;
const SHIP_COUNT = 7;

// A single key does not carry its own case: a letter is compared case-insensitively
// because caps lock is not meant to be part of the puzzle, while 'ArrowUp' is a name and
// is compared exactly.
function sameKey(want, pressed) {
    if (typeof want !== 'string' || typeof pressed !== 'string') return false;
    return want.length === 1 ? want.toLowerCase() === pressed.toLowerCase() : want === pressed;
}

// How much of a matched prefix survives a mismatch: the longest proper prefix of
// sequence[0..len-1] that is also a suffix of it. Ten keys, so this is computed directly
// rather than with a precomputed table.
function longestBorder(sequence, len) {
    for (let size = len - 1; size > 0; size--) {
        let match = true;
        for (let i = 0; i < size; i++) {
            if (!sameKey(sequence[i], sequence[len - size + i])) { match = false; break; }
        }
        if (match) return size;
    }
    return 0;
}

// Advance a sequence matcher by one key. Returns the new progress, and whether the
// sequence just completed.
//
// The mismatch case is the whole reason this is a function with a test rather than three
// lines inline. Resetting to zero on a wrong key is the classic bug: press up-up-UP and
// then carry on correctly, and a naive matcher is stuck, because it threw away the fact
// that the last two ups are a perfectly good start. Pressing a key twice by accident is
// the single most likely way to fumble this sequence, so the matcher falls back to the
// longest still-valid prefix and tries again — the standard string-search backtrack.
function advanceSequence(progress, key, sequence = KONAMI) {
    let at = Math.max(0, Math.min(progress | 0, sequence.length));
    for (;;) {
        if (at < sequence.length && sameKey(sequence[at], key)) {
            const next = at + 1;
            return next >= sequence.length ? { progress: 0, fired: true } : { progress: next, fired: false };
        }
        if (at === 0) return { progress: 0, fired: false };
        at = longestBorder(sequence, at);
    }
}

// Typing "bab" into the message box must not scramble a squadron.
function isTypingTarget(element) {
    if (!element) return false;
    const tag = (element.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}

function prefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (err) {
        return false;
    }
}

// One ship: a small arrowhead, drawn in SVG so no canvas has to be kept alive.
function shipSvg(delayMs, topPercent, scale, durationMs) {
    return `<svg viewBox="0 0 24 12" width="${Math.round(34 * scale)}" height="${Math.round(17 * scale)}"
        style="position:absolute;top:${topPercent}%;left:-8%;opacity:0.9;
               animation:awt-squadron-fly ${durationMs}ms linear ${delayMs}ms 1 both;">
        <defs><linearGradient id="awt-wake-${delayMs}" x1="1" x2="0">
            <stop offset="0" stop-color="rgba(34,211,238,0.55)"/><stop offset="1" stop-color="rgba(34,211,238,0)"/>
        </linearGradient></defs>
        <rect x="0" y="5" width="14" height="2" fill="url(#awt-wake-${delayMs})"/>
        <path d="M24 6 L10 11 L13 6 L10 1 Z" fill="#a5f3fc"/>
    </svg>`;
}

/**
 * Fly a squadron across the page and take the overlay away again.
 * Does nothing (beyond the toast) when the viewer has asked for reduced motion.
 */
function flySquadron(doc = document) {
    doc.getElementById(OVERLAY_ID)?.remove();

    const overlay = doc.createElement('div');
    overlay.id = OVERLAY_ID;
    // pointer-events:none is the load-bearing property here: the member must be able to
    // keep playing through the animation, and nothing the game listens for may be eaten.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden;';

    const reduced = prefersReducedMotion();
    if (!reduced) {
        const style = doc.createElement('style');
        style.textContent = '@keyframes awt-squadron-fly{from{transform:translateX(0)}to{transform:translateX(125vw)}}';
        overlay.appendChild(style);
        let ships = '';
        for (let i = 0; i < SHIP_COUNT; i++) {
            // A loose V: the middle ships lead, the outer ones trail.
            const offset = i - (SHIP_COUNT - 1) / 2;
            ships += shipSvg(Math.round(Math.abs(offset) * 160), 28 + offset * 5, 1 - Math.abs(offset) * 0.08, FLIGHT_MS);
        }
        const fleet = doc.createElement('div');
        fleet.style.cssText = 'position:absolute;inset:0;';
        fleet.innerHTML = ships;
        overlay.appendChild(fleet);
    }

    const toast = doc.createElement('div');
    toast.textContent = 'RAID squadron scrambled.';
    toast.style.cssText = 'position:absolute;left:50%;top:12%;transform:translateX(-50%);'
        + 'font-family:ui-monospace,monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;'
        + 'color:#a5f3fc;background:rgba(0,0,0,0.65);border:1px solid rgba(34,211,238,0.4);'
        + 'padding:6px 12px;border-radius:4px;';
    overlay.appendChild(toast);

    doc.body.appendChild(overlay);
    // Cleaned up unconditionally, animation or not — an overlay left behind would sit over
    // the game forever, invisible and swallowing nothing but still there.
    setTimeout(() => overlay.remove(), reduced ? 2000 : FLIGHT_MS + 600);
    return overlay;
}

export function initEasterEggs() {
    let progress = 0;
    window.addEventListener('keydown', (event) => {
        if (isTypingTarget(event.target)) { progress = 0; return; }
        const step = advanceSequence(progress, event.key);
        progress = step.progress;
        if (step.fired) flySquadron(document);
    });
}
