// Read-only hints beside the game's building rows. Prices come from an existing Trade
// inventory read; this module never fetches or submits anything to the game or hub.
import '../utils/game-tables.js';
import '../utils/building-economics.js';

const E = globalThis.AWBuildingEconomics;
const OWN = 'data-aw-building-value';
const STYLE_ID = 'aw-building-value-style';
let active = null;
let nextId = 0;

const normalized = text => String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
const directCells = row => Array.from(row.cells || []);
const unspanned = cells => cells.every(cell => Number(cell.colSpan || 1) === 1 && Number(cell.rowSpan || 1) === 1);

// "PP to next level" is the game-confirmed header in the repository's glossary.
// Read by meaning, never by column position. Keep unknown observations as null;
// the separately labelled estimate below must not masquerade as a measured cost.
function readColumn(row, label) {
    const table = row.closest('table');
    if (!table) return null;
    const headers = Array.from(table.querySelectorAll('th, td')).filter(cell =>
        cell.closest('table') === table && !cell.closest(`[${OWN}]`) && normalized(cell.textContent) === label);
    if (headers.length !== 1) return null;
    const headerRow = headers[0].closest('tr');
    const headerCells = directCells(headerRow);
    const cells = directCells(row);
    if (headerRow === row || headerCells.length !== cells.length || !unspanned(headerCells) || !unspanned(cells)) return null;
    const index = headerCells.indexOf(headers[0]);
    return index < 0 ? null : E.parseRemainingPP(cells[index].textContent);
}

export function readRemainingPP(row) { return readColumn(row, 'pp to next level'); }

export function readUpgradeCost(row) {
    const remainingPP = readRemainingPP(row);
    if (remainingPP !== null) return { remainingPP, estimated: false };
    // The game uses this level marker on building rows (also used by the SB timer).
    const markers = Array.from(row.querySelectorAll('.building-lvl-up'));
    const level = markers.length === 1 ? E.parseRemainingPP(markers[0].textContent)
        : markers.length ? null : readColumn(row, 'level');
    const cost = E.fullUpgradeCost(level);
    return cost === null ? null : { remainingPP: cost, estimated: true, level };
}

