// Sidebar widget: who currently has AWT itself open, and who hasn't in the last day.
//
// Deliberately NOT the same thing as the game's own idle_time/last_activity_at
// (players.js/stat-columns.js) — that answers "is this player active in astrowars",
// scraped from the game. This answers "is the TOOL running", from app_users.last_seen_at,
// touched by src/utils/presence-touch.js on every authenticated hub request. A member can
// be deep in a battle on a stale tab (tool closed, still playing) or idling in-game with
// the hub open and syncing in the background (tool open, not "active") — the two numbers
// are expected to disagree.
//
// Rendered as a plain "name | name | name" line rather than one row per member — this is
// a glance-at widget in a narrow sidebar, not a table; the exact last-seen time is still
// available as a hover title per name.
import '../utils/sqlite-time.js'; // side-effect import: puts AWSqliteTime on globalThis
const { parseSqliteUtc, formatSqliteUtc } = globalThis.AWSqliteTime;

// presence-touch throttles writes to one per 60s (users.js), so a genuinely-open tab can
// go up to a minute between updates even mid-session. 5 minutes gives room for that plus a
// slow poll tick before someone flips from "online" to unlisted.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const INACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

function appendPipedNames(el, users, nameClass) {
    users.forEach((user, i) => {
        const span = document.createElement('span');
        span.className = nameClass;
        span.textContent = user.game_name;
        span.title = formatSqliteUtc(user.last_seen_at, undefined, 'Never opened AWT');
        el.appendChild(span);
        if (i < users.length - 1) {
            const sep = document.createElement('span');
            sep.className = 'text-muted-foreground';
            sep.textContent = ' | ';
            el.appendChild(sep);
        }
    });
}

async function refreshPresence() {
    const el = document.getElementById('awt-presence-list');
    if (!el) return;
    let data;
    try {
        const res = await fetch('/hub-api/users/presence');
        data = await res.json();
    } catch (err) {
        return; // leave whatever was last rendered rather than flashing empty on a blip
    }
    if (!data || !data.success || !Array.isArray(data.users)) return;

    const now = Date.now();
    const online = [];
    const inactive = [];
    for (const u of data.users) {
        const seen = u.last_seen_at ? parseSqliteUtc(u.last_seen_at) : null;
        const ageMs = seen ? now - seen.getTime() : Infinity;
        if (ageMs <= ONLINE_WINDOW_MS) online.push({ user: u, ageMs });
        else if (ageMs >= INACTIVE_WINDOW_MS) inactive.push({ user: u, ageMs });
    }
    online.sort((a, b) => a.user.game_name.localeCompare(b.user.game_name));
    inactive.sort((a, b) => a.ageMs - b.ageMs); // most-recently-seen-of-the-stale first

    el.replaceChildren();

    const onlineHeader = document.createElement('div');
    onlineHeader.className = 'text-muted-foreground';
    onlineHeader.textContent = online.length ? `Online now (${online.length})` : 'Nobody online right now';
    el.appendChild(onlineHeader);
    if (online.length) {
        // A plain (non-flex) container: the names and " | " separators are just inline
        // spans that wrap like normal text. A flex/flex-wrap container blockifies each
        // span into its own flex item, and a flex item's own leading/trailing space is
        // then collapsed as line-edge whitespace — which is what made this look cramped
        // ("caveman|h87" instead of "caveman | h87") the first time round.
        const onlineLine = document.createElement('div');
        appendPipedNames(onlineLine, online.map(o => o.user), 'text-green-400');
        el.appendChild(onlineLine);
    }

    if (inactive.length) {
        const inactiveHeader = document.createElement('div');
        inactiveHeader.className = 'text-muted-foreground mt-2';
        inactiveHeader.textContent = `Haven't opened AWT in 24h+ (${inactive.length})`;
        el.appendChild(inactiveHeader);
        const inactiveLine = document.createElement('div');
        appendPipedNames(inactiveLine, inactive.map(i => i.user), 'text-muted-foreground');
        el.appendChild(inactiveLine);
    }
}

let pollHandle = null;
export function initAwtPresence() {
    refreshPresence();
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(refreshPresence, POLL_INTERVAL_MS);
}
