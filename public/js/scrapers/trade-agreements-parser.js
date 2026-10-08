// public/js/scrapers/trade-agreements-parser.js
// Reads the logged-in member's /Game/Trade/Agreements page and reports which
// partners they already have a trade agreement with, so the hub can mark those
// collaborative agreements as "done", and each row's Status, so the Schedule knows an
// offer is still waiting to be accepted.

// The Status column's wording (seen 2026-10-08): "Request is Pending" once the offer is sent
// (only the sender has paid), "Establishing trade infrastructure" once accepted (until the
// next trade cycle), then "Active Trading".
export function offerState(text) {
    if (/pending/i.test(text)) return 'pending';
    if (/establishing/i.test(text)) return 'establishing';
    if (/active/i.test(text)) return 'active';
    return null;
}

export async function scrapeTradeAgreements() {
    try {
        // Find the "Existing Agreements" table by its header text.
        let table = null;
        document.querySelectorAll('table').forEach(t => {
            const head = t.querySelector('thead th, thead td');
            if (head && /existing agreements/i.test(head.innerText)) table = t;
        });
        if (!table) return;

        const partners = [], rows = [];
        let statusCol = 2;                                       // Name | Planets (Pop >= 10) | Status
        // All rows, not just tbody: the column-label row may sit in either.
        table.querySelectorAll('tr').forEach(row => {
            const cells = [...row.querySelectorAll('td, th')];
            const labels = cells.map(c => c.innerText.trim().toLowerCase());
            if (labels[0] === 'name') {                          // column-label row
                const i = labels.findIndex(l => l === 'status');
                if (i >= 0) statusCol = i;
                return;
            }
            if (row.querySelector('th')) return;                 // header rows
            if (cells.length < 2 || labels[0] === '') return;    // "No Agreements!" colspan row

            // Prefer a profile link's text; fall back to the cell text.
            const link = cells[0].querySelector('a[href*="/Game/Players/Profile/"]');
            const name = (link ? link.innerText : cells[0].innerText).trim();
            if (!name) return;
            partners.push(name);
            rows.push({ name, state: offerState(labels[statusCol] || '') });
        });

        // Always POST (even empty) so removed agreements could be reconciled later if needed.
        await fetch('/hub-api/sync/trade-agreements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partners, rows })
        });
        console.log(`[Spy] Trade agreements synced (${partners.length} partner(s))`);
    } catch (err) {
        console.error('[Spy] Failed to scrape trade agreements', err);
    }
}
