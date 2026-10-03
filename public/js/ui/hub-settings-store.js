// The member's hub settings (which extras and sidebar tools are on), as the browser sees them.
//
// The server holds the truth (GET/POST /hub-api/settings, per account). This keeps a copy in
// localStorage so that both JavaScript realms — the dashboard and the game frame, which load
// this file as two separate instances — can answer "is this on?" synchronously on a repeat
// visit, with no round trip before the first thing is drawn. A `storage` event carries a
// change made in one realm to the other, so toggling a sidebar tool or an extra in Settings
// reaches the game page that is open beside it.
//
// The rules (keys, defaults, what is stored) live in utils/hub-settings.js; nothing here
// knows what any key means.
import '../utils/hub-settings.js';

const S = globalThis.AWHubSettings;
const CACHE_KEY = 'awt.hubSettings.v1';

let overrides = {};
let hadCache = false;
let ready = false;
let readyPromise = null;
const listeners = new Set();

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw !== null) { overrides = S.parseStored(raw); hadCache = true; ready = true; }
    } catch (err) { /* blocked storage: the server copy below still answers */ }
}

function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(overrides)); } catch (err) { /* private mode or full */ }
}

const sameOverrides = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function notify() {
    for (const fn of [...listeners]) {
        try { fn(); } catch (err) { console.error('[HubSettings] listener failed:', err); }
    }
}

// Adopt `next` as the current state; true when it actually changed anything. The copy is
// written even when nothing changed if none exists yet: a member on all defaults is the
// common case, and without it every page load would wait on the server to learn that.
function adopt(next) {
    const clean = S.sanitizeOverrides(next);
    const changed = !sameOverrides(clean, overrides);
    overrides = clean;
    if (changed || !hadCache) { writeCache(); hadCache = true; }
    if (changed) notify();
    return changed;
}

readCache();
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', event => {
        if (event.key !== CACHE_KEY && event.key !== null) return;
        const before = overrides;
        overrides = {};
        readCache();
        if (!sameOverrides(before, overrides)) notify();
    });
}

/** Is this key switched on for the current member? Synchronous. */
export function isEnabled(key) { return S.isEnabled(key, overrides); }

/** Every catalogue key mapped to its effective true/false. */
export function snapshot() { return S.resolve(overrides); }

/** True once the answer is trustworthy: a cached copy exists, or the first server read settled. */
export function isReady() { return ready; }

/** Called after any change, from either realm. Returns the unsubscribe function. */
export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Fetch the server copy and adopt it. Resolves true if it changed what this realm believed. */
export async function refresh() {
    const res = await fetch('/hub-api/settings');
    if (!res.ok) throw new Error(`Settings request failed (${res.status})`);
    const data = await res.json();
    if (!data || !data.success) throw new Error('Settings request failed');
    return adopt(data.overrides);
}

/**
 * Resolves when the settings are known: immediately on a repeat visit (the server copy is
 * still fetched in the background to catch a change made on another device), otherwise after
 * the first server read. A failed or slow read counts as ready — the defaults apply, and the
 * member is never left with a page that never draws. The wait is capped because the game
 * frame's hooks also carry the alliance's data scrapes, which must not hang on a preference.
 */
export const FIRST_READ_TIMEOUT_MS = 3000;
export function whenReady() {
    if (!readyPromise) {
        const first = refresh().catch(err => { console.warn('[HubSettings] could not load:', err.message); });
        if (hadCache) {
            readyPromise = Promise.resolve();
        } else {
            const patience = new Promise(resolve => setTimeout(resolve, FIRST_READ_TIMEOUT_MS));
            readyPromise = Promise.race([first, patience]).then(() => { ready = true; });
        }
    }
    return readyPromise;
}

async function send(body) {
    const res = await fetch('/hub-api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success) throw new Error((data && data.error) || `Could not save (${res.status})`);
    adopt(data.overrides);
}

// A change shows at once and is then confirmed by the server. When the save fails the
// optimistic state is wrong, so go back to what the server holds rather than guess.
async function optimistic(applyLocally, body) {
    applyLocally();
    try {
        await send(body);
    } catch (err) {
        await refresh().catch(() => {});
        throw err;
    }
}

/** Switch things on or off: `{ 'inject.suButtons': false }`. Rejects if the save failed. */
export function change(changes) {
    return optimistic(() => adopt(S.applyChanges(overrides, changes)), { changes });
}

/** Back to the defaults for everything. Rejects if the save failed. */
export function reset() {
    return optimistic(() => adopt({}), { reset: true });
}

/** Forget the local copy — at logout, so the next account on this browser starts clean. */
export function clearCache() {
    overrides = {};
    hadCache = false;
    ready = false;
    readyPromise = null;
    try { localStorage.removeItem(CACHE_KEY); } catch (err) { /* nothing to clear */ }
}
