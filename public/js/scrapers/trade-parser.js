// public/js/scrapers/trade-parser.js
// Scrapes /Game/Trade market prices (Production Point, Supply Unit) so the
// home-launch buildable-CV estimate can convert A$ into PP at the live rate.

// Parse "$0,91" / "$761,66" / "$2 865,73" → 0.91 / 761.66 / 2865.73
// Locale-agnostic: handles both "8 122,72" (comma decimal) and "8,122.72" (dot
// decimal), plus space/NBSP thousands. Both separators present -> later one is the
// decimal; a single separator with exactly 3 trailing digits is thousands.
function parsePrice(text) {
    if (text == null) return null;
    let s = String(text).replace(/[^\d.,\-]/g, '');   // strip $, spaces, NBSP, letters
    if (!s) return null;
    const nComma = (s.match(/,/g) || []).length;
    const nDot = (s.match(/\./g) || []).length;
    let dec = null;
    if (nComma && nDot) {
        dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    } else if (nComma === 1 || nDot === 1) {
        const sep = nComma ? ',' : '.';
        if (s.length - s.lastIndexOf(sep) - 1 !== 3) dec = sep;
    }
    if (dec) s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
    else s = s.replace(/[.,]/g, '');
    const val = parseFloat(s);
    return isNaN(val) ? null : val;
}

export async function scrapeTradePrices() {
    try {
        const rows = document.querySelectorAll('table tbody tr');
        let ppPrice = null, suPrice = null;

        rows.forEach(row => {
            const link = row.querySelector('a[href*="/Game/Trade/PriceHistory/"]');
            if (!link) return;
            const label = link.innerText.trim().toLowerCase();
            const priceCell = row.querySelector('td.text-end');
            if (!priceCell) return;
            const price = parsePrice(priceCell.innerText);
            if (price == null) return;

            if (label === 'production point') ppPrice = price;
            else if (label === 'supply unit') suPrice = price;
        });

        if (ppPrice == null && suPrice == null) return;

        await fetch('/hub-api/sync/trade-prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pp_price: ppPrice, su_price: suPrice })
        });
        console.log(`[Spy] Trade prices synced (PP: ${ppPrice}, SU: ${suPrice})`);
    } catch (err) {
        console.error('[Spy] Failed to scrape trade prices', err);
    }
}
