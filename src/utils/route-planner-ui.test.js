// Execute the actual browser controller against a small synthetic DOM/fetch harness.
// These regressions concern request ordering and saved UTC anchors, not HTML styling.
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
    return {
        value: '', checked: false, disabled: false, validity: { valid: true },
        get innerHTML() { return html; }, set innerHTML(value) { html = value; },
        get textContent() { return html.replace(/<[^>]*>/g, ''); }, set textContent(value) { html = value; },
        classList: {
            add: name => classes.add(name), remove: name => classes.delete(name),
            contains: name => classes.has(name)
        },
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener() {}
    };
}

function harness() {
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const requests = [];
    let timerId = 0;
    const timers = new Map();
    const context = vm.createContext({
        console, Date,
        document: { getElementById: get, querySelectorAll: () => [] },
        window: {},
        esc: value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
        AWRequestSeq: require('../../public/js/utils/request-sequence'),
        AWFreshCache: require('../../public/js/utils/fresh-cache'),
        AWRouteScheduleInput: require('../../public/js/utils/route-schedule-input'),
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            return new Promise(resolve => requests.push({
                url, options,
                resolve: data => resolve({ ok: true, json: async () => data })
            }));
        }
    });
    const code = fs.readFileSync(path.join(__dirname, '../../public/js/ui/route-planner.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^export /gm, '');
    vm.runInContext(code, context);
    vm.runInContext('collectWaypoints = () => [{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 1 }];', context);
    return { get, requests, run: code => vm.runInContext(code, context), timers };
}

function schedule(departsAt, arrivesAt) {
    return {
        totalSeconds: 3600, totalTime: '01:00:00', departsAt, arrivesAt,
        legs: [{
            from: { systemId: 1, systemName: 'Synthetic A', planetIndex: 1 },
            to: { systemId: 2, systemName: 'Synthetic B', planetIndex: 1 },
            travelTime: '01:00:00', travelSeconds: 3600,
            departsAt, arrivesAt, distance: 1, bioNeeded: 0
        }]
    };
}

async function main() {
    console.log('route-planner-ui.test.js');
    const originalTz = process.env.TZ;
    try {
        process.env.TZ = 'Europe/Warsaw';
        const h = harness();
        h.run("scheduleInput.setMode('arrival')");
        h.get('rp-start').value = '2026-09-09T18:00:23';
        const firstPreview = h.run('preview()');
        const body = JSON.parse(h.requests[0].options.body);
        ok('preview sends the active arrival anchor with seconds and a null start', body.targetArrivalAt === '2026-09-09T16:00:23.000Z' && body.plannedStartAt === null, body);

        // The input changes while the first fetch is still pending, before debounce fires.
        h.get('rp-start').value = '2026-03-29T02:30';
        h.run('scheduleInput.edit(); schedulePreview()');
        h.requests[0].resolve(schedule('2026-09-09T15:00:23Z', '2026-09-09T16:00:23Z'));
        await firstPreview;
        ok('an old response cannot repaint the departure during the input debounce', h.get('rp-departure').textContent === '');
        const count = h.requests.length;
        await h.run('preview()');
        ok('a nonexistent DST time never reaches the preview API', h.requests.length === count);
        ok('an invalid time clears all scheduled results and displays its error', h.get('rp-error').textContent.includes('does not exist') && h.get('rp-legs').innerHTML === '' && h.get('rp-arrival').textContent === '');

        h.get('rp-start').value = '';
        h.get('rp-start').validity.valid = false;
        await h.run('preview()');
        ok('a partially entered native date is invalid rather than treated as unscheduled', h.requests.length === count && h.get('rp-error').textContent.includes('valid local date'));
        h.get('rp-start').validity.valid = true;

        h.get('rp-start').value = '2000-01-01T18:00:23';
        const pastPreview = h.run('preview()');
        h.requests.at(-1).resolve(schedule('2000-01-01T16:00:23Z', '2000-01-01T17:00:23Z'));
        await pastPreview;
        ok('arrival preview prominently shows a required start with seconds', /Required start/.test(h.get('rp-departure').textContent) && /17:00:23/.test(h.get('rp-departure').textContent));
        ok('past departure is warned about without hiding its schedule', !h.get('rp-start-warning').classList.contains('hidden') && h.get('rp-start-warning').textContent.includes('past') && h.get('rp-arrival').textContent.includes('18:00:23'));

        const savedArrival = '2026-10-25T01:30:23.456Z';
        const saved = {
            id: 12, title: 'Synthetic arrival route', targetArrivalAt: savedArrival,
            plannedStartAt: null, ...schedule('2026-10-25T00:30:23.456Z', savedArrival)
        };
        saved.legs[0].isAllianceMove = true;
        const beforeOpen = h.requests.length;
        h.run(`loadIntoForm(${JSON.stringify(saved)})`);
        ok('opening a saved route restores arrival mode and input seconds', h.get('rp-schedule-mode').value === 'arrival' && h.get('rp-start').value === '2026-10-25T02:30:23');
        ok('opening renders the saved schedule snapshot without recalculating it', h.requests.length === beforeOpen && h.get('rp-total').textContent === saved.totalTime && h.get('rp-departure').innerHTML.includes('10-25 00:30:23Z'));
        ok('saved allied modifier does not invent a manual override', h.get('rp-legs').innerHTML.includes('Saved alliance/own-destination travel modifier') && !h.get('rp-legs').textContent.includes('allied (forced)'));

        h.get('rp-energy').value = '10';
        h.run('schedulePreview()');
        const editedPreview = [...h.timers.values()].at(-1)();
        const editedRequest = h.requests.at(-1);
        ok('editing fleet parameters requests a fresh preview with the original UTC anchor', h.requests.length === beforeOpen + 1 && JSON.parse(editedRequest.options.body).targetArrivalAt === savedArrival && JSON.parse(editedRequest.options.body).energy === 10);
        editedRequest.resolve(schedule('2026-10-25T00:45:23.456Z', savedArrival));
        await editedPreview;
        ok('fresh preview updates the displayed departure after an edit', h.get('rp-departure').innerHTML.includes('10-25 00:45:23Z'));

        const saving = h.run('save()');
        const saveRequest = h.requests.at(-1);
        const savedBody = JSON.parse(saveRequest.options.body);
        ok('save keeps the exact loaded UTC arrival and uses the existing route', saveRequest.url === '/hub-api/routes/12' && saveRequest.options.method === 'PUT' && savedBody.targetArrivalAt === savedArrival && savedBody.plannedStartAt === null);
        saveRequest.resolve({ id: 12 });
        // save refreshes the shared list after persisting.
        for (let i = 0; i < 8 && h.requests.at(-1) === saveRequest; i++) await Promise.resolve();
        h.requests.at(-1).resolve({ routes: [{ ...saved, ...schedule('2026-10-25T00:50:23.456Z', savedArrival) }] });
        await saving;
        ok('save renders the persisted snapshot if server calculation changed since preview', h.get('rp-departure').innerHTML.includes('10-25 00:50:23Z'));

        const savingAgain = h.run('save()');
        const secondSaveRequest = h.requests.at(-1);
        h.get('rp-energy').value = '12';
        h.run('schedulePreview()');
        secondSaveRequest.resolve({ id: 12 });
        for (let i = 0; i < 8 && h.requests.at(-1) === secondSaveRequest; i++) await Promise.resolve();
        h.requests.at(-1).resolve({ routes: [{ ...saved, ...schedule('2026-10-25T00:55:23.456Z', savedArrival) }] });
        await savingAgain;
        ok('a save response does not paint its old schedule over edits made during the request', h.get('rp-departure').textContent === '' && h.run('currentPayload().energy') === 12);

        const savingBeforeInvalidEdit = h.run('save()');
        const thirdSaveRequest = h.requests.at(-1);
        h.get('rp-start').validity.valid = false;
        await h.run('preview()');
        thirdSaveRequest.resolve({ id: 12 });
        for (let i = 0; i < 8 && h.requests.at(-1) === thirdSaveRequest; i++) await Promise.resolve();
        h.requests.at(-1).resolve({ routes: [saved] });
        await savingBeforeInvalidEdit;
        ok('an invalid date entered during save preserves its error without reporting a failed save', h.get('rp-save-msg').textContent === 'Saved.' && h.get('rp-error').textContent.includes('valid local date') && h.get('rp-departure').textContent === '');
        h.get('rp-start').validity.valid = true;

        h.run('resetForm()');
        ok('New resets arrival mode and both timing anchors', h.get('rp-schedule-mode').value === 'start' && h.get('rp-start').value === '' && h.run('currentPayload().targetArrivalAt') === null && h.run('currentPayload().plannedStartAt') === null);
        h.requests.at(-1).resolve(schedule(null, null));
    } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
