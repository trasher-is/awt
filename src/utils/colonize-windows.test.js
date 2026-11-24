// Science page launch windows: with no home planet on record the page says so and asks the
// game for nothing, instead of showing a time from a guessed planet (2026-11-23).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const source = fs.readFileSync(path.join(__dirname, '../../public/js/core/page-injections.js'), 'utf8');
const start = source.indexOf('export async function initColonizeLaunchWindows()');
const end = source.indexOf('\n}\n', start) + 3;
const code = source.slice(start, end).replace('export ', '');

async function run(origin) {
    const appended = [];
    const asked = [];
    const element = () => ({ style: {}, children: [], innerHTML: '', textContent: '', appendChild(c) { this.children.push(c); } });
    const attrs = {};
    const row = {
        innerText: 'Culture 1', cells: [{}, { innerText: '1' }, {}, {}, { appendChild: e => appended.push(e) }],
        getAttribute: k => attrs[k], setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; },
        querySelector: () => ({ getAttribute: () => '7200' })
    };
    const context = vm.createContext({
        console, Date, Math, parseInt, isNaN, Number, Array,
        window: { location: { pathname: '/Game/Science' } },
        document: { querySelectorAll: () => [row], createElement: element },
        findServerCycleTimer: () => ({ getAttribute: k => (k === 'data-seconds' ? '60' : '300') }),
        nextCycleTickAtOrAfter: t => t,
        fetch: async () => ({ json: async () => ({ success: true, origin,
            plans: [{ system_id: 4, planet_index: 10, system_name: 'Home' }] }) }),
        getTravelTime: async args => { asked.push(args); return { ok: true, data: { totalSeconds: 60 } }; },
        readScienceState: () => ({ level: 0 }), SCIENCES: [{ name: 'Energy' }],
        formatLocalDateTime: () => 'SOMETIME', esc: s => s
    });
    vm.runInContext(code, context);
    await vm.runInContext('initColonizeLaunchWindows()', context);
    return { appended, asked };
}

(async () => {
    let r = await run({ system_id: 4, planet_index: null });
    ok('an unknown home planet shows one message', r.appended.length === 1 && /home planet is not known/.test(r.appended[0].textContent), r.appended);
    ok('and asks the game for no travel time', r.asked.length === 0, r.asked);
    r = await run({ system_id: 4, planet_index: 11 });
    ok('a known home asks from that planet', r.asked.length === 1 && r.asked[0].fromPlanetIndex === 11, r.asked);
    ok('and shows the launch time', r.appended.length === 1 && r.appended[0].children.some(c => c.innerHTML.includes('SOMETIME')));
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
