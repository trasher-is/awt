// Sidebar widget: who currently has AWT itself open, and who hasn't in the last day.
//
// Deliberately NOT the same thing as the game's own idle_time/last_activity_at
// (players.js/stat-columns.js) — that answers "is this player active in astrowars",
// scraped from the game. This answers "is the TOOL running", from app_users.last_seen_at,
// touched by src/utils/presence-touch.js on every authenticated hub request. A member can
// be deep in a battle on a stale tab (tool closed, still playing) or idling in-game with
// the hub open and syncing in the background (tool open, not "active") — the two numbers
// are expected to disagree.
import '../utils/sqlite-time.js'; // side-effect import: puts AWSqliteTime on globalThis
const { parseSqliteUtc, formatSqliteUtc } = globalThis.AWSqliteTime;

// presence-touch throttles writes to one per 60s (users.js), so a genuinely-open tab can
// go up to a minute between updates even mid-session. 5 minutes gives room for that plus a
// slow poll tick before someone flips from "online" to unlisted.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const INACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

function relativeAge(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function row(user, detailText, dotClass) {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2';
    div.title = formatSqliteUtc(user.last_seen_at, undefined, 'Never opened AWT');
    const dot = document.createElement('span');
    dot.className = `w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`;
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = user.game_name;
    const detail = document.createElement('span');
    detail.className = 'ml-auto text-muted-foreground shrink-0';
    detail.textContent = detailText;
    div.append(dot, name, detail);
    return div;
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
    inactive.sort((a, b) => a.ageMs - b.ageMs);

    el.replaceChildren();

    const onlineHeader = document.createElement('div');
    onlineHeader.className = 'text-muted-foreground';
    onlineHeader.textContent = online.length ? `Online now (${online.length})` : 'Nobody online right now';
    el.appendChild(onlineHeader);
    for (const { user } of online) el.appendChild(row(user, 'online', 'bg-green-500'));

    if (inactive.length) {
        const inactiveHeader = document.createElement('div');
        inactiveHeader.className = 'text-muted-foreground mt-2';
        inactiveHeader.textContent = `Haven't opened AWT in 24h+ (${inactive.length})`;
        el.appendChild(inactiveHeader);
        for (const { user, ageMs } of inactive) {
            el.appendChild(row(user, Number.isFinite(ageMs) ? relativeAge(ageMs) : 'never', 'bg-zinc-600'));
        }
    }
}

let pollHandle = null;
export function initAwtPresence() {
    refreshPresence();
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(refreshPresence, POLL_INTERVAL_MS);
}
