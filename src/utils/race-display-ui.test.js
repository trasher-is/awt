// Synthetic saved estimates and a tiny DOM. No live game, provider or paid call.
const fs = require('fs');
const path = require('path');
const Display = require('../../public/js/utils/race-estimate-display');
const Time = require('../../public/js/utils/sqlite-time');
const Inference = require('../../public/js/utils/race-inference');
const { truePower } = require('./true-power');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const version = Inference.modelVersion(), hash = 'a'.repeat(64);
const trait = value => ({ most_likely: value, band: 'high', model_version: version, evidence_hash: hash,
    evidence_count: 4, evidence_report_ids: [101, 202], hard_candidates: [value],
    estimated_at: '2026-10-10T12:00:00Z', prior: { name: 'uniform' }, withheld_reason: null,
    dist: Array.from({ length: 9 }, (_, i) => i === value + 4 ? 1 : 0) });
const envelope = {
    player: { id: 710, has_intel: 0, science_level: 10, level: 5 },
    model_version: version,
    estimate: { player_id: 710, attack: trait(2), defence: trait(-1) },
    gate: { allowed: true, players: 30, pairs: 30, high_pairs: 8, coverage_pairs: 30, credible_coverage: 0.9,
        calibration_error_pp: 1, high_accuracy: 0.95, model_version: version },
    check: { state: 'AI-checked', input_hash: hash, current_input_hash: hash,
        bands: { attack: 'high', defence: 'high' },
        attack: { verdict: 'agrees' }, defence: { verdict: 'agrees' }, model_version: version },
};
ok('calibrated race values retain the estimate label without claiming compatible picks have 90% coverage',
    /estimate ~\+2.*high band.*compatible range \+2/.test(Display.traitText(trait(2), { calibrated: true }))
    && !/90%/.test(Display.traitText(trait(2), { calibrated: true })));
ok('uncalibrated ranges state model compatibility without claiming probability coverage',
    /compatible range.*uncalibrated/.test(Display.traitText(trait(2))) && !/90% set/.test(Display.traitText(trait(2))));
ok('a disjoint credible set does not claim impossible intermediate picks', Display.setText([1, 4]) === '+1 or +4');
ok('malformed distributions and held traits fail closed', Display.traitText({ ...trait(2), hard_candidates: [7] }) === 'estimate unavailable'
    && Display.traitText({ ...trait(2), dist: [1] }) === 'estimate unavailable'
    && Display.traitText({ ...trait(2), withheld_reason: 'conflict' }) === 'estimate unavailable');
ok('a stale AI hash is always labelled outdated', Display.checkLabel({ ...envelope.check, current_input_hash: 'b'.repeat(64) }) === 'outdated');
ok('a current AI lower is displayed without ever raising the stored band',
    /medium band/.test(Display.traitText(trait(2), { calibrated: true, kind: 'attack',
        check: { ...envelope.check, bands: { attack: 'medium', defence: 'high' } } }))
    && Display.effectiveBand({ ...trait(2), band: 'low' }, envelope.check, 'attack') === 'low');
ok('an outdated AI lower cannot change the displayed evidence band',
    Display.effectiveBand(trait(2), { ...envelope.check, state: 'outdated', bands: { attack: 'low' } }, 'attack') === 'high');
ok('a current validated cannot-check verdict still lowers its display band without permitting calculation',
    Display.effectiveBand(trait(2), { ...envelope.check, state: 'cannot_check', status: 'current',
        attack: { verdict: 'cannot_check' }, bands: { attack: 'medium' } }, 'attack') === 'medium');
const inputs = { defFleet: [100, 0, 0], atkFleet: [100, 0, 0], sbLevel: 0,
    def: { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5 }, atk: { ra: 0, rd: 0, phys: 10, math: 10, lvl: 5 } };
let rows = Display.comparisonRows(inputs, { atk: { ...envelope, gate: { ...envelope.gate, allowed: false } } });
ok('before calibration comparisons contain no estimated numeric win chance', rows.find(row => row.source === 'estimate').values === null
    && !!rows.find(row => row.source === 'worst').values);
