// Hoard A$ (2026-09-19): reads the viewer's own /Game/Trade inventory value. Wrapper realm only.
//
// Member taps only (2026-10-17): this used to run every 15 minutes and whenever the My Savings
// tab opened. Now it runs from the "Update my data" button, My Savings' Reload button and the
// SU spend buttons — and spy.js reads the page for free when the member opens Trade.

import '../utils/game-rate-limit.js'; // must load before gameFetch resolves the gate
import { parseTradeInventoryPage, tradeInventorySyncBody } from '../scrapers/trade-inventory-parser.js';
const { gameFetch } = globalThis.AWGameRate;

const TRADE_PATH = '/Game/Trade';

// true when a fresh read reached the hub.
export async function forceTradeInventorySync() {
    try {
        const pageRes = await gameFetch(TRADE_PATH);
        if (!pageRes.ok) return false;
        const doc = new DOMParser().parseFromString(await pageRes.text(), 'text/html');
        const result = parseTradeInventoryPage(doc);
        if (result == null) return false; // page didn't parse the way we expect — leave the old values in place
        const res = await fetch('/hub-api/sync/trade-inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: tradeInventorySyncBody(result),
        });
        return res.ok;
    } catch (err) {
        console.warn('[TradeInventoryWatch] sync failed:', err.message);
        return false;
    }
}
