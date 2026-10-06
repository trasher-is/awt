// public/js/utils/game-links.js: the one way sidebar tools make players, alliances, systems
// and planets clickable. Loaded as a real ES module (escape.js alongside it), and the click
// handler driven with stand-in DOM objects.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ok - ${name}`); }
    else { fail++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); }
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-game-links-'));
    fs.writeFileSync(path.join(tmp, 'escape.mjs'), read('public/js/utils/escape.js'));
    fs.writeFileSync(path.join(tmp, 'game-links.mjs'), read('public/js/utils/game-links.js').replace("from './escape.js'", "from './escape.mjs'"));
    const L = await import(pathToFileURL(path.join(tmp, 'game-links.mjs')).href);

    console.log('── Links ' + '─'.repeat(60));
    ok('player link goes to the profile', L.playerLink(42, 'Ikki') === '<a href="/Game/Players/Profile/42" data-game-link class="hover:underline cursor-pointer">Ikki</a>', L.playerLink(42, 'Ikki'));
    ok('extra classes are kept', L.playerLink(42, 'Ikki', 'hover:text-red-400').includes('class="hover:underline cursor-pointer hover:text-red-400"'));
    ok('alliance link shows [TAG]', L.allianceLink(7, 'RAID') === '<a href="/Game/Alliance/Profile/7" data-game-link class="hover:underline cursor-pointer">[RAID]</a>');
    ok('bare alliance link drops the brackets', L.allianceLink(7, 'RAID', '', { bare: true }).endsWith('>RAID</a>'));
    ok('no tag, no output', L.allianceLink(7, null) === '' && L.allianceLink(7, '') === '');
    ok('system link', L.systemLink(339, 'Meboula').startsWith('<a href="/Game/Map/SolarSystem/339"'));
    ok('planet link uses the game planet id', L.planetLink({ planetId: 9001, systemId: 339 }, '#3').startsWith('<a href="/Game/Map/Planet/9001"'));
    ok('planet without a game id falls back to its system', L.planetLink({ systemId: 339 }, '#3').startsWith('<a href="/Game/Map/SolarSystem/339"'));
    ok('nothing known: plain text', L.planetLink({}, '#3') === '#3' && L.systemLink(null, 'X') === 'X');
    ok('text is escaped, linked or not',
        L.playerLink(1, '<img onerror=x>').includes('&lt;img onerror=x&gt;') && L.playerLink(null, '<b>') === '&lt;b&gt;');
    ok('a junk id is never put in an href', L.playerLink('1" onclick="x', 'A') === 'A' && L.systemLink(-4, 'S') === 'S' && L.systemLink(0, 'S') === 'S');

    console.log('── Name/tag index ' + '─'.repeat(51));
    ok('no id and an empty index: unlinked', L.playerLink(null, 'Ikki') === 'Ikki');
    L.setLinkIndex({ players: [[42, 'Ikki'], [5, 'Twin'], [6, 'twin'], [8, 'Same'], [8, 'Same']], alliances: [[7, 'RAID'], [9, 'zod']] });
    ok('name resolves, case-insensitively', L.playerLink(null, 'ikki').includes('/Game/Players/Profile/42'));
    ok('an explicit id wins over the index', L.playerLink(99, 'Ikki').includes('/Profile/99'));
    ok('a name two players share stays unlinked', L.playerLink(null, 'Twin') === 'Twin');
    ok('the same row twice is not "shared"', L.playerLink(null, 'Same').includes('/Profile/8'));
    ok('tag resolves, case- and bracket-insensitively', L.allianceLink(null, 'ZOD').includes('/Alliance/Profile/9') && L.allianceLink(null, '[raid]').includes('/Alliance/Profile/7'));
    ok('unknown tag stays text', L.allianceLink(null, 'NOPE') === '[NOPE]');

    console.log('── Click handler ' + '─'.repeat(52));
    let listener = null;
    L.installGameLinkHandler({ addEventListener: (type, fn, capture) => { if (type === 'click' && capture === true) listener = fn; } }, p => navigated.push(p));
    const navigated = [];
    const classes = (list) => ({ list: new Set(list), contains(c) { return this.list.has(c); }, replace(a, b) { if (!this.list.has(a)) return false; this.list.delete(a); this.list.add(b); return true; } });
    let closeClicks = 0;
    const panel = { classList: classes(['translate-x-0']), querySelector: sel => (sel === '.fa-xmark' ? { closest: () => ({ click: () => { closeClicks++; } }) } : null) };
    const anchor = { getAttribute: () => '/Game/Players/Profile/42', closest: sel => (sel === '#dynamic-panels-container > div' ? panel : null) };
    const event = (extra = {}) => {
        const e = { target: { closest: sel => (sel === 'a[data-game-link]' ? anchor : null) }, button: 0, defaultPrevented: false, prevented: false, stopped: false, ...extra };
        e.preventDefault = () => { e.prevented = true; };
        e.stopPropagation = () => { e.stopped = true; };
        return e;
    };
    ok('installed as one capturing click listener', typeof listener === 'function');
    let e = event();
    listener(e);
    ok('a plain tap loads the page in the game frame', navigated.length === 1 && navigated[0] === '/Game/Players/Profile/42', navigated);
    ok('...instead of following the link, and nothing under it reacts', e.prevented && e.stopped);
    ok('...and closes the panel through its own close button', closeClicks === 1);
    for (const [label, extra] of [['ctrl', { ctrlKey: true }], ['cmd', { metaKey: true }], ['shift', { shiftKey: true }], ['middle button', { button: 1 }]]) {
        e = event(extra);
        listener(e);
        ok(`${label}-click is left to the browser (new tab)`, !e.prevented && navigated.length === 1);
    }
    e = { target: { closest: () => null }, button: 0, preventDefault() { this.prevented = true; } };
    listener(e);
    ok('clicks elsewhere are ignored', !e.prevented && navigated.length === 1);
    const noButtonPanel = { classList: classes(['translate-x-0']), querySelector: () => null };
    anchor.closest = sel => (sel === '#dynamic-panels-container > div' ? noButtonPanel : null);
    listener(event());
    ok('a panel without a close button is slid out directly', noButtonPanel.classList.contains('translate-x-full'));
    const closedPanel = { classList: classes(['translate-x-full']), querySelector: () => { throw new Error('should not look'); } };
    anchor.closest = sel => (sel === '#dynamic-panels-container > div' ? closedPanel : null);
    listener(event());
    ok('outside an open panel (the sidebar box) it only navigates', navigated.length === 3);

    console.log('── Wiring ' + '─'.repeat(59));
    const dash = read('public/js/ui/dashboard.js');
    ok('dashboard installs the handler with navToIframe and loads the index',
        /installGameLinkHandler\(document, navToIframe\)/.test(dash) && /loadLinkIndex\(\)/.test(dash));
    const tools = ['archives.js', 'stat-columns.js', 'galaxy-dashboard.js', 'sleep-map.js', 'land-rush.js', 'defence.js', 'galaxy-map.js', 'system-intel.js', 'travel-calc-ui.js', 'route-planner.js'];
    for (const f of tools) ok(`${f} uses game-links.js`, read(`public/js/ui/${f}`).includes("from '../utils/game-links.js'"));
    const stat = read('public/js/ui/stat-columns.js');
    ok('player tables no longer open profiles in a new tab', !/Players\/Profile[^`]*target="_blank"/.test(stat));
    const fleets = read('public/components/fleets-db.html');
    ok('Fleets has the system id as its first column', fleets.indexOf("sortFltDb('system_id')") > -1 && fleets.indexOf("sortFltDb('system_id')") < fleets.indexOf("sortFltDb('system_name')"));

    console.log(`\n${pass} passed, ${fail} failed`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
