// Execute the actual controller with deferred local responses, including fetches
// that ignore AbortSignal, to prove stale results cannot overwrite the selected tab.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0, failed = 0;
function ok(name, condition, detail) {
    if (condition) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}`, detail ?? ''); }
}
const source = fs.readFileSync(path.join(__dirname, '../../public/js/ui/archives.js'), 'utf8');
const controller = source.slice(source.indexOf('let taState ='), source.indexOf('export async function openBattleCalcPanel')).replace(/export /g, '');
class Node {
    constructor() {
        this.innerHTML = ''; this.textContent = ''; this.classes = new Set(); this.attributes = {};
        this.classList = {
            contains: value => this.classes.has(value),
            toggle: (value, force) => force ? this.classes.add(value) : this.classes.delete(value),
            replace: (a, b) => { this.classes.delete(a); this.classes.add(b); },
        };
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
}
const nodes = new Map();
const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
const responses = [];
const document = { getElementById: node };
const context = vm.createContext({ document, AbortController, console,
    window: {}, formatLocalDateTime: value => String(value), esc: value => String(value).replace(/</g, '&lt;'),
    AWTradeSchedule: require('../../public/js/utils/trade-schedule-model'),
    fetch(url, options) {
        return new Promise(resolve => responses.push({ url, options, resolve }));
    },
});
vm.runInContext(`${controller}\nglobalThis.testApi = { runTradeSchedule, switchTaTab, loadTradeAgreements, formatTaHours, fmtReady, taCount, taCell,
setState(value) { taState = value; }, select(value) { taSelectedTab = value; }, };`, context);
const api = context.testApi;
const snapshot = pairs => ({ success: true, members: [], agreements: pairs.map(([a,b], index) => ({ id:index+1, status:'confirmed', player_a:a, player_b:b, pair_key:[a,b].sort().join('|') })), traders: [], maxTas:5 });
const economics = (price = 0.8) => ({ success:true, pp_price:price, players:['Alpha','Beta'].map((name,i)=>({id:i+1,name,astro_dollars:0,production_points:0,production_rate:100,trade_partners:[]})) });
function complete(call, data, status = 200) { call.resolve({ ok: status < 400, json: async () => data }); }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
    node('trade-agreements-panel').classes.add('translate-x-0'); api.select('schedule');
    node('ta-sum-time').textContent = 'stale'; node('ta-schedule-assumptions').textContent = 'stale';
    const old = api.runTradeSchedule();
    ok('loading clears obsolete summary and assumptions', node('ta-sum-time').textContent === '—' && node('ta-schedule-assumptions').textContent === '');
    const older = responses.splice(0);
    const latest = api.runTradeSchedule(); const newer = responses.splice(0);
    complete(newer[0], economics(0.8)); complete(newer[1], snapshot([['Alpha','Beta']])); await latest;
    const newestHTML = node('ta-results-body').innerHTML;
    ok('schedule values fractional A$/PP and future PP/h consistently', newestHTML.includes('+10d 10h') && node('ta-pp-price').textContent.includes('0.8 A$/PP'));
    complete(older[0], economics(1)); complete(older[1], snapshot([])); await old;
    ok('late older responses cannot replace newer results even when abort is ignored', node('ta-results-body').innerHTML === newestHTML);
    const hidden = api.runTradeSchedule(); const pending = responses.splice(0); api.switchTaTab('board');
    const hiddenHTML = node('ta-results-body').innerHTML;
    complete(pending[0], economics()); complete(pending[1], snapshot([])); await hidden;
    ok('leaving Schedule aborts and invalidates its pending response', pending[0].options.signal.aborted && node('ta-results-body').innerHTML === hiddenHTML);
    ok('tab state exposes selected panel and accessible keyboard focus', node('ta-tab-board').attributes['aria-selected'] === 'true' && node('ta-tab-schedule').tabIndex === -1 && node('ta-view-schedule').classes.has('hidden'));
    api.select('schedule'); const broken = api.runTradeSchedule(); const errors = responses.splice(0);
    complete(errors[0], {}, 500); complete(errors[1], snapshot([])); await broken;
    ok('failed reload cannot leave a successful total visible', node('ta-sum-time').textContent === '—' && node('ta-results-body').innerHTML.includes('Failed to load'));
    const refresh = api.loadTradeAgreements(); const boardCall = responses.shift();
    complete(boardCall, snapshot([])); await refresh; await tick();
    const refreshed = responses.splice(0);
    ok('refreshing Board data recalculates the visible Schedule', refreshed.length === 2);
    complete(refreshed[0], economics()); complete(refreshed[1], snapshot([])); await tick();
    ok('completed or removed confirmed pairs do not linger in the schedule', node('ta-results-body').innerHTML.includes('No confirmed agreements pending funding'));
    ok('sub-hour funding never rounds down to zero hours', api.formatTaHours(0.5) === '+30m' && api.formatTaHours(0.001) === '+1m');
    ok('unknown wealth stays unknown and a fractional cash gap is not ready now', api.fmtReady(null, 1) === '—' && api.fmtReady(0.4, 0.4) === '1.0h');
    api.setState({ members:[{name:'Alpha',reported_partners:null,known_partners:['beta','gamma']}], agreements:[] });
    ok('Board counts reverse observations and duplicate reservations only once', api.taCount('alpha',[{pair_key:'alpha|beta',status:'confirmed'},{pair_key:'alpha|delta',status:'proposed'}]) === 3);
    const observed = api.taCell({name:'Alpha'}, {name:'Beta'}, {agreements:[]});
    ok('reported completed pair renders a noninteractive completed cell', observed.includes('Completed agreement reported') && !observed.includes('data-ta-pair'));
    const wrapper = fs.readFileSync(path.join(__dirname, '../../public/Wrapper.html'),'utf8');
    ok('one sidebar entry owns all three tools', !wrapper.includes('open-road-to-ta-btn') && !source.includes('export async function openRoadToTaPanel'));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