rows = Display.comparisonRows(inputs, { atk: envelope });
ok('a fully gated estimate produces a separately labelled range alongside worst case',
    !!rows.find(row => row.source === 'estimate').values && rows.find(row => row.source === 'estimate').label === 'Estimate'
    && rows.find(row => row.source === 'worst').label.includes('Worst case'));
rows = Display.comparisonRows(inputs, { atk: { ...envelope, check: { ...envelope.check, state: 'held' } } });
ok('a held estimate cannot produce comparison numbers', rows.find(row => row.source === 'estimate').values === null);
const broad = { ...envelope, estimate: { ...envelope.estimate,
    attack: { ...trait(2), hard_candidates: [-4, 2, 4], set90_values: [-4, 2, 4], set90_kind: 'conservative_compatibility' } } };
rows = Display.comparisonRows(inputs, { atk: broad });
ok('comparison ranges keep all compatible picks even when the posterior mass set is a singleton',
    Display.credibleSet(broad.estimate.attack).length === 1 && Display.compatibleSet(broad.estimate.attack).length === 3
    && rows.find(row => row.source === 'estimate').values.attacker.low < rows.find(row => row.source === 'estimate').values.attacker.high
    && !/90%/.test(rows.find(row => row.source === 'estimate').reason));
const sheetPlayer = { ...envelope.player, sheet_physics: 8, sheet_mathematics: 6, sheet_sciences_updated_at: '2026-10-10T12:00:00Z' };
let rating = truePower(sheetPlayer, {}, envelope);
ok('gated True Power estimates require observed sciences and retain source', typeof rating.tp === 'number' && rating.source === 'estimate', rating);
rating = truePower(envelope.player, {}, envelope);
ok('even a gated race estimate cannot manufacture physics for a numeric rating', rating.tp === null && rating.tpx === null, rating);
rating = truePower(sheetPlayer, {}, { ...envelope, check: { ...envelope.check, state: 'outdated' } });
ok('outdated checks preserve the unknown True Power rating', rating.tp === null && rating.tpx === null, rating);

