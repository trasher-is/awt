// Background sync for the 'ranking_match' bonus-goal type — wrapper realm only, mirrors
// battle-report-detail-sync.js's shape. There is no server-side game session (see
// player-api-sync.js's own header comment), so whatever ranking page a goal watches has to
// be fetched from a member's own browser like every other scrape in this hub.
//
// Deliberately generic: this file has no idea what any goal is FOR, only that it points at
// some /Ranking/... page shaped like "a table with a leading rank number per row and a
// /Game/Map/Planet/{id} link somewhere in that row" — see database.js's bonus_goals
// comment for why the specifics live only in config data, never here.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
const { gameFetch } = globalThis.AWGameRate;

// The underlying ranking itself only updates once/day in-game — hourly is more than
// enough to catch that within an hour of it happening, without spending calls chasing a
// page that hasn't changed.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'awt.bonusGoalsRankingSync.lock.v1';
const LOCK_TTL_MS = 55 * 60 * 1000; // shorter than the interval

function claimLock(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ttlMs) return false;
        localStorage.setItem(key, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same fallback as game-rate-limit.js
    }
}

// A row counts if it has a leading integer rank AND a /Game/Map/Planet/{id} link
// somewhere in it — nothing more specific than that. Owner name/tag are best-effort
// extras for the admin page's own readability; neither is required for the row to score.
function parseRankingPage(doc) {
    const rows = [];
    doc.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (!cells.length) return;
        const rank = parseInt((cells[0].textContent || '').trim(), 10);
        if (!Number.isInteger(rank) || rank <= 0) return;
        const planetLink = tr.querySelector('a[href^="/Game/Map/Planet/"]');
        if (!planetLink) return;
        const gamePlanetId = parseInt((planetLink.getAttribute('href') || '').split('/').pop(), 10);
        if (!Number.isInteger(gamePlanetId)) return;
        const ownerLink = tr.querySelector('a[href*="/Game/Players/Profile/"]');
        const tagLink = tr.querySelector('a[href*="/Game/Alliance/Profile/"]');
        rows.push({
            rank,
            game_planet_id: gamePlanetId,
            owner_name: ownerLink ? ownerLink.textContent.trim() : null,
            owner_alliance_tag: tagLink ? tagLink.textContent.trim() : null,
        });
    });
    return rows;
}

async function syncOneTarget(target) {
    const path = target && target.config && target.config.ranking_path;
    if (typeof path !== 'string' || !path.startsWith('/')) return; // malformed config — nothing sane to fetch
    const pageRes = await gameFetch(path);
    if (!pageRes.ok) return;
    const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
    const rows = parseRankingPage(doc);
    if (!rows.length) return; // page didn't parse the way we expect — leave the old snapshot in place rather than wiping it with nothing
    await fetch('/hub-api/sync/bonus-goals/ranking-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_id: target.goal_id, rows }),
    });
}

async function runCheck() {
    if (!claimLock(LOCK_KEY, LOCK_TTL_MS)) return;
    try {
        const res = await fetch('/hub-api/sync/bonus-goals/ranking-targets');
        if (!res.ok) return;
        const body = await res.json().catch(() => ({}));
        const targets = Array.isArray(body.targets) ? body.targets : [];
        for (const target of targets) {
            try { await syncOneTarget(target); } catch (err) {
                console.warn('[BonusGoalsSync] ranking scrape failed for goal', target.goal_id, err.message);
            }
        }
    } catch (err) {
        console.warn('[BonusGoalsSync] check failed:', err.message);
    }
}

let started = false;
export function initBonusGoalsSync() {
    if (started) return;
    started = true;
    runCheck(); // don't wait a full interval on first load — a stale/missing snapshot should resolve as soon as possible
    setInterval(runCheck, CHECK_INTERVAL_MS);
}
