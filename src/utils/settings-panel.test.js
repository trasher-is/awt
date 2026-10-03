// public/js/ui/settings-panel.js and public/components/settings.html — the Settings panel.
//
// The panel is drawn from the catalogue, so what is pinned here is that the drawing keeps
// faith with it: one switch per catalogue key, each in the right state, nothing the member
// must never be able to hide, text escaped; that the sidebar buttons really follow the
// settings; and that every element id the script reaches for exists in the markup.
//
// Browser ESM, so it is copied to a temp .mjs with its imports pointed at real files and the
// store swapped for a small fake.
//
// Run with: node src/utils/settings-panel.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const S = require(path.join(ROOT, 'public/js/utils/hub-settings.js'));

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (text, re) => (text.match(re) || []).length;

console.log('settings-panel.test.js');

let finished = false;
process.on('exit', () => { if (!finished) { console.error('  NOT OK - the suite did not run to the end'); process.exitCode = 1; } });

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-settings-panel-'));
    // The store, faked: what it answers is whatever `fake.overrides` says.
    const fake = { overrides: {} };
    globalThis.__awtFakeStore = fake;
    fs.writeFileSync(path.join(tmp, 'store.mjs'), `
        const S = globalThis.AWHubSettings;
        const f = globalThis.__awtFakeStore;
        export const isEnabled = key => S.isEnabled(key, f.overrides);
        export const snapshot = () => S.resolve(f.overrides);
        export const onChange = () => () => {};
        export const change = async () => {};
        export const reset = async () => {};
        export const whenReady = async () => {};
    `);
    fs.writeFileSync(path.join(tmp, 'escape.mjs'), read('public/js/utils/escape.js'));
    const src = read('public/js/ui/settings-panel.js')
        .replace("from '../utils/escape.js'", `from '${pathToFileURL(path.join(tmp, 'escape.mjs')).href}'`)
        .replace("import '../utils/hub-settings.js';", `import '${pathToFileURL(path.join(ROOT, 'public/js/utils/hub-settings.js')).href}';`)
        .replace("from './hub-settings-store.js'", `from '${pathToFileURL(path.join(tmp, 'store.mjs')).href}'`);
    fs.writeFileSync(path.join(tmp, 'panel.mjs'), src);
    const panel = await import(pathToFileURL(path.join(tmp, 'panel.mjs')).href);

    // ─── The markup ───────────────────────────────────────────────────────────
    console.log('\n── Markup ' + '─'.repeat(65));
    const defaults = panel.settingsHtml(S.resolve({}));
    ok('one switch per catalogue key', count(defaults, /data-setting="/g) === S.ALL.length, count(defaults, /data-setting="/g));
    ok('each key appears exactly once', S.ALL.every(i => count(defaults, new RegExp(`data-setting="${i.key.replace('.', '\\.')}"`, 'g')) === 1));
    ok('on by default means checked, off means not', count(defaults, /type="checkbox"[^>]*checked>/g) === S.ALL.filter(i => i.defaultOn).length, count(defaults, /type="checkbox"[^>]*checked>/g));
    const row = key => (defaults.match(new RegExp(`<input[^>]*data-setting="${key.replace('.', '\\.')}"[^>]*>`)) || [''])[0];
    ok('Battle Calc starts unchecked', !/checked/.test(row('tool.battleCalc')), row('tool.battleCalc'));
    ok('Supply Unit buttons start checked', /checked/.test(row('inject.suButtons')), row('inject.suButtons'));

    const custom = panel.settingsHtml(S.resolve({ 'tool.battleCalc': true, 'inject.suButtons': false }));
    const customRow = key => (custom.match(new RegExp(`<input[^>]*data-setting="${key.replace('.', '\\.')}"[^>]*>`)) || [''])[0];
    ok('a stored choice flips its own switch only', /checked/.test(customRow('tool.battleCalc')) && !/checked/.test(customRow('inject.suButtons')) && /checked/.test(customRow('inject.buildingHints')));

    ok('every label and description is shown', S.ALL.every(i => defaults.includes(i.label.replace(/&/g, '&amp;')) ), S.ALL.filter(i => !defaults.includes(i.label)).map(i => i.label));
    ok('every group has its heading', S.GROUPS.every(g => defaults.includes(g.label)));
    ok('it says which tools start off, naming all four', /Off until you turn them on:[^<]*Road to TA[^<]*Battle Calc[^<]*Build Order and Empire Simulator\./.test(defaults), (defaults.match(/Off until[^<]*/) || [])[0]);
    ok('the experimental tools are tagged', count(defaults, />Experimental</g) === S.TOOLS.filter(t => t.note).length && S.TOOLS.some(t => t.note));
    ok('there is no switch for Settings, Link Discord, Logout or Admin', !/data-setting="[^"]*(settings|discord|logout|admin)/i.test(defaults));
    ok('it explains what cannot be switched off, and why', /Not listed:[^<]*alliance relies/.test(defaults));
    ok('each switch is a real checkbox inside a label (keyboard and screen readers)', count(defaults, /<label /g) === S.ALL.length && count(defaults, /type="checkbox"/g) === S.ALL.length);
    ok('the checkbox is visually replaced, not removed', count(defaults, /class="peer sr-only"/g) === S.ALL.length);

    // Text is escaped: the catalogue is ours, but the rule is cheap and a future entry may carry a & or <.
    const realTools = S.TOOLS.slice();
    S.TOOLS.push({ kind: 'tool', key: 'tool.xss', label: '<img src=x onerror=alert(1)> & co', icon: 'fa-bug', button: 'open-xss-btn', defaultOn: true });
    const hostile = panel.settingsHtml(S.resolve({}));
    S.TOOLS.length = 0; realTools.forEach(t => S.TOOLS.push(t));
    ok('labels are escaped', !/<img src=x/.test(hostile) && /&lt;img src=x/.test(hostile) && /&amp; co/.test(hostile));

    // ─── The sidebar ──────────────────────────────────────────────────────────
    console.log('\n── Sidebar buttons ' + '─'.repeat(56));
    const makeDoc = ids => {
        const buttons = Object.fromEntries(ids.map(id => [id, { style: { display: '' } }]));
        return { buttons, getElementById: id => buttons[id] || null };
    };
    fake.overrides = {};
    let doc = makeDoc(S.TOOLS.map(t => t.button).concat('open-settings-btn', 'link-discord-btn'));
    panel.applySidebarTools(doc);
    ok('the four experimental tools are hidden by default', ['open-battle-calc-btn', 'open-road-to-ta-btn', 'open-build-order-btn', 'open-empire-sim-btn'].every(id => doc.buttons[id].style.display === 'none'));
    ok('every other tool is shown', S.TOOLS.filter(t => t.defaultOn).every(t => doc.buttons[t.button].style.display === ''));
    ok('Settings and Link Discord are never touched', doc.buttons['open-settings-btn'].style.display === '' && doc.buttons['link-discord-btn'].style.display === '');

    fake.overrides = { 'tool.battleCalc': true, 'tool.warRoom': false };
    panel.applySidebarTools(doc);
    ok('turning an off-by-default tool on shows it again', doc.buttons['open-battle-calc-btn'].style.display === '');
    ok('turning a default tool off hides it', doc.buttons['open-war-room-btn'].style.display === 'none');
    ok('the display is an inline style, not a class Tailwind\'s .flex could beat', /style\.display = isEnabled/.test(read('public/js/ui/settings-panel.js')));

    ok('a button missing from the page is skipped, not a crash', (() => { try { panel.applySidebarTools(makeDoc([])); return true; } catch (e) { return false; } })());

    // ─── The component and the script agree ───────────────────────────────────
    console.log('\n── Component ids ' + '─'.repeat(58));
    const html = read('public/components/settings.html');
    const js = read('public/js/ui/settings-panel.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const wanted = [...new Set([...js.matchAll(/['"`]#([a-z-]+)['"`]/g)].map(m => m[1]).concat([...js.matchAll(/getElementById\('([a-z-]+)'\)/g)].map(m => m[1])))]
        .filter(id => id.startsWith('settings-'));
    ok('the script looks up the ids it should', ['settings-close-btn', 'settings-body', 'settings-reset-btn', 'settings-reload-btn', 'settings-reload-note', 'settings-status'].every(id => wanted.includes(id)), wanted);
    for (const id of wanted.concat('settings-panel')) ok(`#${id} exists in settings.html`, new RegExp(`id="${id}"`).test(html));
    ok('the panel opens from the sidebar only, never by itself (it covers the game on a phone)', !/openSettingsPanel\(\)/.test(read('public/js/ui/dashboard.js').replace(/\/\/.*$/gm, '')) && /addEventListener\('click', openSettingsPanel\)/.test(read('public/js/ui/dashboard.js')));
    ok('the panel starts closed, off-screen', /translate-x-full/.test(html.split('\n')[0]) && !/translate-x-0/.test(html.split('\n')[0]));
    ok('it fits a phone: full width below md, the sleep-map shell above', /w-full md:w-\[calc\(100%-3\.5rem\)\]/.test(html));
    ok('reloading the game page is a GET of the same URL, never a resubmit', /location\.replace\(frame\.contentWindow\.location\.href\)/.test(js) && !/location\.reload\(/.test(js));
    ok('and the panel never talks to the game', !/gameFetch|\/Game\//.test(js));

    finished = true;
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
