// Speed Rules panel: drive the real module against a synthetic DOM built from its component.
// Checks the numbers worked out by hand on 2026-11-08 (E35 +4 defender vs E50 −4 attacker,
// one system each from the destination), the allied halving, both pickers, and that the
// panel never talks to the game.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const root = path.join(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function element(attributes = {}) {
    const classes = new Set((attributes.class || '').split(/\s+/));
    const listeners = new Map();
    let html = '';
    const node = {
        attributes, value: attributes.value || '', checked: false, dataset: {}, buttons: [],
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value;
            node.buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(m => {
                const a = attrs(m[1]);
                const b = element(a);
                b.dataset = Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v]));
                return b;
            });
        },
        get textContent() { return html.replace(/<[^>]*>/g, ''); },
        classList: {
            add(n) { classes.add(n); }, remove(n) { classes.delete(n); }, contains(n) { return classes.has(n); },
            replace(a, b) { if (!classes.delete(a)) return false; classes.add(b); return true; }
        },
        querySelectorAll(sel) { return node.buttons.filter(b => b.classList.contains(sel.slice(1))); },
        addEventListener(name, cb) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(cb); },
        async fire(name) { await Promise.all((listeners.get(name) || []).map(cb => cb({ currentTarget: node, preventDefault() {} }))); }
    };
    return node;
}

