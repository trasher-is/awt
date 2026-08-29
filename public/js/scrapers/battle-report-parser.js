// Extracts what BattleReport/search's API response does NOT provide from a rendered
// /About/BattleReport/{id} page: per-ship-type counts/losses/survivors and the
// win-probability value. Everything else visible on that page (population change,
// conquered flag, luckiness, XP/level gained) is already covered by the existing API
// integration (src/utils/battle-reports.js) and is deliberately NOT re-extracted here.
//
// UNVERIFIED against a live game session — built from a single pasted example page. If
// the real page's markup differs, only this file needs correcting; nothing else in this
// plan depends on the exact selectors used here.

const SHIP_TYPES = [
    { label: 'Destroyer', col: 'destroyers' },
    { label: 'Cruiser', col: 'cruisers' },
    { label: 'Battleship', col: 'battleships' },
    { label: 'Transport', col: 'transports' },
    { label: 'Colony Ship', col: 'colony_ships' },
    { label: 'Starbase', col: 'starbases' },
];

function parseCount(text) {
    if (typeof text !== 'string') return null;
    const n = parseInt(text.replace(/[,\s]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}

// The battle report table has one row per ship type: [name, def_count, def_lost,
// def_survived, spacer, att_count, att_lost, att_survived]. The Defender/Attacker column
// order is fixed by the page's own header row (Defender's stats always render on the
// left, Attacker's on the right) — confirmed against the one example page this was built
// from, not independently re-verified for every possible battle layout.
function parseBattleReportHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('table.table tr'));
    const result = {};
    for (const t of SHIP_TYPES) {
        result[`att_${t.col}`] = null;
        result[`att_${t.col}_lost`] = null;
        result[`def_${t.col}`] = null;
        result[`def_${t.col}_lost`] = null;
    }
    result.win_chance = null;

    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;
        const label = cells[0].textContent.trim();

        const shipType = SHIP_TYPES.find(t => t.label === label);
        if (shipType && cells.length >= 8) {
            result[`def_${shipType.col}`] = parseCount(cells[1].textContent);
            result[`def_${shipType.col}_lost`] = parseCount(cells[2].textContent);
            result[`att_${shipType.col}`] = parseCount(cells[5].textContent);
            result[`att_${shipType.col}_lost`] = parseCount(cells[6].textContent);
            continue;
        }

        if (label === 'Victory' && cells.length >= 3) {
            // Row shape: [Victory, def-outcome(colspan=3), dice/win-chance, att-outcome(colspan=3)]
            // — a colspan attribute does not create extra <td> DOM nodes, so this row has
            // only 4 <td>s total (indices 0-3), and the win-chance value lives at index 2.
            const span = cells[2].querySelector('span');
            const text = span ? span.textContent.trim() : cells[2].textContent.trim();
            const n = parseFloat(text);
            if (Number.isFinite(n)) result.win_chance = n;
        }
    }
    return result;
}

async function scrapeBattleReportShipDetail(id) {
    const gate = globalThis.AWGameRate;
    if (!gate || typeof gate.gameFetch !== 'function') {
        throw new Error('scrapeBattleReportShipDetail: AWGameRate gate is missing — import game-rate-limit.js first');
    }
    try {
        const res = await gate.gameFetch(`/About/BattleReport/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const html = await res.text();
        return parseBattleReportHtml(html);
    } catch (err) {
        console.warn('[BattleReportParser] fetch/parse failed for report', id, err.message);
        return null;
    }
}

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.BattleReportParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    return { parseBattleReportHtml, scrapeBattleReportShipDetail };
});
