// Synthetic SQLite/DOM observations: availability must remain separate from ranks,
// live fleets and permissions-filtered battle details.
process.env.AWT_DB_PATH = ':memory:';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const Time = require('../../public/js/utils/sqlite-time');
const Statistics = require('../../public/js/utils/api-planet-statistics');
const db = new Database(':memory:');
db.exec(`CREATE TABLE systems (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE planets (game_planet_id INTEGER, system_id INTEGER, planet_index INTEGER);
    CREATE TABLE best_planets_snapshot (game_planet_id INTEGER PRIMARY KEY, rank INTEGER,
        updated_at TEXT, hf INTEGER, rf INTEGER, gc INTEGER, rl INTEGER);`);
require.cache[require.resolve('../database')] = { exports: db };
const repo = require('../repositories/unicorn');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const stamp = '2026-10-10T12:00:00Z';
const now = Date.parse(stamp);
ok('an older schema retains normal ranking reads without statistics', repo.getUnicornIntel({ now }).statistics.length === 0);
db.exec(`ALTER TABLE planets ADD COLUMN api_statistics TEXT;
    ALTER TABLE planets ADD COLUMN api_statistics_observed_at TEXT;
    INSERT INTO systems VALUES (710, 'Synthetic Statistic Field'), (711, 'Synthetic Second Field');`);
const flags = { bestPlanet: true, bestGuarded: true, strongestFleets: true, recentBattles: true };
const insert = db.prepare('INSERT INTO planets VALUES (?, ?, ?, ?, ?)');
insert.run(71001, 710, 1, JSON.stringify(flags), stamp);
insert.run(71002, 710, 2, JSON.stringify(flags), '2026-10-10T10:00:00Z');
insert.run(71003, 710, 3, JSON.stringify(flags), '2026-10-09T10:00:00Z');
insert.run(71004, 710, 4, '{bad', stamp);
insert.run(71005, 710, 5, JSON.stringify(flags), stamp);
insert.run(71005, 711, 5, JSON.stringify(flags), stamp);
insert.run(71006, 710, 6, JSON.stringify(flags), null);
insert.run(71007, 710, 100, JSON.stringify(flags), stamp);
insert.run(71008, 999, 1, JSON.stringify(flags), stamp);
let payload = repo.getUnicornIntel({ now });
ok('only fresh valid unambiguous known locations expose categories',
    payload.statistics.map(row => row.game_planet_id).join(',') === '71001,71002', payload.statistics);
ok('battle categories expire independently of daily ranking categories',
    payload.statistics[0]?.categories.recentBattles === true
    && payload.statistics[1]?.categories.recentBattles === false, payload.statistics);
ok('availability neither fills ranking positions nor chooses building leaders',
    payload.total === 0 && payload.rows.length === 0 && payload.leaders.length === 0
    && payload.leaders_status === 'unavailable', payload);
ok('read payload contains no nested statistics or player/battle details',
    payload.statistics.every(row => Object.keys(row).sort().join(',')
        === 'categories,game_planet_id,observed_at,planet_index,system_id,system_name'));

const markerSource = fs.readFileSync(path.join(__dirname, '../../public/js/core/unicorn-markers.js'), 'utf8');
const markers = new Function('globalThis', `${markerSource.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')}; return {renderUnicornMarkers,clearUnicornMarkers};`)(
    { AWSqliteTime: Time, AWPlanetStatistics: Statistics });
