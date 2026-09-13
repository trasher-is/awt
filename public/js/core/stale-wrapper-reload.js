// Gets a member whose hub tab predates self-updating onto a build that can update itself.
//
// version-watch.js makes an open tab notice new builds and reload when it is free to — but
// it only runs in tabs that have already loaded it. A tab opened before it existed will
// never poll, never notice, and never reload, so it sits on that day's JavaScript for as
// long as it stays open (which, for this hub, is hours or days). That is a one-time
// migration problem with no way out from inside the tab itself.
//
// This runs in the GAME FRAME, which is the way out. The proxy injects the hub's script
// into every proxied game page, so the in-frame code is re-fetched on every single
// navigation a member makes while playing — it is always current, no matter how old the
// wrapper around it is. From there the parent is same-origin and can simply be reloaded.
//
// WHEN IT FIRES: only when the wrapper does not announce a build version at all, i.e. it
// predates version-watch entirely. Once a tab has been through this it announces one, and
// this never touches it again — every later deploy is handled politely by version-watch,
// which waits for the member to be idle rather than interrupting. So this is a migration,
// not a policy: it stops applying the moment it has done its job.
//
// WHY IT IS SAFE TO RELOAD HERE: the wrapper keeps its own URL's ?p= in sync with whatever
// page the frame is on, and restores the frame from it on load — so a reload puts the
// member back on the page they were looking at. And this runs immediately after a game page
// has loaded, which is the moment they have the least in progress: they have just clicked
// through to something and have not typed into it yet.

const FORCED_KEY = 'awt.staleWrapperReloaded.v1';

export function reloadWrapperIfPreVersionWatch() {
    let parentWindow;
    try {
        parentWindow = window.parent;
        // Not framed at all, or a frame we are not allowed to touch: nothing to migrate.
        if (!parentWindow || parentWindow === window) return false;
        // A wrapper new enough to announce its build is new enough to update itself.
        if (parentWindow.__hubBuildVersion) return false;
    } catch (err) {
        return false; // cross-origin — not our wrapper
    }

    // Belt and braces against a reload loop. If the wrapper somehow still fails to announce
    // a version after reloading (its scripts blocked, an error before it boots), forcing it
    // again on the next navigation would trap the member in a cycle they cannot escape and
    // cannot diagnose. One attempt per tab session; after that, leave them alone.
    try {
        if (sessionStorage.getItem(FORCED_KEY)) return false;
        sessionStorage.setItem(FORCED_KEY, String(Date.now()));
    } catch (err) {
        return false; // no sessionStorage means no loop guard, so do not risk the loop
    }

    try {
        parentWindow.location.reload();
        return true;
    } catch (err) {
        return false;
    }
}