class Node {
    constructor(tag, text = '') { this.tagName = tag; this._text = text; this.children = []; this.events = {}; this.attrs = {}; this.parent = null; this.connected = false; }
    get isConnected() { return this.connected || !!this.parent?.isConnected; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(node) { this.children.push(node); node.parent = this; return node; }
    replaceChildren(...nodes) { this.children = []; this._text = ''; nodes.forEach(node => this.appendChild(node)); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    addEventListener(type, callback) { this.events[type] = callback; }
    click() { if (!this.disabled && !this.hidden) this.events.click?.(); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const source = fs.readFileSync(path.join(__dirname, '../../public/js/ui/race-estimate-card.js'), 'utf8');
const load = new Function('document', 'fetch', 'globalThis', `${source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')};return mountRaceEstimateCard;`);
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(snapshot, { liveIntel = false } = {}) {
    const calls = [], replies = [response(snapshot)];
    const fetch = async (url, init = {}) => { calls.push({ url, ...init }); return replies.shift() || response({ success: true }); };
    const mount = load({ createElement: tag => new Node(tag), querySelectorAll: () => liveIntel ? [{ closest: () => null }] : [] }, fetch,
        { AWSqliteTime: Time, AWRaceEstimateDisplay: Display });
    const root = new Node('main'); root.connected = true;
    const controller = mount(root, { playerId: 710 });
    return { root, calls, replies, controller, mount };
}
(async () => {
    const admin = setup({ success: true, ...envelope, viewer_role: 'admin', check_request_allowed: true, llm_enabled: true,
        check: { ...envelope.check, explanation: 'Synthetic AI note.' },
        gate: { ...envelope.gate, allowed: false, players: 0, pairs: 0, reasons: ['Calibration is required.'] } });
    await admin.controller.ready;
    ok('mounting the admin card reads the stored endpoint without computation or paid calls',
        admin.calls.length === 1 && admin.calls[0].url === '/hub-api/intel/player/710/race-estimate'
        && !admin.calls[0].method);
    ok('the card shows labelled estimates, credible sets, prior, evidence and gate progress',
        /Attack: estimate ~\+2/.test(admin.root.textContent) && /Defence: estimate ~-1/.test(admin.root.textContent)
        && /compatible range/.test(admin.root.textContent) && /uncalibrated/.test(admin.root.textContent) && /prior: uniform/.test(admin.root.textContent)
        && /Evidence reports/.test(admin.root.textContent) && /0\/30/.test(admin.root.textContent));
    ok('AI-written prose has an explicit origin label', /AI-written explanation: Synthetic AI note\./.test(admin.root.textContent));
    ok('repeated mounting does not add cards or fetches', admin.mount(admin.root, { playerId: 710 }) === admin.controller
        && admin.root.children.length === 1 && admin.calls.length === 1);
    const paid = descendants(admin.root).find(node => node.tagName === 'button' && node.textContent === 'Run AI check (paid)');
    admin.replies.push(response({ request: { id: 41, status: 'done' }, check: { status: 'ok' } }));
    paid.click(); await flush();
    ok('only an explicit paid admin button calls the AI-check action', admin.calls.length === 2
        && admin.calls[1].url === '/hub-api/admin/race/710/check' && admin.calls[1].method === 'POST'
        && /AI check completed/.test(admin.root.textContent));
    const off = setup({ success: true, ...envelope, viewer_role: 'admin', check_request_allowed: true, llm_enabled: false });
    await off.controller.ready;
    const disabled = descendants(off.root).find(node => node.tagName === 'button' && node.textContent === 'Run AI check (paid)');
    ok('the paid admin action is disabled when the hub AI switch is off', disabled.disabled === true);
    disabled.events.click(); await flush();
    ok('the action handler also blocks disabled paid checks before any request', off.calls.length === 1);
    const member = setup({ success: true, ...envelope, viewer_role: 'user', check_request_allowed: true, llm_enabled: false });
    await member.controller.ready;
    const ask = descendants(member.root).find(node => node.tagName === 'button' && /Request AI check/.test(node.textContent));
    member.replies.push(response({ request: { id: 42, status: 'pending' } }));
    ask.click(); await flush();
    ok('members enqueue admin approval and accept its actual persisted request receipt',
        member.calls[1].url === '/hub-api/intel/race/710/check-request' && /AI check requested/.test(member.root.textContent));
    const shadow = setup({ success: true, player: envelope.player, estimate: null, viewer_role: 'user', check_request_allowed: false,
        gate: { ...envelope.gate, allowed: false, players: 0, pairs: 0 } });
    await shadow.controller.ready;
    ok('shadow estimates stay absent from member cards and no check control is available',
        !/estimate ~/.test(shadow.root.textContent) && /Worst case remains/.test(shadow.root.textContent)
        && descendants(shadow.root).filter(node => node.tagName === 'button').find(node => /Request AI check/.test(node.textContent)).hidden);
    const bio = setup({ success: true, ...envelope, viewer_role: 'admin', check_request_allowed: true }, { liveIntel: true });
    await bio.controller.ready;
    ok('visible Bio intel overrides stale saved estimates before profile sync catches up',
        /Observed intel is available/.test(bio.root.textContent) && !/estimate ~/.test(bio.root.textContent)
        && descendants(bio.root).find(node => node.tagName === 'button' && /Run AI check/.test(node.textContent)).hidden);
    const wrong = setup({ success: true, ...envelope, player: { ...envelope.player, id: 999 } });
    await wrong.controller.ready;
    ok('a response for a different player cannot appear on this profile',
        /invalid estimate/.test(wrong.root.textContent) && !/estimate ~/.test(wrong.root.textContent));
    ok('no card contains a request to a game API or a write until a user clicks',
        [admin, member, shadow].every(state => state.calls.every(call => call.url.startsWith('/hub-api/')))
        && shadow.calls.length === 1);
    console.log(`race-display-ui.test.js: ${failed} failures`);
    process.exitCode = failed ? 1 : 0;
})();
