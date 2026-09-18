// Parses the viewer's own /Game/Planets overview into per-planet production figures for
// My Savings (2026-09-18). DOM-only, never used server-side — same reasoning as
// ranking-page-parser.js's own comment: a real ES module, no dual Node/browser wrapper.
import '../utils/parse-number.js'; // side-effect import: parseLocaleNumber on globalThis
const { parseLocaleNumber } = globalThis.AWNumber;

// Row shape (7 <td> per row, in order): SID, Name, Population, population-progress-bar,
// growth +/h, Production Points, production +/h. The SID cell carries the system id in a
// data-sort attribute; production carries its value there too when present, falling back
// to the cell's own text (both forms are seen in practice).
export function parseMyPlanetsPage(doc) {
    const rows = [];
    doc.querySelectorAll('tr[data-planet-id]').forEach(tr => {
        const gamePlanetId = parseInt(tr.getAttribute('data-planet-id'), 10);
        if (!Number.isInteger(gamePlanetId)) return;
        const cells = tr.querySelectorAll('td');
        if (cells.length < 7) return;
        const systemId = parseInt(cells[0].getAttribute('data-sort'), 10);
        const name = (cells[1].textContent || '').trim();
        const population = parseLocaleNumber((cells[2].textContent || '').trim());
        const productionPp = parseLocaleNumber(cells[5].getAttribute('data-sort') ?? cells[5].textContent);
        const productionRate = parseLocaleNumber(cells[6].textContent);
        rows.push({
            game_planet_id: gamePlanetId,
            system_id: Number.isInteger(systemId) ? systemId : null,
            name: name || null,
            population,
            production_pp: productionPp,
            production_rate: productionRate,
        });
    });
    return rows;
}
