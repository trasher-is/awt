// Notices when the server is serving a newer build than this tab is running, and reloads —
// but only at a moment when reloading costs the member nothing.
//
// The hub is meant to be left open for hours (the galaxy auto-seed only runs from an open
// tab), and ES modules are fetched once at page load and then live in memory for the life
// of the page. So a deploy reached nobody until each member happened to reload. Confirmed
// live (2026-09-13): a fix verified working server-side sat inert for hours because every
// syncing tab was still running the previous build's JavaScript.
//
// WHY NOT JUST RELOAD: Wrapper.html holds the live game in an iframe. Reloading the top
// window reloads that frame too, so doing it while someone is mid-move — a fleet being
// launched, a battle calculator half filled in — would throw away real work to deliver a
// change they did not ask for. So a new build never interrupts: it waits for a moment that
// is provably free, and says so in the meantime.
//
// WHEN, THEN: the moment the member comes back. Reloading reloads the game frame, which is a
// request to the game on the member's own session — and the game counts that as them being
// active. So a tab nobody is using is never reloaded (2026-10-16; it used to reload hidden
// and idle tabs straight away). Instead the new build loads on whichever comes first:
//   • the tab becomes visible again, or
//   • the first click or keypress after IDLE_BEFORE_RELOAD_MS of nothing, in the hub OR in
//     the game frame. The frame is same-origin (the hub proxies the game), so its own clicks
//     count; without that a member playing steadily inside the frame looks perfectly idle
//     from out here, which is precisely the person not to interrupt.
// A member busy right now is never interrupted; someone just back has nothing in progress.

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_BEFORE_RELOAD_MS = 10 * 60 * 1000;

let bootVersion = null;
let pendingVersion = null;
let lastActivity = Date.now();
let started = false;
let reloading = false;

// Once this tab knows which build it loaded, every poll also reports it, so the admin page can
// show whose open tab is behind (src/utils/hub-tabs.js). The id only tells this tab apart from
// the same member's other tabs; it is new on every page load.
const tabId = (() => {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (err) { /* not a secure context */ }
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();

async function fetchVersion() {
    const query = bootVersion ? `?tab=${encodeURIComponent(tabId)}&build=${encodeURIComponent(bootVersion)}` : '';
    try {
        const res = await fetch(`/hub-api/version${query}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const body = await res.json();
        return typeof body.version === 'string' && body.version ? body.version : null;
    } catch (err) {
        return null; // offline, or the server is mid-restart — try again next tick
    }
}

// Set by initVersionWatch: loads a waiting build. Called when activity follows an idle spell.
let onReturn = () => {};

function markActive() {
    const t = Date.now();
    const wasIdle = t - lastActivity >= IDLE_BEFORE_RELOAD_MS;
    lastActivity = t;
    if (wasIdle) onReturn();
}

// The game frame navigates constantly, and each navigation replaces its document, so the
// listeners have to be re-attached on every load. Wrapped because a frame showing a
// cross-origin page (or one not yet loaded) throws on contentDocument.
function watchGameFrameActivity() {
    const frame = document.getElementById('game-frame');
    if (!frame) return;
    const attach = () => {
        try {
            const doc = frame.contentDocument;
            if (!doc) return;
            doc.addEventListener('pointerdown', markActive, true);
            doc.addEventListener('keydown', markActive, true);
        } catch (err) { /* not reachable from here — frame navigation alone still counts */ }
    };
    frame.addEventListener('load', () => { markActive(); attach(); });
    attach();
}

// onNotice(version) fires once per newly-detected build, for whatever the host wants to
// show the member — the reload itself is not conditional on it.
export function initVersionWatch(onNotice = () => {}) {
    if (started) return;
    started = true;

    for (const type of ['pointerdown', 'keydown']) {
        document.addEventListener(type, markActive, true);
    }
    watchGameFrameActivity();

    // Latched: a reload is a navigation, not an instant teardown, so a visibilitychange or
    // a second click landing in that window would otherwise call it again and restart the
    // navigation underneath itself. Never from a hidden tab — nobody is there.
    const reloadIfWaiting = () => {
        if (reloading || !pendingVersion || document.hidden) return;
        reloading = true;
        window.location.reload();
    };
    onReturn = reloadIfWaiting;

    const check = async () => {
        const version = await fetchVersion();
        if (!version) return;
        if (bootVersion === null) {
            bootVersion = version;
            // Announce to the game frame that this wrapper is new enough to update itself.
            // A wrapper that says nothing predates this file entirely and cannot notice a
            // deploy on its own, so the frame reloads it once — see stale-wrapper-reload.js.
            try { window.__hubBuildVersion = version; } catch (err) { /* not fatal */ }
            // Report straight away rather than five minutes from now.
            fetchVersion();
            return;
        }
        if (version === bootVersion || version === pendingVersion) return;
        pendingVersion = version;
        try { onNotice(version); } catch (err) { /* a failed toast must not block the reload */ }
        // Nothing more here: the reload waits for the member's return (see the header).
    };

    check();
    setInterval(check, CHECK_INTERVAL_MS);
    // Coming back to the tab: visible again, and nothing in progress yet.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reloadIfWaiting(); });
}
