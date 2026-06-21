// public/js/scrapers/trade-agreements-parser.js
// Reads the logged-in member's /Game/Trade/Agreements page and reports which
// partners they already have a trade agreement with, so the hub can mark those
// collaborative agreements as "done".

export async function scrapeTradeAgreements() {
    try {
        // Find the "Existing Agreements" table by its header text.
        let table = null;
        document.querySelectorAll('table').forEach(t => {
            const head = t.querySelector('thead th, thead td');
            if (head && /existing agreements/i.test(head.innerText)) table = t;
        });
        if (!table) return;

        const partners = [];
        table.querySelectorAll('tbody tr').forEach(row => {
            if (row.querySelector('th')) return;                 // header rows
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;                        // "No Agreements!" colspan row
            const label = cells[0].innerText.trim().toLowerCase();
            if (label === 'name' || label === '') return;        // column-label row

            // Prefer a profile link's text; fall back to the cell text.
            const link = cells[0].querySelector('a[href*="/Game/Players/Profile/"]');
            const name = (link ? link.innerText : cells[0].innerText).trim();
            if (name) partners.push(name);
        });

        // Always POST (even empty) so removed agreements could be reconciled later if needed.
        await fetch('/hub-api/sync/trade-agreements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partners })
        });
        console.log(`[Spy] Trade agreements synced (${partners.length} partner(s))`);
    } catch (err) {
        console.error('[Spy] Failed to scrape trade agreements', err);
    }
}
