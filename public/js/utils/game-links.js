// public/js/utils/game-links.js
// One way for every sidebar tool to make a player, alliance, system or planet clickable.
//
// Each helper returns an <a> to the game's own page for that thing. A plain tap is caught by
// installGameLinkHandler() (dashboard.js wires it once, for the whole page): it loads the
// page in the game frame and closes the panel the link sat in, because every panel covers
// the frame — on a phone completely — so a link that left the panel open would look dead.
// A ctrl/cmd/middle click is left to the browser, which opens the same page in a new tab.
//
// A row that carries no id is looked up by name/tag in the link index (loadLinkIndex,
// once per page). Anything still unresolved renders as the same text, unlinked — and so
// does a name two players share: a guessed link is worse than none.
import { esc } from './escape.js';

const ATTR = 'data-game-link';

const validId = (id) => {
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// lower-case name -> player id, upper-case tag -> alliance id; null marks a shared key.
const index = { players: new Map(), alliances: new Map() };

function fill(map, rows, norm) {
    map.clear();
    for (const [id, key] of rows || []) {
        if (validId(id) == null || key == null || key === '') continue;
        const k = norm(key);
        map.set(k, map.has(k) && map.get(k) !== Number(id) ? null : Number(id));
    }
}
const normName = (n) => String(n).trim().toLowerCase();
const normTag = (t) => String(t).trim().replace(/^\[|\]$/g, '').toUpperCase();

export function setLinkIndex({ players, alliances } = {}) {
    fill(index.players, players, normName);
    fill(index.alliances, alliances, normTag);
}

// Fire-and-forget at startup. A failure only means name-only rows stay unlinked.
export function loadLinkIndex() {
    return fetch('/hub-api/intel/link-index')
        .then(r => r.json())
        .then(body => { if (body && body.success) setLinkIndex(body); })
        .catch(() => {});
}

const resolvePlayer = (id, name) => validId(id) ?? (name == null ? null : index.players.get(normName(name)) ?? null);
const resolveAlliance = (id, tag) => validId(id) ?? (tag == null ? null : index.alliances.get(normTag(tag)) ?? null);

export const gamePath = {
    player: (id) => `/Game/Players/Profile/${id}`,
    alliance: (id) => `/Game/Alliance/Profile/${id}`,
    system: (id) => `/Game/Map/SolarSystem/${id}`,
    planet: (id) => `/Game/Map/Planet/${id}`,
};

// `html` is already-escaped markup (the helpers below escape their own text first).
function anchor(path, html, cls) {
    return `<a href="${path}" ${ATTR} class="hover:underline cursor-pointer${cls ? ` ${cls}` : ''}">${html}</a>`;
}

function link(kind, id, text, cls) {
    const html = esc(text);
    const n = validId(id);
    return n == null ? html : anchor(gamePath[kind](n), html, cls);
}

// id may be null: the name is then looked up in the link index.
export const playerLink = (id, name, cls = '') => link('player', resolvePlayer(id, name), name, cls);
export const systemLink = (id, label, cls = '') => link('system', id, label, cls);

// "[TAG]" by default — the way every table already prints a tag. bare=true drops the brackets.
export function allianceLink(id, tag, cls = '', { bare = false } = {}) {
    if (tag == null || tag === '') return '';
    return link('alliance', resolveAlliance(id, tag), bare ? tag : `[${tag}]`, cls);
}

// The planet's own game page when its game id is known, else its system's page — the
// planet is one row of that page, so the member still lands on it.
export function planetLink({ planetId, systemId } = {}, label, cls = '') {
    if (validId(planetId) != null) return link('planet', planetId, label, cls);
    return link('system', systemId, label, cls);
}

// Delegated, so it covers rows painted long after page load and panels injected later.
// navigate(path) loads the game frame (search.js's navToIframe).
export function installGameLinkHandler(root, navigate) {
    root.addEventListener('click', (e) => {
        const a = e.target.closest?.(`a[${ATTR}]`);
        if (!a) return;
        if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        // The link is often inside a <summary> or a clickable row — don't also toggle that.
        e.stopPropagation();
        navigate(a.getAttribute('href'));
        closePanelAround(a);
    }, true);
}

// Panels close through their own header close button (each has exactly one ✕), so a
// panel's close-time cleanup still runs — Defence drops its live stream, the Galaxy
// Archive stops animating. Falls back to sliding the panel out directly.
function closePanelAround(el) {
    const panel = el.closest('#dynamic-panels-container > div');
    if (!panel || !panel.classList.contains('translate-x-0')) return;
    const close = panel.querySelector('.fa-xmark')?.closest('button');
    if (close) close.click();
    else panel.classList.replace('translate-x-0', 'translate-x-full');
}