function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        [${OWN}] { font-family: inherit; }
        .aw-building-value { margin-left: .45rem; white-space: normal; }
        .aw-building-value-badge { display: inline-flex; align-items: center; min-height: 25px; padding: 1px 6px; border: 1px solid #5ac8a6; border-radius: 5px; background: #13392f; color: #c6ffe9; font-family: inherit; font-weight: 600; font-size: 11px; line-height: 1.4; white-space: nowrap; cursor: pointer; vertical-align: middle; }
        .aw-building-value-badge:hover { background: #205344; }
        .aw-building-value-badge[data-outcome="pp"], .aw-building-value-badge[data-outcome="equal"] { border-color: #8d9ba7; background: #26323c; color: #e4edf3; }
        .aw-building-value-badge:focus-visible, .aw-building-value-details a:focus-visible, .aw-building-value-neutral a:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
        .aw-building-value-details { display: block; box-sizing: border-box; width: max-content; max-width: min(360px, calc(100vw - 180px)); margin: 7px 0; padding: 10px 12px; border: 1px solid #426258; border-radius: 6px; color: #e3eee9; background: #182521; font-size: 12px; line-height: 1.55; text-align: left; white-space: normal; overflow-wrap: anywhere; }
        .aw-building-value-details[hidden] { display: none; }
        .aw-building-value-line { display: block; }
        .aw-building-value-note { display: block; margin-top: 7px; color: #bbc9c3; font-size: 11px; }
        .aw-building-value-details a, .aw-building-value-neutral a { color: #a5e6db; text-decoration: underline; text-underline-offset: 2px; }
        .aw-building-value-neutral { margin: 6px 0; color: #aab9b6; font-size: 11px; line-height: 1.5; }
    `;
    document.head.appendChild(style);
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

const dollars = amount => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} A$`;
const price = amount => `${amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} A$/PP`;
const ageText = capturedAt => {
    const minutes = Math.floor((Date.now() - capturedAt) / 60000);
    return `Trade quote: ${minutes < 1 ? 'less than 1 min' : `${minutes} min`} ago · expires after 15 min.`;
};

function makeHint(building, comparison) {
    const host = element('span', undefined, 'aw-building-value');
    host.setAttribute(OWN, 'hint');
    const percent = comparison.savingPercent < 1 ? '<1' : String(Math.floor(comparison.savingPercent));
    const outcome = comparison.saving > 0 ? 'su' : comparison.saving < 0 ? 'pp' : 'equal';
    const label = outcome === 'su' ? `SU ↓${percent}%` : outcome === 'pp' ? 'PP cheaper' : 'Same cost';
    const button = element('button', `${comparison.estimated ? '~ ' : ''}${label}`, 'aw-building-value-badge');
    button.setAttribute('data-outcome', outcome);
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', `${building}: ${label}${comparison.estimated ? ', assuming 0 PP already invested' : ''}. Show market-value comparison.`);
    button.title = comparison.estimated ? 'Full next-level cost; assumes 0 PP already invested' : 'Compare remaining PP with one Supply Unit at the last recorded market prices';
    const details = element('span', undefined, 'aw-building-value-details');
    details.id = `aw-building-value-details-${++nextId}`;
    details.hidden = true;
    details.setAttribute('role', 'region');
    details.setAttribute('aria-label', `${building} market-value comparison`);
    button.setAttribute('aria-controls', details.id);
    const addLine = text => details.appendChild(element('span', text, 'aw-building-value-line'));
    if (comparison.estimated) addLine(`Remaining PP unavailable. Assuming 0 PP already invested for level ${comparison.level} → ${comparison.level + 1}. Actual progress may make PP cheaper.`);
    addLine(`${comparison.remainingPP.toLocaleString('en-US')} ${comparison.estimated ? 'full-level' : 'remaining'} PP × ${price(comparison.ppPrice)} = ${dollars(comparison.ppValue)}`);
    addLine(`Buy 1 SU: ${dollars(comparison.suPrice)}`);
    addLine(comparison.refund === null ? 'Building refund: unknown (estimate before refund)' : `Building refund: −${dollars(comparison.refund)}`);
    addLine(`SU estimate${comparison.refund === null ? ' before refund' : ' after refund'}: ${dollars(comparison.suValue)}`);
    addLine(comparison.saving === 0 ? 'Same estimated cost.' : `Estimated saving with ${comparison.saving > 0 ? 'SU' : 'PP'}: ${dollars(Math.abs(comparison.saving))}`);
    const age = element('span', ageText(comparison.capturedAt), 'aw-building-value-note');
    age.setAttribute('data-aw-quote-age', '');
    details.appendChild(age);
    details.appendChild(element('span', 'Market-value estimate, not a guaranteed transaction quote. Prices move. Selling PP from a sieged planet converts only 70%; trade eligibility also applies.', 'aw-building-value-note'));
    const trade = element('a', 'Check current prices in Trade');
    trade.href = '/Game/Trade';
    details.appendChild(trade);
    host.appendChild(button);
    host.appendChild(details);
    // Building rows navigate/select on a click; opening advice must not select a build.
    button.addEventListener('click', event => {
        event.stopPropagation();
        event.preventDefault();
        details.hidden = !details.hidden;
        button.setAttribute('aria-expanded', String(!details.hidden));
    });
    host.addEventListener('click', event => event.stopPropagation());
    host.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !details.hidden) {
            event.preventDefault();
            details.hidden = true;
            button.setAttribute('aria-expanded', 'false');
            button.focus();
        }
    });
    return host;
}

function makeNeutral(reason) {
    const box = element('div', undefined, 'aw-building-value-neutral');
    box.setAttribute(OWN, 'neutral');
    const link = element('a', 'Open Trade to compare SU prices');
    link.href = '/Game/Trade';
    box.appendChild(link);
    box.appendChild(element('span', ` · ${reason}`));
    return box;
}

function currentPlanetPath() {
    const path = window.location.pathname;
    return /^\/game\/planets\/planet\/\d+\/?$/i.test(path) ? path : null;
}

function stop() {
    if (!active) return;
    const state = active;
    active = null;
    state.observer.disconnect();
    clearTimeout(state.debounce);
    clearTimeout(state.expiry);
    window.removeEventListener('storage', state.onStorage);
    window.removeEventListener(E.QUOTE_EVENT, state.schedule);
    window.removeEventListener('popstate', initBuildingValueHints);
    window.removeEventListener('hashchange', initBuildingValueHints);
    window.removeEventListener('pagehide', stop);
    for (const entry of state.rows.values()) entry.host.remove();
    for (const entry of state.neutral.values()) entry.host.remove();
}

function render(state) {
    if (state !== active) return;
    if (currentPlanetPath() !== state.path) { initBuildingValueHints(); return; }
    // Disconnect while changing our own DOM. External changes are debounced below;
    // our badge/details updates cannot cause a MutationObserver feedback loop.
    state.observer.disconnect();
    clearTimeout(state.expiry);
    const quote = E.readQuote();
    const rows = Array.from(document.querySelectorAll('tr[data-spend-to]')).filter(row => E.BUILDINGS.includes(row.getAttribute('data-spend-to')));
    const present = new Set(rows);
    const reasons = new Map();
    state.tables = new Set(rows.map(row => row.closest('table')).filter(Boolean));
    for (const [row, entry] of state.rows) {
        if (!present.has(row)) { entry.host.remove(); state.rows.delete(row); }
    }
    for (const row of rows) {
        const cost = readUpgradeCost(row);
        const table = row.closest('table');
        if (table && (!cost || !quote)) reasons.set(table, !quote ? 'a market quote less than 15 min old is needed' : 'remaining PP and a supported building level could not be read');
        const building = row.getAttribute('data-spend-to');
        const values = cost && E.evaluateUpgrade(cost.remainingPP, building, quote);
        const comparison = values ? { ...values, ...cost } : null;
        const signature = comparison ? JSON.stringify(comparison) : null;
        const existing = state.rows.get(row);
        if (existing && existing.signature === signature && existing.host.isConnected) {
            const age = existing.host.querySelector('[data-aw-quote-age]');
            if (age && age.textContent !== ageText(comparison.capturedAt)) age.textContent = ageText(comparison.capturedAt);
            continue;
        }
        if (existing) { existing.host.remove(); state.rows.delete(row); }
        const cell = row.querySelector('td');
        if (comparison && cell) {
            const host = makeHint(building, comparison);
            cell.appendChild(host);
            state.rows.set(row, { host, signature });
        }
    }
    for (const [table, entry] of state.neutral) {
        if (reasons.get(table) !== entry.reason || !entry.host.isConnected) { entry.host.remove(); state.neutral.delete(table); }
    }
    for (const [table, reason] of reasons) {
        if (state.neutral.has(table)) continue;
        const host = makeNeutral(reason);
        table.insertAdjacentElement('afterend', host);
        state.neutral.set(table, { host, reason });
    }
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-spend-to', 'colspan', 'rowspan'] });
    if (quote) state.expiry = setTimeout(state.schedule, Math.max(1, Math.min(60000, quote.capturedAt + E.MAX_AGE_MS - Date.now())));
}

export function initBuildingValueHints() {
    const path = currentPlanetPath();
    if (!path) { stop(); return; }
    if (active && active.path !== path) stop();
    if (active) { render(active); return; }
    installStyle();
    const state = { path, rows: new Map(), neutral: new Map(), tables: new Set(), debounce: null, expiry: null };
    state.schedule = () => {
        clearTimeout(state.debounce);
        state.debounce = setTimeout(() => render(state), 60);
    };
    state.onStorage = event => { if (event.key === E.STORAGE_KEY || event.key === null) state.schedule(); };
    state.observer = new MutationObserver(changes => {
        const relevant = changes.some(change => {
            const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
            if (target?.closest(`[${OWN}]`)) return false;
            if (state.tables.has(target?.closest('table'))) return true;
            return [...(change.addedNodes || []), ...(change.removedNodes || [])].some(node =>
                node.nodeType === 1 && !node.hasAttribute(OWN) && (node.matches('tr[data-spend-to]') || node.querySelector('tr[data-spend-to]')));
        });
        if (relevant) state.schedule();
    });
    active = state;
    window.addEventListener('storage', state.onStorage);
    window.addEventListener(E.QUOTE_EVENT, state.schedule);
    window.addEventListener('popstate', initBuildingValueHints);
    window.addEventListener('hashchange', initBuildingValueHints);
    window.addEventListener('pagehide', stop);
    render(state);
}
