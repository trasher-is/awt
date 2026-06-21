// public/js/scrapers/trade-parser.js
// Scrapes /Game/Trade market prices (Production Point, Supply Unit) so the
// home-launch buildable-CV estimate can convert A$ into PP at the live rate.

// Parse "$0,91" / "$761,66" / "$2 865,73" → 0.91 / 761.66 / 2865.73
function parsePrice(text) {
    if (!text) return null;
    let t = text.replace(/[^\d.,]/g, '').trim();      // strip $, spaces, NBSP
    if (!t) return null;
    if (t.includes(',')) {
        // Comma is the decimal separator in this locale; dots are thousands.
        t = t.replace(/\./g, '').replace(',', '.');
    }
    const val = parseFloat(t);
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
