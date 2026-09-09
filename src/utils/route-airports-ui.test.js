// Friendly airport choices use the actual controller, synthetic recorded intel and a
// deterministic DOM/fetch harness. In-flight responses must never modify a newer route.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}

function element() {
    let html = '';
    const classes = new Set();
    const listeners = new Map();
    const node = {
        value: '', checked: false, disabled: false, dataset: {}, validity: { valid: true }, buttons: [],
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value;
            node.buttons = [...value.matchAll(/data-airport-index="(\d+)"/g)].map(match => {
                const button = element();
                button.dataset.airportIndex = match[1];
                return button;
            });
        },
        get textContent() { return html.replace(/<[^>]*>/g, ''); },
        set textContent(value) { html = value; node.buttons = []; },
        classList: {
            add: name => classes.add(name), remove: name => classes.delete(name),
            contains: name => classes.has(name)
        },
        querySelectorAll: selector => selector === '.rp-use-airport' ? node.buttons : [],
        querySelector: () => null,
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        async fire(name) {
            await Promise.all((listeners.get(name) || []).map(callback => callback({ currentTarget: node, preventDefault() {} })));
        }
    };
    return node;
}

function harness() {
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const requests = [], timers = new Map();
    const testStops = [
        { systemId: 1, planetIndex: 1, label: 'Origin #1' },
        { systemId: 2, planetIndex: 2, label: 'Existing jump #2' },
        { systemId: 3, planetIndex: 3, label: 'Target #3' }
    ];
    let timerId = 0;
    const context = vm.createContext({
        console, Date, testStops,
        document: { getElementById: get, querySelectorAll: () => [] }, window: {},
        esc: value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
        AWRequestSeq: require('../../public/js/utils/request-sequence'),
        AWFreshCache: require('../../public/js/utils/fresh-cache'),
        AWRouteScheduleInput: require('../../public/js/utils/route-schedule-input'),
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            return new Promise((resolve, reject) => requests.push({
                url, options, reject,
                resolve: (data, status = 200) => resolve({ ok: status === 200, status, json: async () => data })
            }));
        }
    });
    const code = fs.readFileSync(path.join(__dirname, '../../public/js/ui/route-planner.js'), 'utf8')
        .replace(/^import .*$/gm, '').replace(/^export /gm, '');
    vm.runInContext(code, context);
    vm.runInContext(`
        collectWaypoints = () => testStops.map(stop => ({ ...stop }));
        renderWaypoints = values => testStops.splice(0, testStops.length, ...(values || collectWaypoints()).map(stop => ({ ...stop })));
    `, context);
    get('rp-energy').value = '7';
    get('rp-speed').value = '1';
    get('rp-biology').value = '9';
    get('rp-title').value = 'Synthetic plan';
    get('rp-note').value = 'Synthetic note';
    get('rp-shared').checked = true;
    return { get, requests, timers, testStops, run: code => vm.runInContext(code, context), context };
}

const target = '2026-10-25T01:30:23.456Z';
const airport = {
    waypoint: { systemId: 4, planetIndex: 5, systemName: 'Synthetic Airport' },
    insertAfterIndex: 1, savedSeconds: 600, totalSeconds: 3000, totalTime: '00:50:00',
    departsAt: '2026-10-25T00:40:23.456Z', arrivesAt: target,
    ownerName: 'Synthetic owner', allianceTag: 'SYN', starbase: 0,
    lastSeenAt: '2026-09-09T13:46:23.000Z', isInVision: true
};
const result = suggestions => ({
    success: true,
    current: { totalSeconds: 3600, totalTime: '01:00:00', departsAt: '2026-10-25T00:30:23.456Z', arrivesAt: target },
    suggestions, limitReached: false
});

async function search(h, suggestions = [airport]) {
    const pending = h.run('findAirports()');
    h.requests.at(-1).resolve(result(suggestions));
    await pending;
    return h.get('rp-airport-list').buttons;
}

