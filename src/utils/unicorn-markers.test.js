const fs = require('fs');
const path = require('path');
const SqliteTime = require('../../public/js/utils/sqlite-time.js');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
}
console.log('unicorn-markers.test.js');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/core/unicorn-markers.js'), 'utf8');
const api = new Function('globalThis', `${source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')}; return { renderUnicornMarkers, clearUnicornMarkers, systemIdForDocument, isUnicornMutation };`)(
    { AWSqliteTime: SqliteTime }
);

// Minimal synthetic DOM with real parent/child ownership and text aggregation: this
// catches marker duplication and index corruption without needing captured game HTML.
class Node {
    constructor(tag, text = '') {
        this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this._text = text;
        this.className = ''; this.title = ''; this.id = ''; this.parentNode = null;
        this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
    }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    matches(selector) {
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        const attr = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
        if (attr) return this.getAttribute(attr[1]) === attr[2];
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
        return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
}
function makeDoc() {
    const html = new Node('html'), head = html.appendChild(new Node('head')), body = html.appendChild(new Node('body'));
    const table = body.appendChild(new Node('table')); table.id = 'solarSystem';
    const tbody = table.appendChild(new Node('tbody'));
    const doc = {
        head, body, tbody,
        defaultView: { location: { pathname: '/Game/Map/SolarSystem/710', search: '' } },
        createElement: tag => new Node(tag),
        querySelectorAll: selector => selector === '#solarSystem > tbody > tr' ? tbody.children : html.querySelectorAll(selector),
        getElementById: id => [html, ...allNodes(html)].find(node => node.id === id) || null
    };
    return doc;
}
function allNodes(node) { return node.children.flatMap(child => [child, ...allNodes(child)]); }
function mapNode(doc, id) {
    const node = doc.body.appendChild(new Node('div')); node.className = 'map-planet';
    node.appendChild(new Node('span', `Synthetic [${id}]`));
    return node;
}
function planet(doc, index, gameId, options = {}) {
    const row = doc.tbody.appendChild(new Node('tr'));
    if (gameId != null) row.setAttribute('data-planet-id', gameId);
    const cell = row.appendChild(new Node('td', String(index)));
    if (options.colspan) cell.setAttribute('colspan', options.colspan);
    row.appendChild(new Node('td', '17'));
    return { row, cell };
}
const payload = {
    synced_at: '2026-09-28T10:00:00Z',
    rows: [
        { game_planet_id: 71001, system_id: 710, planet_index: 1, rank: 1 },
        { game_planet_id: 71002, system_id: 710, planet_index: 2, rank: 50 },
        { game_planet_id: 71101, system_id: 711, planet_index: 1, rank: 23 },
        { game_planet_id: 71201, system_id: 712, planet_index: 1, rank: 51 }
    ],
    leaders: [
        { kind: 'HF', game_planet_id: 71001, system_id: 710, planet_index: 1, level: 45 },
        { kind: 'RF', game_planet_id: 71001, system_id: 710, planet_index: 1, level: 42 },
        { kind: 'GC', game_planet_id: 71002, system_id: 710, planet_index: 2, level: 37 },
        { kind: 'RL', game_planet_id: 71301, system_id: 713, planet_index: 1, level: 48 }
    ]
};
const doc = makeDoc();
const map710 = mapNode(doc, 710), map711 = mapNode(doc, 711), map712 = mapNode(doc, 712), map713 = mapNode(doc, 713);
const p1 = planet(doc, 1, 71001), p2 = planet(doc, 2, 71002), wrongId = planet(doc, 1, 99999);
const fleetSubrow = planet(doc, 2, null, { colspan: 8 });
const cellsBefore = p1.row.children.length;
api.renderUnicornMarkers(doc, payload);
ok('systems with a ranked planet receive one unicorn', map710.querySelectorAll('.awt-unicorn-marker').length === 1 && map711.querySelectorAll('.awt-unicorn-marker').length === 1);
ok('rank 51 is excluded from Top 50', !map712.querySelector('.awt-unicorn-marker'));
ok('a mapped leader can mark its system independently', !!map713.querySelector('.awt-unicorn-marker'));
ok('rank labels show exact two-digit brackets', p1.cell.querySelector('.awt-unicorn-rank').textContent === '[01]' && p2.cell.querySelector('.awt-unicorn-rank').textContent === '[50]');
ok('one planet can win multiple building categories', !!p1.cell.querySelector('.awt-unicorn-hf') && !!p1.cell.querySelector('.awt-unicorn-rf'));
ok('a known different id never falls back to location', !wrongId.cell.querySelector('.awt-unicorn-marker'));
ok('fleet subrows are not treated as planets', !fleetSubrow.cell.querySelector('.awt-unicorn-marker'));
ok('native first-cell number remains intact for scrapers', p1.cell._text === '1' && /^1\D/.test(p1.cell.textContent) && p1.row.children.length === cellsBefore);
ok('leader labels state the Top 50 scope and actual building level', /Top 50 Hydroponic Farm leader.*45/.test(p1.cell.querySelector('.awt-unicorn-hf').title));
ok('snapshot labels say which clock they use', /your local time/.test(p1.cell.querySelector('.awt-unicorn-rank').title));
ok('markers have accessible descriptions and a keyboard target', p1.cell.querySelector('.awt-unicorn-hf').getAttribute('aria-label').includes('Hydroponic Farm') && p1.cell.querySelector('.awt-unicorn-hf').getAttribute('tabindex') === '0');

const before = doc.querySelectorAll('.awt-unicorn-marker');
api.renderUnicornMarkers(doc, payload);
const after = doc.querySelectorAll('.awt-unicorn-marker');
ok('rerender keeps exactly the same marker nodes', before.length === after.length && before.every(node => after.includes(node)));
ok('the frame stylesheet is installed once', doc.head.children.filter(node => node.id === 'awt-unicorn-marker-styles').length === 1);

const fallbackDoc = makeDoc();
const fallback = planet(fallbackDoc, 2, null);
api.renderUnicornMarkers(fallbackDoc, payload);
ok('out-of-vision rows without game ids use verified system/index mapping', fallback.cell.querySelector('.awt-unicorn-rank')?.textContent === '[50]' && !!fallback.cell.querySelector('.awt-unicorn-gc'));
fallbackDoc.defaultView.location.pathname = '/Game/Science';
api.renderUnicornMarkers(fallbackDoc, payload);
ok('unknown paths never invent a location match and remove old marks', !fallback.cell.querySelector('.awt-unicorn-marker'));
fallbackDoc.defaultView.location = { pathname: '/Game/System', search: '?id=710' };
ok('supported query-string system pages resolve exactly', api.systemIdForDocument(fallbackDoc) === 710);

api.renderUnicornMarkers(doc, { rows: payload.rows.slice(1, 2), leaders: [], synced_at: null });
ok('a new snapshot removes dropped ranks and leader awards', !p1.cell.querySelector('.awt-unicorn-marker') && !p2.cell.querySelector('.awt-unicorn-gc') && !map711.querySelector('.awt-unicorn-marker'));
ok('missing snapshot timestamps stay explicitly unknown', /snapshot time unknown/.test(p2.cell.querySelector('.awt-unicorn-rank').title));
const marker = p2.cell.querySelector('.awt-unicorn-rank');
ok('the observer ignores owned nodes added to the game', api.isUnicornMutation({ target: p2.cell, addedNodes: [marker], removedNodes: [] }));
ok('the observer ignores text changed inside a marker', api.isUnicornMutation({ target: marker, addedNodes: [new Node('text')], removedNodes: [] }));
ok('native markup mixed into the same mutation still triggers a render', !api.isUnicornMutation({ target: p2.cell, addedNodes: [marker, new Node('div')], removedNodes: [] }));

api.clearUnicornMarkers(doc);
ok('OFF removes every marker and its frame stylesheet', doc.querySelectorAll('.awt-unicorn-owned').length === 0 && !doc.getElementById('awt-unicorn-marker-styles'));
ok('OFF preserves original map labels and planet data', map710.querySelector('span').textContent === 'Synthetic [710]' && p1.cell.textContent === '1' && p2.cell.textContent === '2');
api.renderUnicornMarkers(doc, payload);
ok('mode can be enabled again after complete cleanup', p1.cell.querySelector('.awt-unicorn-rank')?.textContent === '[01]');

const code = source.replace(/\/\/[^\n]*/g, '');
ok('the marker renderer has no request or action handlers', !/\bfetch\s*\(|gameFetch|XMLHttpRequest|addEventListener|\.submit\s*\(|\.click\s*\(/.test(code));
ok('annotations never replace native markup', !/innerHTML|outerHTML|replaceChildren/.test(code));
console.log(failed ? `  FAIL (${failed})` : '  PASS');
process.exit(failed ? 1 : 0);