class Node {
    constructor(tag, text = '') {
        this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this._text = text;
        this.className = ''; this.id = ''; this.parentNode = null;
        this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    matches(selector) {
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        const attr = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
        return attr ? this.getAttribute(attr[1]) === attr[2] : this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const html = new Node('html'), head = html.appendChild(new Node('head')), body = html.appendChild(new Node('body'));
const tbody = body.appendChild(new Node('table')).appendChild(new Node('tbody'));
const map = body.appendChild(new Node('div')); map.className = 'map-planet';
map.appendChild(new Node('span', 'Synthetic Statistic Field [710]'));
const row = tbody.appendChild(new Node('tr')); row.setAttribute('data-planet-id', '71001');
const cell = row.appendChild(new Node('td', '1'));
const wrongRow = tbody.appendChild(new Node('tr')); wrongRow.setAttribute('data-planet-id', '99999');
const wrongCell = wrongRow.appendChild(new Node('td', '1'));
const fallbackRow = tbody.appendChild(new Node('tr'));
const fallbackCell = fallbackRow.appendChild(new Node('td', '2'));
const doc = {
    head, body, createElement: tag => new Node(tag),
    defaultView: { location: { pathname: '/Game/Map/SolarSystem/710', search: '' } },
    querySelectorAll: selector => selector === '#solarSystem > tbody > tr' ? tbody.children : html.querySelectorAll(selector),
    getElementById: id => [head, ...head.children].find(node => node.id === id) || null,
};
markers.renderUnicornMarkers(doc, payload, now);
ok('an API-only system receives the existing opt-in Unicorn map marker',
    map.querySelectorAll('.awt-unicorn-map-marker').length === 1);
ok('all four available categories receive accessible planet badges',
    cell.querySelectorAll('.awt-unicorn-api-statistic').length === 4
    && cell.querySelectorAll('.awt-unicorn-api-statistic').every(node => /statistics available/.test(node.getAttribute('aria-label'))));
ok('API badges never invent numbered ranks, building awards or fleet numbers',
    !cell.querySelector('.awt-unicorn-rank') && !cell.querySelector('.awt-unicorn-hf')
    && !/rank|champion|CV|fleet count/i.test(cell.querySelector('[data-aw-unicorn-key="api-strongestFleets"]').title));
ok('API-only map descriptions carry their actual capture time',
    /API snapshot/.test(map.querySelector('.awt-unicorn-map-marker').title)
    && !/snapshot time unknown/.test(map.querySelector('.awt-unicorn-map-marker').title));
ok('known different planet IDs never inherit a statistic via their location', !wrongCell.querySelector('.awt-unicorn-marker'));
ok('id-less fallback rows use verified location and respect battle expiry',
    fallbackCell.querySelectorAll('.awt-unicorn-api-statistic').length === 3
    && !fallbackCell.querySelector('[data-aw-unicorn-key="api-recentBattles"]'));
const before = cell.querySelectorAll('.awt-unicorn-marker');
markers.renderUnicornMarkers(doc, payload, now);
ok('rerender preserves marker identity and does not duplicate category badges',
    before.length === cell.querySelectorAll('.awt-unicorn-marker').length
    && before.every(node => cell.querySelectorAll('.awt-unicorn-marker').includes(node)));
markers.renderUnicornMarkers(doc, payload, now + Statistics.BATTLES_MAX_AGE_MS);
ok('existing DOM battle badges are removed as the snapshot expires',
    cell.querySelectorAll('.awt-unicorn-api-statistic').length === 3
    && !cell.querySelector('[data-aw-unicorn-key="api-recentBattles"]'));
db.prepare('UPDATE planets SET api_statistics = ? WHERE game_planet_id = 71001').run(JSON.stringify({ bestPlanet: false, bestGuarded: false, strongestFleets: false, recentBattles: false }));
payload = repo.getUnicornIntel({ now });
markers.renderUnicornMarkers(doc, payload, now);
ok('an explicit clearing observation removes that planet\'s category badges', !cell.querySelector('.awt-unicorn-marker'));
markers.clearUnicornMarkers(doc);
ok('OFF removes all statistics decorations and preserves native planet indices',
    doc.querySelectorAll('.awt-unicorn-owned').length === 0 && cell.textContent === '1' && fallbackCell.textContent === '2');

const uiSource = fs.readFileSync(path.join(__dirname, '../../public/js/ui/unicorn-mode.js'), 'utf8');
const ui = new Function('globalThis', `${uiSource.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')}; return {summarizeUnicornData};`)(
    { AWSqliteTime: Time, AWPlanetStatistics: Statistics, AWUnicornMode: require('../../public/js/utils/unicorn-mode') });
const summary = ui.summarizeUnicornData(payload, now);
ok('API-only status names availability while keeping unavailable leaders explicit',
    /API statistics available for 1 located planet/.test(summary) && /Building leaders unavailable/.test(summary), summary);
ok('expired snapshots disappear from availability status without another fetch',
    !/API statistics available/.test(ui.summarizeUnicornData(payload, now + Statistics.SNAPSHOT_MAX_AGE_MS)));
db.close();
console.log(`unicorn-api-statistics.test.js: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