async function main() {
    console.log('route-airports-ui.test.js');
    const originalTz = process.env.TZ;
    try {
        process.env.TZ = 'Europe/Warsaw';
        const h = harness();
        const loaded = h.run(`scheduleInput.load({ targetArrivalAt: '${target}' })`);
        h.get('rp-start').value = loaded.value;
        const before = h.run('currentPayload()');
        const buttons = await search(h, [airport, { ...airport, savedSeconds: -120, totalSeconds: 3720, totalTime: '01:02:00' }, { ...airport, savedSeconds: 0, outOfReach: true, bioNeeded: 13 }]);
        const request = h.requests[0];
        ok('airport search is an explicit hub API POST with the complete route payload', request.url === '/hub-api/routes/airports' && request.options.method === 'POST' && request.options.body === JSON.stringify(before));
        ok('search retains the exact saved autumn arrival instant', JSON.parse(request.options.body).targetArrivalAt === target);
        const text = h.get('rp-airport-list').textContent;
        ok('candidates compare savings, slower options and ties against the current route', text.includes('Saves 00:10:00 vs current route') && text.includes('00:02:00 slower than current route') && text.includes('Same travel time as current route'));
        ok('candidate totals and the current total are visible', text.includes('Total travel time 00:50:00') && h.get('rp-airport-status').textContent.includes('Current route: 01:00:00'));
        ok('candidates show owner, alliance, recorded SB0 and vision', text.includes('Synthetic owner [SYN]') && text.includes('Friendly airport (SB 0)') && text.includes('Within recorded vision'));
        ok('canonical sync time is shown as local 24-hour time with seconds', text.includes('Last synced') && text.includes('15:46:23') && h.get('rp-airport-list').innerHTML.includes('09-09 13:46:23Z'));
        ok('target mode shows the computed departure and insertion position', text.includes('Required start') && text.includes('02:40:23') && text.includes('Insert after Jump 1'));
        ok('recorded ownership is explicitly conditional on future changes', h.get('rp-airport-status').textContent.includes('Conditions may change'));
        ok('airport biology requirements are shown without blocking manual selection', text.includes('Needs biology 13') && buttons.length === 3 && !buttons[2].disabled);

        await buttons[0].fire('click');
        const after = h.run('currentPayload()');
        ok('Use airport inserts at the supplied index and preserves the existing stops', JSON.stringify(after.waypoints) === JSON.stringify([{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 2 }, { systemId: 4, planetIndex: 5 }, { systemId: 3, planetIndex: 3 }]));
        ok('applying an airport preserves the exact anchor and every other route field', Object.keys(before).filter(key => key !== 'waypoints').every(key => JSON.stringify(before[key]) === JSON.stringify(after[key])));
        ok('applying a candidate clears all suggestions', h.get('rp-airport-results').classList.contains('hidden') && h.get('rp-airport-list').buttons.length === 0);
        const preview = [...h.timers.values()].at(-1)();
        ok('applying requests a normal preview rather than trusting suggested leg data', h.requests.at(-1).url === '/hub-api/routes/preview' && JSON.parse(h.requests.at(-1).options.body).waypoints.length === 4);
        h.requests.at(-1).resolve({ totalTime: '00:50:00', legs: [], departsAt: airport.departsAt, arrivesAt: target });
        await preview;
        await buttons[0].fire('click');
        ok('a previously used suggestion cannot be applied twice', h.testStops.length === 4);

        const stale = harness();
        const staleButtons = await search(stale);
        stale.get('rp-energy').value = '8'; // Even a value change that emitted no event.
        await staleButtons[0].fire('click');
        ok('application compares the full payload and rejects a changed route', stale.testStops.length === 3 && stale.get('rp-airport-results').classList.contains('hidden'));

        const racing = harness();
        const old = racing.run('findAirports()');
        const oldRequest = racing.requests.at(-1);
        racing.get('rp-biology').value = '10';
        racing.run('schedulePreview()');
        ok('input edits immediately clear airport results and release its button', racing.get('rp-airport-results').classList.contains('hidden') && !racing.get('rp-find-airport').disabled);
        const latest = racing.run('findAirports()');
        racing.requests.at(-1).resolve(result([{ ...airport, waypoint: { ...airport.waypoint, systemName: 'Latest airport' } }]));
        await latest;
        oldRequest.resolve(result([{ ...airport, waypoint: { ...airport.waypoint, systemName: 'Stale airport' } }]));
        await old;
        ok('an older airport response cannot replace the latest suggestions', racing.get('rp-airport-list').textContent.includes('Latest airport') && !racing.get('rp-airport-list').textContent.includes('Stale airport'));
        const closing = racing.run('findAirports()');
        const closingRequest = racing.requests.at(-1);
        racing.run('cancelPendingWork()');
        closingRequest.reject(new Error('Stale failure'));
        await closing;
        ok('closing cancels even a pending airport error', racing.get('rp-airport-results').classList.contains('hidden') && racing.get('rp-airport-status').textContent === '');

        const typed = harness();
        await search(typed);
        const fields = new Map(['.rp-sys-input', '.rp-sys-id', '.rp-sys-drop', '.rp-planet', '.rp-remove'].map(selector => [selector, element()]));
        const row = { querySelector: selector => fields.get(selector), dataset: { index: '0' } };
        typed.context.syntheticRow = row;
        typed.run('wireWaypointRow(syntheticRow)');
        fields.get('.rp-sys-input').value = 'New system';
        const typing = fields.get('.rp-sys-input').fire('input');
        ok('typing a nonempty system name clears airports before lookup completes', typed.get('rp-airport-results').classList.contains('hidden') && fields.get('.rp-sys-id').value === '');
        typed.requests.at(-1).resolve({ success: true, systems: [] });
        await typing;

        const empty = harness();
        await search(empty, []);
        ok('empty suggestions explain recorded eligibility and keep manual stops available', empty.get('rp-airport-status').textContent.includes('SB 0') && empty.get('rp-airport-status').textContent.includes('manually') && !empty.get('rp-find-airport').disabled);
        empty.testStops.push(...[4, 5, 6, 7].map(systemId => ({ systemId, planetIndex: 1 })));
        const count = empty.requests.length;
        await empty.run('findAirports()');
        ok('six-leg routes show the limit without requesting or adding an airport', empty.requests.length === count && empty.get('rp-airport-status').textContent.includes('6 legs'));
        empty.testStops.splice(1);
        empty.testStops.push({ systemId: null, planetIndex: 1 });
        await empty.run('findAirports()');
        ok('incomplete routes do not search for airports', empty.requests.length === count && empty.get('rp-airport-status').textContent.includes('Pick a system'));

        const warnings = harness();
        for (const [status, label] of [
            ['friendly-no-starbase', 'Friendly airport (SB 0)'],
            ['starbase-present', 'Caution: starbase present (SB 7)'],
            ['not-friendly', 'Caution: jump point is not known friendly'],
            ['unknown-intel', 'Caution: airport eligibility is unknown'],
            ['sieged', 'Caution: jump point is under siege']
        ]) {
            const rendered = warnings.run(`renderJumpPoint(${JSON.stringify({ ...airport, starbase: status === 'starbase-present' ? 7 : 0, status })})`);
            ok(`manual intermediate stop shows ${status} as recorded intel`, rendered.includes(label) && rendered.includes('Based on recorded intel'));
        }
        const unknown = warnings.run("recordedIntel({ ownerName: null, allianceTag: null, lastSeenAt: null, isInVision: null })");
        ok('missing sync and vision information are not presented as current visibility', unknown.includes('Sync time unknown') && unknown.includes('Vision unknown'));
        const finalLeg = warnings.run(`renderLeg(${JSON.stringify({ from: { systemName: 'Airport', planetIndex: 1 }, to: { systemName: 'Hostile target', planetIndex: 2 }, travelTime: '01:00:00', distance: 2, bioNeeded: 0, isAllianceMove: false })})`);
        ok('a hostile final leg gains neither an airport label nor an allied modifier in the UI', !finalLeg.includes('Friendly airport') && !finalLeg.includes('fa-handshake'));

        await search(warnings);
        warnings.run('resetForm()');
        ok('New clears airport results', warnings.get('rp-airport-results').classList.contains('hidden'));
        warnings.requests.at(-1).resolve({ totalTime: '00:00:00', legs: [], departsAt: null, arrivesAt: null });
        warnings.testStops[0].systemId = 1;
        warnings.testStops[1].systemId = 2;
        await search(warnings);
        warnings.run('loadIntoForm({ id: 9, legs: [], totalTime: "00:00:00", targetArrivalAt: null, plannedStartAt: null })');
        ok('opening another saved route clears airport results', warnings.get('rp-airport-results').classList.contains('hidden'));

        const handoff = harness();
        handoff.run(`editingId = 27; scheduleInput.load({ targetArrivalAt: '${target}' }); wirePlayerSearch()`);
        handoff.get('rp-schedule-mode').value = 'arrival';
        handoff.get('rp-start').value = '2026-10-25T02:30:23';
        handoff.get('rp-player-input').value = 'Old player';
        const oldPlayerSearch = handoff.get('rp-player-input').fire('input');
        const oldPlayerRequest = handoff.requests.at(-1);
        const draft = {
            waypoints: [{ systemId: 21, planetIndex: 4, label: 'Draft origin #21' }, { systemId: 22, planetIndex: 6, label: 'Draft target #22' }],
            energy: 12, raceSpeed: -2, isAllianceMove: true
        };
        const countBeforeDraft = handoff.requests.length;
        const draftPreview = handoff.run(`loadRouteDraft(${JSON.stringify(draft)})`);
        const draftRequest = handoff.requests.at(-1);
        const draftBody = JSON.parse(draftRequest.options.body);
        ok('Travel Calculator handoff starts a new route and seeds both waypoint labels and planets', handoff.run('editingId') === null && JSON.stringify(handoff.testStops) === JSON.stringify(draft.waypoints));
        ok('handoff clears both saved anchors and defaults to planned-start mode', draftBody.plannedStartAt === null && draftBody.targetArrivalAt === null && handoff.get('rp-schedule-mode').value === 'start' && handoff.get('rp-start').value === '');
        ok('handoff copies fleet settings but resets biology and old route metadata', draftBody.energy === 12 && draftBody.raceSpeed === -2 && draftBody.isAllianceMove === true && draftBody.biology === 0 && draftBody.title === '' && draftBody.note === '');
        ok('handoff only previews the new flight and never writes a saved route', handoff.requests.length === countBeforeDraft + 1 && draftRequest.url === '/hub-api/routes/preview' && draftRequest.options.method === 'POST');
        oldPlayerRequest.resolve({ success: true, players: [{ name: 'Old player match', energy: 99 }] });
        await oldPlayerSearch;
        ok('handoff clears and invalidates pending player-search results', handoff.get('rp-player-input').value === '' && handoff.get('rp-player-dropdown').classList.contains('hidden') && handoff.get('rp-player-dropdown').textContent === '');
        draftRequest.resolve({ totalTime: '01:23:45', legs: [], departsAt: null, arrivesAt: null });
        await draftPreview;
        ok('handoff renders the fresh preview after seeding the route', handoff.get('rp-total').textContent === '01:23:45');
    } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
