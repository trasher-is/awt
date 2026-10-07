// Which hub tabs are open right now, and which build each one is running.
//
// Every open dashboard polls /hub-api/version every five minutes (public/js/ui/version-watch.js)
// and reloads itself onto a new build once the member is idle. A tab that is being actively
// played in never gets that idle moment, so it can run old code for hours, and the only person
// who can fix that is the member, if somebody tells them. Each poll now says which build the
// tab loaded, so an admin can see who to ask.
//
// Kept in memory, per tab, on purpose: a member often has the hub open on a phone and a desktop
// at once, and one row per account would show whichever reported last. A restart (every deploy)
// empties it, and every open tab reports again within one poll. A tab that stops reporting
// (closed, asleep) drops off after TAB_TTL_MS.

const TAB_TTL_MS = 15 * 60 * 1000;
const MAX_TABS = 1000;
const TAB_ID = /^[A-Za-z0-9-]{8,64}$/;
const BUILD = /^[0-9a-f]{6,64}$/;

function createHubTabs({ ttlMs = TAB_TTL_MS, maxTabs = MAX_TABS } = {}) {
    const tabs = new Map(); // key `${userId}:${tabId}` -> { userId, tabId, build, browser, mobile, seenAt }

    function prune(now) {
        for (const [key, tab] of tabs) {
            if (now - tab.seenAt > ttlMs) tabs.delete(key);
        }
    }

    // Returns true when the report was kept. Anything malformed is ignored: this is a display
    // aid fed by the browser, never an input to anything else.
    function report({ userId, tabId, build, browser = 'other', mobile = 0 }, now = Date.now()) {
        if (!Number.isInteger(userId) || userId <= 0) return false;
        if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) return false;
        if (typeof build !== 'string' || !BUILD.test(build)) return false;
        const key = `${userId}:${tabId}`;
        if (!tabs.has(key) && tabs.size >= maxTabs) {
            prune(now);
            if (tabs.size >= maxTabs) {
                // Still full of live entries: drop the stalest rather than refuse a real tab.
                let oldestKey = null;
                for (const [k, t] of tabs) if (oldestKey === null || t.seenAt < tabs.get(oldestKey).seenAt) oldestKey = k;
                tabs.delete(oldestKey);
            }
        }
        tabs.set(key, { userId, tabId, build, browser, mobile: mobile ? 1 : 0, seenAt: now });
        return true;
    }

    function list(now = Date.now()) {
        prune(now);
        return [...tabs.values()].map(t => ({ ...t }));
    }

    return { report, list, size: () => tabs.size };
}

// The one registry the routes share.
const hubTabs = createHubTabs();

module.exports = { createHubTabs, hubTabs, TAB_TTL_MS };