function panel() {
    const elements = new Map([...read('public/components/speed-rules.html').matchAll(/<\w+\b([^>]*\bid="[^"]+"[^>]*)>/g)]
        .map(m => { const a = attrs(m[1]); return [a.id, element(a)]; }));
    const get = id => elements.get(id) || null;
    const fetches = [];
    const context = vm.createContext({
        console, esc: v => String(v),
        AWTravelModel: require('../../public/js/utils/travel-model'),
        document: {
            getElementById: get,
            querySelectorAll: sel => sel === '#speed-rules-panel .sr-in' ? [...elements.values()].filter(n => n.classList.contains('sr-in')) : []
        },
        setTimeout: () => 0,
        async fetch(url) {
            fetches.push(url);
            if (url === '/hub-api/intel/players') return { json: async () => ({ success: true, players: [
                { name: 'Defendo', energy: 35, race_speed: 4 }, { name: 'Smasher', energy: 50, race_speed: -4 }] }) };
            if (url === '/hub-api/intel/systems_db') return { json: async () => ({ success: true, systems: [
                { id: 41, name: 'Left', x: -1, y: 0 }, { id: 42, name: 'Middle', x: 0, y: 0 }, { id: 43, name: 'Right', x: 1, y: 0 }] }) };
            throw new Error('Unexpected request ' + url);
        }
    });
    const src = read('public/js/ui/speed-rules.js').replace(/^import .*$/gm, '').replace(/^export /gm, '');
    vm.runInContext(src, context);
    vm.runInContext('initSpeedRules()', context);
    const set = async (id, value) => { const n = get(id); if (n.type === undefined && typeof value === 'boolean') n.checked = value; else n.value = String(value); await n.fire('input'); };
    const rows = () => [...get('sr-rows').innerHTML.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(m => m[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    const verdict = () => get('sr-verdict').textContent.replace(/\s+/g, ' ');
    async function pick(inputId, query, dropId, match) {
        get(inputId).value = query;
        await get(inputId).fire('input');
        await flush();
        const btn = get(dropId).buttons.find(match);
        if (!btn) throw new Error('picker did not render ' + query);
        await btn.fire('mousedown');
    }
    return { get, set, rows, verdict, pick, fetches };
}

async function main() {
    console.log('speed-rules-panel.test.js');
    const h = panel();
    ok('defaults render one row per player', h.rows().length === 2, h.rows());
    ok('speed 0 on both sides: new equals now', h.rows().every(r => /no change/.test(r)), h.rows());

    // Defender E35 +4 one system to the right, attacker E50 −4 one system to the left.
    await h.pick('sr-a-player-input', 'def', 'sr-a-player-dropdown', b => b.dataset.name === 'Defendo');
    await h.pick('sr-b-player-input', 'smash', 'sr-b-player-dropdown', b => b.dataset.name === 'Smasher');
    ok('player picker fills energy and race speed', h.get('sr-a-energy').value === '35' && h.get('sr-a-speed').value === '4'
        && h.get('sr-b-energy').value === '50' && h.get('sr-b-speed').value === '-4');
    await h.pick('sr-a-sys-input', 'right', 'sr-a-sys-dropdown', b => b.dataset.id === '43');
    await h.pick('sr-b-sys-input', '41', 'sr-b-sys-dropdown', b => b.dataset.id === '41');
    await h.pick('sr-d-sys-input', 'mid', 'sr-d-sys-dropdown', b => b.dataset.id === '42');
    await h.set('sr-a-p', 1); await h.set('sr-b-p', 1); await h.set('sr-d-p', 1);
    ok('system picker (name or id) fills X/Y and labels the box', h.get('sr-a-x').value === '1' && h.get('sr-b-x').value === '-1'
        && h.get('sr-d-x').value === '0' && h.get('sr-d-sys-input').value === 'Middle #42');
    ok('defender row: now 01:01:53, new 00:48:08', h.rows()[0].includes('01:01:53 00:48:08'), h.rows()[0]);
    ok('attacker row: now 00:55:33, new 01:30:54', h.rows()[1].includes('00:55:33 01:30:54'), h.rows()[1]);
    ok('verdict: attacker first now, defender first under the new rule',
        h.verdict().includes('Now: Attacker lands 0:06:20 before the defender') && h.verdict().includes('New: Defender lands 0:42:46 before the attacker'), h.verdict());

    h.get('sr-a-allied').checked = true; await h.get('sr-a-allied').fire('change');
    ok('allied box halves only the defender', h.rows()[0].includes('00:30:56 00:24:04') && h.rows()[1].includes('00:55:33 01:30:54'), h.rows());
    ok('allied defender now beats the attacker under both rules', h.verdict().includes('Now: Defender lands 0:24:37') && h.verdict().includes('New: Defender lands 1:06:50'), h.verdict());

    await h.set('sr-step', 0);
    ok('step 0 makes the new column the live game', h.rows().every(r => /no change/.test(r)), h.rows());

    h.get('sr-d-x').value = '5'; await h.get('sr-d-x').fire('input');
    ok('typing coordinates by hand clears the picked system label', h.get('sr-d-sys-input').value === '');
    ok('only the hub player and system lists are fetched, once each', JSON.stringify([...h.fetches].sort()) === JSON.stringify(['/hub-api/intel/players', '/hub-api/intel/systems_db']), h.fetches);

    // Registration: sidebar button, settings tool, opener, panel list.
    const wrapper = read('public/Wrapper.html'), archives = read('public/js/ui/archives.js'), dash = read('public/js/ui/dashboard.js'), settings = read('public/js/utils/hub-settings.js');
    ok('sidebar has the Speed Rules button', wrapper.includes('id="open-speed-rules-btn"'));
    ok('the button is a switchable tool in settings', /tool\('speedRules', 'Speed Rules', 'fa-scale-balanced', 'open-speed-rules-btn'\)/.test(settings));
    ok('dashboard wires the button to the opener', /open-speed-rules-btn'\)\?\.addEventListener\('click', openSpeedRulesPanel\)/.test(dash));
    ok('other panels close when it opens, and it closes when they do', (archives.match(/'speed-rules-panel'/g) || []).length >= 4 && /closeOtherPanels\('speed-rules-panel'\)/.test(archives));
    ok('it never auto-opens: the opener is only called from the click handler',
        (dash.match(/openSpeedRulesPanel/g) || []).length === 2);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
