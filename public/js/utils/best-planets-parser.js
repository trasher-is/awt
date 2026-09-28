// Best Planets alone enriches the shared rank/planet parser with building columns.
// Secret ranking goals keep using ranking-page-parser.js unchanged. No game requests.
import { parseRankingPage } from './ranking-page-parser.js';

const BUILDING_HEADERS = Object.freeze({
    hf: 'HF', 'hydroponic farm': 'HF', farm: 'HF',
    rf: 'RF', 'robotic factory': 'RF', 'fac.': 'RF',
    gc: 'GC', 'galactic cybernet': 'GC', 'cyb.': 'GC',
    rl: 'RL', 'research lab': 'RL', lab: 'RL',
});
const PLANET_SELECTOR = 'a[href^="/Game/Map/Planet/"]';
const PROGRESS_SELECTOR = '.progress, .progress-bar, .progress-text, [role="progressbar"]';
const emptyBuildings = () => ({ HF: null, RF: null, GC: null, RL: null });
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const headerBuilding = cell => {
    const label = normalize(cell.textContent);
    return Object.prototype.hasOwnProperty.call(BUILDING_HEADERS, label) ? BUILDING_HEADERS[label] : null;
};
const cellsOf = row => Array.from(row.cells || row.querySelectorAll('td'));
const unspanned = cells => cells.every(cell => Number(cell.colSpan || 1) === 1 && Number(cell.rowSpan || 1) === 1);

function headerColumns(table) {
    if (!table) return null;
    const candidates = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table
        && !row.querySelector(PLANET_SELECTOR) && cellsOf(row).some(headerBuilding));
    if (candidates.length !== 1) return null;
    const cells = cellsOf(candidates[0]);
    if (!unspanned(cells)) return null;
    const columns = {};
    for (let index = 0; index < cells.length; index++) {
        const key = headerBuilding(cells[index]);
        if (!key) continue;
        if (Object.prototype.hasOwnProperty.call(columns, key)) return null;
        columns[key] = index;
    }
    return { columns, count: cells.length };
}

function buildingLevel(cell) {
    if (!cell) return null;
    // Progress markup is a different quantity. Only explicitly marked progress is
    // excluded; "12.75", "12 (75%)" and other combined text stay unknown. Joining text
    // nodes with spaces also prevents adjacent numbers from accidentally becoming 1275.
    const texts = [];
    function collect(node) {
        if (node.nodeType === 3) { if (node.textContent.trim()) texts.push(node.textContent.trim()); return; }
        if (node.nodeType === 1 && node.matches(PROGRESS_SELECTOR)) return;
        for (const child of node.childNodes || []) collect(child);
    }
    collect(cell);
    const text = texts.join(' ').trim();
    if (!/^\d+$/.test(text)) return null;
    const level = Number(text);
    return Number.isSafeInteger(level) && level >= 0 ? level : null;
}

export function parseBestPlanetsPage(doc) {
    const ranked = parseRankingPage(doc);
    const rankCounts = new Map(), idCounts = new Map();
    for (const row of ranked) {
        rankCounts.set(row.rank, (rankCounts.get(row.rank) || 0) + 1);
        idCounts.set(row.game_planet_id, (idCounts.get(row.game_planet_id) || 0) + 1);
    }
    const sourceById = new Map();
    for (const row of doc.querySelectorAll('table tr')) {
        const cells = cellsOf(row);
        const rankText = String(cells[0]?.textContent || '').trim();
        const links = Array.from(row.querySelectorAll(PLANET_SELECTOR));
        if (!/^[1-9]\d*$/.test(rankText) || links.length !== 1) continue;
        const match = /^\/Game\/Map\/Planet\/([1-9]\d*)$/.exec(links[0].getAttribute('href') || '');
        if (!match) continue;
        const rank = Number(rankText), id = Number(match[1]);
        if (!Number.isSafeInteger(rank) || rank > 50 || !Number.isSafeInteger(id) || rankCounts.get(rank) !== 1 || idCounts.get(id) !== 1) continue;
        sourceById.set(id, { row, cells, rank });
    }
    const tableHeaders = new Map();
    return ranked.flatMap(entry => {
        const source = sourceById.get(entry.game_planet_id);
        if (!source || source.rank !== entry.rank) return [];
        const table = source.row.closest('table');
        if (!tableHeaders.has(table)) tableHeaders.set(table, headerColumns(table));
        const header = tableHeaders.get(table);
        const buildings = emptyBuildings();
        if (header && source.cells.length === header.count && unspanned(source.cells)) {
            for (const [key, index] of Object.entries(header.columns)) buildings[key] = buildingLevel(source.cells[index]);
        }
        return [{ ...entry, buildings }];
    });
}
