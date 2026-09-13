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
// "Free" means one of:
//   • the tab is hidden — nobody is looking at it, let alone playing in it, or
//   • nothing has been clicked or typed for IDLE_BEFORE_RELOAD_MS, in the hub OR in the
//     game frame. The frame is same-origin (the hub proxies the game), so its own clicks
//     count as activity; without that a member playing steadily inside the frame looks
//     perfectly idle from out here, which is precisely the person not to interrupt.

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_BEFORE_RELOAD_MS = 10 * 60 * 1000;
const SETTLE_CHECK_MS = 30 * 1000;

let bootVersion = null;
let pendingVersion = null;
let lastActivity = Date.now();
let started = false;
let reloading = false;

async function fetchVersion() {
    try {
        const res = await fetch('/hub-api/version', { cache: 'no-store' });
        if (!res.ok) return null;
        const body = await res.json();
        return typeof body.version === 'string' && body.version ? body.version : null;
    } catch (err) {
        return null; // offline, or the server is mid-restart — try again next tick
    }
}

function markActive() { lastActivity = Date.now(); }

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

function safeToReload() {
    if (document.hidden) return true;
    return Date.now() - lastActivity >= IDLE_BEFORE_RELOAD_MS;
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

    // Latched: a reload is a navigation, not an instant teardown, so both the retry timer
    // and a visibilitychange landing in that window would otherwise each call it again and
    // restart the navigation underneath itself.
    const reloadIfSafe = () => {
        if (reloading || !pendingVersion) return;
        if (!safeToReload()) return;
        reloading = true;
        window.location.reload();
    };

    const check = async () => {
        const version = await fetchVersion();
        if (!version) return;
        if (bootVersion === null) {
            bootVersion = version;
            // Announce to the game frame that this wrapper is new enough to update itself.
            // A wrapper that says nothing predates this file entirely and cannot notice a
            // deploy on its own, so the frame reloads it once — see stale-wrapper-reload.js.
            try { window.__hubBuildVersion = version; } catch (err) { /* not fatal */ }
            return;
        }
        if (version === bootVersion || version === pendingVersion) return;
        pendingVersion = version;
        try { onNotice(version); } catch (err) { /* a failed toast must not block the reload */ }
        reloadIfSafe();
    };

    check();
    setInterval(check, CHECK_INTERVAL_MS);
    // Re-test far more often than we re-ask the server: the answer only changes on a
    // deploy, but whether this is a safe moment changes every time the member steps away.
    setInterval(reloadIfSafe, SETTLE_CHECK_MS);
    document.addEventListener('visibilitychange', reloadIfSafe);
}
