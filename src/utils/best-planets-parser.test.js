// Hand-written Top 50 tables only. The generic parser stays untouched for secret goals.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let failed = 0;
function ok(name, condition, detail) {
    console.log(`${condition ? '  ok' : '  NOT OK'} - ${name}${condition || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!condition) failed++;
}

class Element {
    constructor(tag, text) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = []; if (text !== undefined) this.textContent = text; }
    get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
    set textContent(text) { this.childNodes = [{ nodeType: 3, textContent: String(text), parentElement: this }]; }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get cells() { return this.children.filter(child => child.tagName === 'TD' || child.tagName === 'TH'); }
    get colSpan() { return Number(this.attrs.colspan || 1); }
    get rowSpan() { return Number(this.attrs.rowspan || 1); }
    appendChild(node) { this.childNodes.push(node); node.parentElement = this; return node; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    matches(selector) {
        return selector.split(',').some(piece => {
            piece = piece.trim();
            if (piece.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(piece.slice(1));
            const match = /^([a-z]+)?(?:\[([\w-]+)(\^=|\*=|=)?"?([^\]"]*)"?\])?$/i.exec(piece);
            if (!match) throw new Error(`Unsupported synthetic selector ${piece}`);
            if (match[1] && this.tagName !== match[1].toUpperCase()) return false;
            if (!match[2]) return true;
            const value = this.getAttribute(match[2]);
            if (value === null) return false;
            return !match[3] || (match[3] === '^=' ? value.startsWith(match[4]) : match[3] === '*=' ? value.includes(match[4]) : value === match[4]);
        });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
        const found = [];
        for (const child of this.children) {
            if (selector === 'table tr' ? child.tagName === 'TR' && child.closest('table') : child.matches(selector)) found.push(child);
            found.push(...child.querySelectorAll(selector));
        }
        return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture(headers = ['Rank', 'Planet', 'HF', 'RF', 'GC', 'RL']) {
    const doc = new Element('body'), table = doc.appendChild(new Element('table'));
    const header = table.appendChild(new Element('thead')).appendChild(new Element('tr'));
    headers.forEach(text => header.appendChild(new Element('th', text)));
    const body = table.appendChild(new Element('tbody'));
    return { doc, table, header, row({ rank = 1, id = 101, levels = ['11', '12', '13', '14'], href, extraLink = false } = {}) {
        const row = body.appendChild(new Element('tr'));
        row.appendChild(new Element('td', rank));
        const planet = row.appendChild(new Element('td'));
        const link = planet.appendChild(new Element('a', 'Synthetic planet'));
        link.setAttribute('href', href === undefined ? `/Game/Map/Planet/${id}` : href);
        if (extraLink) { const second = planet.appendChild(new Element('a', 'Another link')); second.setAttribute('href', `/Game/Map/Planet/${id}`); }
        levels.forEach(text => row.appendChild(new Element('td', text)));
        return row;
    } };
}

const context = vm.createContext({ console });
function source(file) { return fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, ''); }
vm.runInContext(source('public/js/utils/ranking-page-parser.js'), context);
vm.runInContext(source('public/js/utils/best-planets-parser.js'), context);
const parse = context.parseBestPlanetsPage;

const full = fixture();
for (let rank = 50; rank >= 1; rank--) full.row({ rank, id: 1000 + rank, levels: [String(rank), '22', '33', '44'] });
const all = parse(full.doc);
ok('all 50 current planet identities join their own building cells independently of row order', all.length === 50 && all.every(row => row.buildings.HF === row.rank && row.game_planet_id === row.rank + 1000));
ok('generic ranking ownership fields remain available', all.every(row => row.owner_name === null && row.owner_alliance_tag === null));
const shuffled = fixture(['Rank', 'Planet', 'RL', 'GC', 'HF', 'RF']); shuffled.row({ levels: ['44', '33', '11', '22'] });
ok('building metrics follow shuffled headers', JSON.stringify(parse(shuffled.doc)[0].buildings) === '{"HF":11,"RF":22,"GC":33,"RL":44}');
const named = fixture(['Rank', 'Planet', 'Research Lab', 'Robotic Factory', 'Hydroponic Farm', 'Galactic Cybernet']); named.row({ levels: ['44', '22', '11', '33'] });
ok('confirmed full English names map to the exact four metrics', JSON.stringify(parse(named.doc)[0].buildings) === '{"HF":11,"RF":22,"GC":33,"RL":44}');
const partial = fixture(['Rank', 'Planet', 'HF', 'RF', 'Unknown', 'RL']); partial.row();
ok('an unrecognized column leaves only that metric unknown', parse(partial.doc)[0].buildings.GC === null && parse(partial.doc)[0].buildings.HF === 11);
const ambiguous = fixture(['Rank', 'Planet', 'HF', 'Hydroponic Farm', 'GC', 'RL']); ambiguous.row();
ok('ambiguous repeated semantic header suppresses all building values', Object.values(parse(ambiguous.doc)[0].buildings).every(value => value === null));
// Header wording confirmed from the game; all identities and values are synthetic.
const gameHeaders = fixture(['#', 'Rank +/-', 'Name', 'Planet', 'Farm', 'Fac.', 'Cyb.', 'Lab', 'Σ']);
for (let rank = 1; rank <= 50; rank++) {
    const row = gameHeaders.row({ rank, id: 2000 + rank, levels: ['Synthetic name', 'Synthetic location', String(rank), '22', '33', '44', String(rank + 99)] });
    // Match the real column arrangement: ranking movement, owner, then planet link.
    const planetCell = row.cells[1], locationCell = row.cells[3];
    locationCell.childNodes = planetCell.childNodes;
    for (const child of locationCell.childNodes) child.parentElement = locationCell;
    planetCell.textContent = '+0';
}
const gameRows = parse(gameHeaders.doc);
ok('confirmed game headers preserve all 50 identities and exact building values', gameRows.length === 50 && gameRows.every(row => row.game_planet_id === 2000 + row.rank && row.buildings.HF === row.rank && row.buildings.RF === 22 && row.buildings.GC === 33 && row.buildings.RL === 44));
const { normalizeBuildings, summarizeLeaders } = require('./unicorn-ranking');
const gameLeaders = summarizeLeaders(gameRows.map(row => ({ ...row, ...normalizeBuildings(row.buildings) })));
ok('confirmed game headers supply complete data for all four leaders', gameLeaders.leaders_status === 'complete' && gameLeaders.leaders.length === 4 && gameLeaders.leaders.find(leader => leader.kind === 'HF').game_planet_id === 2050);
const unconfirmed = fixture(['Rank', 'Planet', 'Unknown', 'Factory', 'Cybernet', 'Other']); unconfirmed.row();
ok('unconfirmed short names are still never guessed', Object.values(parse(unconfirmed.doc)[0].buildings).every(value => value === null));
const spanned = fixture(); const spannedRow = spanned.row(); spanned.header.cells[2].setAttribute('colspan', '2');
ok('spanning header cannot shift building columns silently', Object.values(parse(spanned.doc)[0].buildings).every(value => value === null));
spanned.header.cells[2].setAttribute('colspan', '1'); spannedRow.cells[3].setAttribute('rowspan', '2');
ok('spanning body cannot shift building columns silently', Object.values(parse(spanned.doc)[0].buildings).every(value => value === null));
spannedRow.cells[3].setAttribute('rowspan', '1'); spannedRow.appendChild(new Element('td', '99'));
ok('body/header length mismatch is unknown rather than a partial guess', Object.values(parse(spanned.doc)[0].buildings).every(value => value === null));
const progress = fixture(); const progressRow = progress.row({ levels: ['12', '0', '13', '14'] });
const percentage = progressRow.cells[2].appendChild(new Element('span', '75%')); percentage.setAttribute('class', 'progress-text');
ok('explicit progress markup is stripped without changing the integer building level', parse(progress.doc)[0].buildings.HF === 12 && parse(progress.doc)[0].buildings.RF === 0);
for (const bad of ['12.75', '12 (75%)', '12/20', '-1', 'N/A', '12x', '9007199254740992', '']) {
    progressRow.cells[2].textContent = bad;
    ok(`malformed or mixed level stays unknown: ${JSON.stringify(bad)}`, parse(progress.doc)[0].buildings.HF === null);
}
progressRow.cells[2].textContent = '12'; progressRow.cells[2].appendChild(new Element('span', '75'));
ok('adjacent numeric text nodes do not accidentally concatenate into a fake level', parse(progress.doc)[0].buildings.HF === null);
const duplicates = fixture(); duplicates.row({ rank: 1, id: 101 }); duplicates.row({ rank: 1, id: 102 }); duplicates.row({ rank: 2, id: 103 }); duplicates.row({ rank: 3, id: 103 }); duplicates.row({ rank: 4, id: 104 });
ok('all duplicate rank/planet-ID entries are excluded, leaving unique rows only', parse(duplicates.doc).length === 1 && parse(duplicates.doc)[0].game_planet_id === 104);
for (const spec of [{ rank: '1x' }, { rank: '1.2' }, { rank: 0 }, { rank: 51 }, { id: 0 }, { id: -1 }, { id: '9007199254740992' }, { href: '/Game/Map/Planet/101junk' }, { href: '/Game/Map/Planet/101?foo=1' }, { extraLink: true }]) {
    const malformed = fixture(); malformed.row(spec);
    ok(`unambiguous exact rank and planet ID required: ${JSON.stringify(spec)}`, parse(malformed.doc).length === 0);
}
ok('an empty document produces no snapshot', parse(new Element('body')).length === 0);
const permissive = fixture(); permissive.row({ rank: '1x' });
ok('the generic secret-goal parser retains its original behavior', context.parseRankingPage(permissive.doc).length === 1 && parse(permissive.doc).length === 0);

(async () => {
    const calls = [], posts = [], locks = new Map();
    Object.assign(context, {
        AWGameRate: { gameFetch: async url => { calls.push(url); return { ok: true, text: async () => 'synthetic' }; } },
        DOMParser: class { parseFromString() { return full.doc; } },
        fetch: async (url, init) => { posts.push({ url, init }); return { ok: true }; },
        localStorage: { getItem: key => locks.get(key), setItem: (key, value) => locks.set(key, value) },
        setInterval() {},
    });
    vm.runInContext(source('public/js/ui/best-planets-watch.js'), context);
    context.initBestPlanetsWatch();
    await new Promise(resolve => setImmediate(resolve));
    const rows = JSON.parse(posts[0].init.body).rows;
    ok('watcher reuses its one existing gated Best Planets fetch', calls.length === 1 && calls[0] === '/Ranking/BestPlanets' && posts[0].url === '/hub-api/sync/best-planets-snapshot');
    ok('existing snapshot carries only rank, planet ID and building values', rows.length === 50 && Object.keys(rows[0]).sort().join() === 'buildings,game_planet_id,rank' && rows.every(row => row.buildings.HF === row.rank));
    context.initBestPlanetsWatch(); await new Promise(resolve => setImmediate(resolve));
    ok('reinitialization creates no additional ranking request', calls.length === 1);
    if (failed) process.exitCode = 1;
    else console.log('All best-planets-parser checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
