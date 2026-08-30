// Extracts what BattleReport/search's API response does NOT provide from a rendered
// /About/BattleReport/{id} page: per-ship-type counts/losses/survivors, the
// win-probability value, and the planet the battle happened at (the search API has no
// planet field of any kind). Everything else visible on that page (population change,
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
    // Assumes comma-thousands / plain-dot formatting, the only style observed on the one
    // sample page this parser was built from. A European-style (dot-thousands,
    // comma-decimal) variant would misparse here, but there is no evidence yet that this
    // game ever renders numbers that way — not fixed without a real example to test against.
    const n = parseInt(text.replace(/[,\s]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}

// The page header ("Battle Report [30,145]: [243] (23/-18) Dsiban #12") links to
// /Game/Map/SolarSystem/{system_id}/{planet_index} — that pair is the planets table's
// own primary key (system_id, planet_index), not a game_planet_id: there is no
// /Game/Planets/Planet/{id} link anywhere on this page. Confirmed against a real example
// (report 30145, https://astrowars.games/About/BattleReport/30145).
function parsePlanetLink(doc) {
    const link = doc.querySelector('h4 a[href*="/Game/Map/SolarSystem/"]');
    if (!link) return { system_id: null, planet_index: null };
    const m = link.getAttribute('href').match(/\/Game\/Map\/SolarSystem\/(\d+)\/(\d+)/);
    if (!m) return { system_id: null, planet_index: null };
    return { system_id: parseInt(m[1], 10), planet_index: parseInt(m[2], 10) };
}

function normalizeCellText(text) {
    return typeof text === 'string' ? text.replace(/ /g, ' ').trim() : '';
}

// The battle report table has one row per ship type: [name, def_count, def_lost,
// def_survived, spacer, att_count, att_lost, att_survived]. The Defender/Attacker column
// order is fixed by the page's own header row (Defender's stats always render on the
// left, Attacker's on the right) — confirmed against the one example page this was built
// from, not independently re-verified for every possible battle layout. That header row
// (`<tr><td>&nbsp;</td><td colspan="3">Defender</td>...<td colspan="3">Attacker</td></tr>`)
// is itself checked below (second <td>'s text) rather than trusted blindly, so a page laid
// out the other way around is caught instead of silently mis-mapped.
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
    Object.assign(result, parsePlanetLink(doc));

    let matchedAnyShipRow = false;
    let orientationMismatch = false;
    const matchedShipTypes = new Set();

    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;
        const label = cells[0].textContent.trim();

        // Defender/Attacker header row: confirm the page agrees with the hardcoded
        // left=defender/right=attacker assumption before trusting any ship-type row.
        if (cells.length >= 2) {
            const headerLabel = normalizeCellText(cells[1].textContent);
            if (headerLabel === 'Attacker') {
                // The position this parser assumes is Defender is actually labeled
                // Attacker on this page — the column order differs from what was built
                // against. Flag it rather than guess: a missing data point is far less
                // harmful than silently-swapped attacker/defender ship-loss data.
                orientationMismatch = true;
            }
            // headerLabel === 'Defender' confirms the assumption; no action needed.
        }

        const shipType = SHIP_TYPES.find(t => t.label === label);
        if (shipType && cells.length >= 8) {
            if (matchedShipTypes.has(shipType.col)) {
                // A second row matching this ship type's label — table.table tr is
                // unscoped, so a spurious second match (e.g. from another table.table
                // element elsewhere on the page) would otherwise silently overwrite the
                // real values (last-match-wins). Skip it and log instead.
                console.warn('[BattleReportParser] duplicate ship-type row for', shipType.label, '— ignoring');
                continue;
            }
            matchedShipTypes.add(shipType.col);
            matchedAnyShipRow = true;
            result[`def_${shipType.col}`] = parseCount(cells[1].textContent);
            result[`def_${shipType.col}_lost`] = parseCount(cells[2].textContent);
            result[`att_${shipType.col}`] = parseCount(cells[5].textContent);
            result[`att_${shipType.col}_lost`] = parseCount(cells[6].textContent);
            continue;
        }

        // 'Victory' is the only outcome label observed on the one example page this was
        // built from — there is no fallback for a differently-labeled outcome row (e.g. a
        // draw or a different victory-tier string); an unseen label variant just falls
        // through unmatched, same spirit as the other "unverified against a live page"
        // assumptions in this file.
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

    if (orientationMismatch) return null;
    if (!matchedAnyShipRow) return null;
    return result;
}

async function scrapeBattleReportShipDetail(id) {
    const gate = globalThis.AWGameRate;
    if (!gate || typeof gate.gameFetch !== 'function') {
        throw new Error('scrapeBattleReportShipDetail: AWGameRate gate is missing — import game-rate-limit.js first');
    }
    try {
        const res = await gate.gameFetch(`/About/BattleReport/${encodeURIComponent(id)}`);
        if (!res.ok) {
            console.warn('[BattleReportParser] non-2xx fetching report', id, ':', res.status);
            return null;
        }
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
