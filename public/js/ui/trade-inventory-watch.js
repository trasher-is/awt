// Hoard A$ (2026-09-19): background sync of the viewer's own /Game/Trade inventory value.
// Previously the only way this ever updated was spy.js's onNavigate hook, which only fires
// while the member happens to have /Game/Trade open in the embedded frame — this fetches it
// directly instead, on the same lock-gated interval + forced-reload pattern as My Savings'
// other background syncs (see my-planets-watch.js, which this mirrors exactly).

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseTradeInventoryPage } from '../scrapers/trade-inventory-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const TRADE_PATH = '/Game/Trade';
// Hoard value only moves when the member buys/sells artifacts or supply units — far
// slower than planet production — so this checks on the same cadence as My Planets rather
// than more often.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'awt.tradeInventoryWatch.lock.v1';
const LOCK_TTL_MS = 13 * 60 * 1000; // shorter than the interval

function claimLock() {
    try {
        const raw = localStorage.getItem(LOCK_KEY);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < LOCK_TTL_MS) return false;
        localStorage.setItem(LOCK_KEY, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same fallback as game-rate-limit.js
    }
}

async function syncTradeInventory() {
    const pageRes = await gameFetch(TRADE_PATH);
    if (!pageRes.ok) return;
    const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
    const result = parseTradeInventoryPage(doc);
    if (result == null) return; // page didn't parse the way we expect — leave the old values in place
    const { hoarded, astroDollars } = result;
    await fetch('/hub-api/sync/trade-inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hoarded_au: Math.round(hoarded), astro_dollars: astroDollars }),
    });
}

// Lock-gated: for the timer and for opening the tab, where hammering the game on every
// switch would be wasteful. Silently a no-op within the lock window — see
// forceTradeInventorySync for the explicit "Reload" button, which must not silently do nothing.
export async function runTradeInventoryCheck() {
    if (!claimLock()) return;
    try { await syncTradeInventory(); }
    catch (err) { console.warn('[TradeInventoryWatch] check failed:', err.message); }
}

// Bypasses the lock: a member who explicitly clicked "reload" and gets back the same
// stale hoard because a background check happened to run 2 minutes ago is a worse
// experience than one extra game request.
export async function forceTradeInventorySync() {
    try { await syncTradeInventory(); }
    catch (err) { console.warn('[TradeInventoryWatch] forced sync failed:', err.message); }
}

let started = false;
export function initTradeInventoryWatch() {
    if (started) return;
    started = true;
    runTradeInventoryCheck(); // don't wait a full interval on first load
    setInterval(runTradeInventoryCheck, CHECK_INTERVAL_MS);
}
