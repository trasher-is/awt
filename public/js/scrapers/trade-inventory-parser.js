// public/js/scrapers/trade-inventory-parser.js
// Scrapes the logged-in member's /Game/Trade page and reports the A$ value of the
// artifacts + supply units they are HOARDING (their Inventory holdings), priced
// from the live Prices table on the same page, plus their exact Astro Dollar balance
// (also shown right there in the Inventory table). The hub stores both per member so
// the Trade Agreements board can show who's sitting on how much — deliberately never the
// Alliance member-sheet's astro_dollars, which is coarser and only updates when someone
// opens /Game/Alliance (2026-09-20: this alliance wants Planets + Trade only for this).

// Locale-agnostic number parse: handles both "8 122,72" (comma decimal) and
// "8,122.72" (dot decimal), plus space/NBSP thousands. When both separators are
// present the LATER one is the decimal; with a single separator, exactly 3 digits
// after it means thousands, otherwise it's the decimal (prices show 2 decimals).
function parseNumber(text) {
    if (text == null) return null;
    let s = String(text).replace(/[^\d.,\-]/g, '');        // strip $, NBSP, spaces, letters
    if (!s) return null;
    const nComma = (s.match(/,/g) || []).length;
    const nDot = (s.match(/\./g) || []).length;
    let dec = null;
    if (nComma && nDot) {
        dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    } else if (nComma === 1 || nDot === 1) {
        const sep = nComma ? ',' : '.';
        if (s.length - s.lastIndexOf(sep) - 1 !== 3) dec = sep;   // not a 3-digit group => decimal
    }
    if (dec) s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
    else s = s.replace(/[.,]/g, '');                       // all separators are thousands
    const v = parseFloat(s);
    return isNaN(v) ? null : v;
}

// Reads the A$ value of held artifacts + supply units, and the exact Astro Dollar balance,
// out of a /Game/Trade document. Takes a `doc` (the live `document` when running inside the
// page via spy.js, or a DOMParser result when fetched in the background — see
// trade-inventory-watch.js) so both callers share one parser instead of two copies
// drifting apart. Returns null when the page didn't parse the way we expect (e.g. Inventory
// table not found), so callers can leave the old values in place rather than overwriting
// them with a wrong zero.
//
// Uses textContent, not innerText, throughout: innerText depends on the element actually
// being rendered, which a DOMParser result never is (see escape.js's own note on this) —
// same reasoning as my-planets-parser.js and ranking-page-parser.js, the other two parsers
// shared between a live in-page scrape and a background gameFetch + DOMParser sync.
export function parseTradeInventoryPage(doc) {
    // 1) Price map from the "Prices" table: each row has a PriceHistory link + a .text-end price.
    const priceMap = {};
    doc.querySelectorAll('tr').forEach(row => {
        const link = row.querySelector('a[href*="/Game/Trade/PriceHistory/"]');
        const priceCell = row.querySelector('td.text-end');
        if (!link || !priceCell) return;
        const name = (link.textContent || '').trim();
        const price = parseNumber(priceCell.textContent);
        if (name && price != null) priceMap[name] = price;
    });
    const suPrice = priceMap['Supply Unit'] || 0;

    // 2) Locate the Inventory table by its header cell.
    let invTable = null;
    doc.querySelectorAll('td, th').forEach(c => {
        if (!invTable && (c.textContent || '').trim() === 'Inventory') invTable = c.closest('table');
    });
    if (!invTable) return null;

    // 3) Walk rows; value artifacts + supply units until the Orders/Trade Revenue sections,
    // and read the exact Astro Dollar balance off its own row along the way.
    let hoarded = 0, astroDollars = 0, section = 'inventory';
    invTable.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;                       // e.g. "No Orders!" colspan row

        const nameSpan = cells[0].querySelector('span');
        const name = ((nameSpan ? nameSpan.textContent : cells[0].textContent) || '').trim();

        if (/^Orders$/i.test(name)) { section = 'orders'; return; }
        if (/^Trade Revenue$/i.test(name)) { section = 'done'; return; }
        if (section !== 'inventory') return;
        if (name === 'Inventory' || name === 'qty') return;

        const qtyText = (cells[1].textContent || '').trim();
        if (name === 'Astro Dollar') {
            astroDollars = parseNumber(qtyText) || 0;
        } else if (name === 'Supply Unit') {
            const held = parseInt(qtyText.split('/')[0].replace(/[^\d-]/g, ''), 10) || 0;   // "0/6" -> 0
            hoarded += held * suPrice;
        } else {
            const qty = parseInt(qtyText.replace(/[^\d-]/g, ''), 10) || 0;
            hoarded += qty * (priceMap[name] || 0);
        }
    });
    return { hoarded, astroDollars };
}

export async function scrapeTradeInventory() {
    try {
        const result = parseTradeInventoryPage(document);
        if (result == null) return;
        const { hoarded, astroDollars } = result;

        await fetch('/hub-api/sync/trade-inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hoarded_au: Math.round(hoarded), astro_dollars: astroDollars })
        });
        console.log(`[Spy] Trade inventory synced (hoarded A$ ${Math.round(hoarded)}, astro dollars ${astroDollars})`);
    } catch (err) {
        console.error('[Spy] Failed to scrape trade inventory', err);
    }
}
