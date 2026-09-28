// Only annotates locations already present in the page. All ranking data comes from the
// wrapper's hub snapshot; this module has no request path and never visits game pages.
import '../utils/sqlite-time.js';
const { formatLocalDateTime } = globalThis.AWSqliteTime;
const OWNED = 'awt-unicorn-owned';
const KINDS = { HF: 'Hydroponic Farm', RF: 'Robotic Factory', GC: 'Galactic Cybernet', RL: 'Research Lab' };

function positiveInt(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

export function systemIdForDocument(doc) {
    const location = doc.defaultView?.location || doc.location;
    const path = location?.pathname || '';
    const match = path.match(/\/(?:Game\/Map\/SolarSystem|Game\/System)\/(\d+)(?:\/|$)/i);
    if (match) return positiveInt(match[1]);
    if (!/^\/Game\/(?:Map\/SolarSystem|System)\/?$/i.test(path)) return null;
    const params = new URLSearchParams(location.search || '');
    return positiveInt(params.get('id') || params.get('system'));
}

export function clearUnicornMarkers(doc) {
    doc.querySelectorAll(`.${OWNED}`).forEach(node => node.remove());
}

export function isUnicornMutation(record) {
    if (record.target?.closest?.(`.${OWNED}`)) return true;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every(node => node.classList?.contains(OWNED));
}

export function renderUnicornMarkers(doc, payload) {
    const rows = (Array.isArray(payload?.rows) ? payload.rows : [])
        .filter(row => positiveInt(row.game_planet_id) && positiveInt(row.rank) && row.rank <= 50);
    const leaders = (Array.isArray(payload?.leaders) ? payload.leaders : [])
        .filter(row => KINDS[row.kind] && positiveInt(row.game_planet_id));
    const ranksById = new Map(rows.map(row => [Number(row.game_planet_id), row]));
    const ranksByLocation = new Map(rows.filter(row => positiveInt(row.system_id) && positiveInt(row.planet_index))
        .map(row => [`${row.system_id}:${row.planet_index}`, row]));
    const systems = new Map();
    for (const row of [...rows, ...leaders]) {
        const id = positiveInt(row.system_id);
        if (!id) continue;
        if (!systems.has(id)) systems.set(id, []);
        systems.get(id).push(row.kind ? `Top 50 ${KINDS[row.kind]} leader` : `Best Planets #${row.rank}`);
    }

    const wanted = new Set();
    const formatted = formatLocalDateTime(payload?.synced_at, undefined, '');
    const stamp = formatted ? ` · ranking synced ${formatted} (your local time)` : ' · snapshot time unknown';
    const badge = (owner, key, text, title, extraClass = '') => {
        let node = owner.querySelector(`[data-aw-unicorn-key="${key}"]`);
        if (!node) {
            node = doc.createElement('span');
            node.className = `${OWNED} awt-unicorn-marker ${extraClass}`.trim();
            node.setAttribute('data-aw-unicorn-key', key);
            node.setAttribute('role', 'img');
            node.setAttribute('tabindex', '0');
            owner.appendChild(node);
        }
        if (node.textContent !== text) node.textContent = text;
        node.title = title;
        node.setAttribute('aria-label', title);
        wanted.add(node);
    };

    doc.querySelectorAll('.map-planet').forEach(node => {
        const label = node.querySelector('span');
        const match = label?.textContent.match(/\[(\d+)\]/);
        const entries = match ? systems.get(Number(match[1])) : null;
        if (entries) badge(node, 'map', '🦄', `${entries.join(' · ')}${stamp}`, 'awt-unicorn-map-marker');
    });

    const systemId = systemIdForDocument(doc);
    doc.querySelectorAll('#solarSystem > tbody > tr').forEach(row => {
        const cell = row.querySelector('td');
        if (!cell || Number(cell.getAttribute('colspan') || 1) > 1 || cell.querySelector('table')) return;
        const index = positiveInt((cell.textContent || '').trim().match(/^\d+/)?.[0]);
        if (!index) return;
        const id = positiveInt(row.getAttribute('data-planet-id'));
        // The out-of-vision fallback has location/index even when no game id is on its
        // row. A real game id is authoritative: never overwrite it with a guessed match.
        const rank = id ? ranksById.get(id) : ranksByLocation.get(`${systemId}:${index}`);
        if (rank) badge(cell, 'rank', `[${String(rank.rank).padStart(2, '0')}]`, `Best Planets rank ${rank.rank}${stamp}`, 'awt-unicorn-rank');
        const matches = leaders.filter(leader => id
            ? Number(leader.game_planet_id) === id
            : systemId && Number(leader.system_id) === systemId && Number(leader.planet_index) === index);
        for (const leader of matches) {
            const level = Number.isFinite(leader.level) ? ` · level ${leader.level}` : '';
            badge(cell, leader.kind, `🦄 ${leader.kind}`, `Top 50 ${KINDS[leader.kind]} leader${level}${stamp}`, `awt-unicorn-${leader.kind.toLowerCase()}`);
        }
    });

    doc.querySelectorAll('.awt-unicorn-marker').forEach(node => { if (!wanted.has(node)) node.remove(); });
    if (wanted.size && !doc.getElementById('awt-unicorn-marker-styles')) {
        const style = doc.createElement('link');
        style.id = 'awt-unicorn-marker-styles';
        style.className = OWNED;
        style.rel = 'stylesheet';
        style.href = '/hub-assets/css/unicorn-mode.css';
        doc.head.appendChild(style);
    }
    return wanted.size;
}
