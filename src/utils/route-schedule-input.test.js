// The saved UTC instant must survive a datetime-local round trip, including the second
// occurrence of an autumn clock change. Fixtures are synthetic; no game data is used.
const { localInputToIso, isoToLocalInput, createScheduleInput } = require('../../public/js/utils/route-schedule-input');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
function rejects(value) {
    try { localInputToIso(value); return false; } catch { return true; }
}

console.log('route-schedule-input.test.js');
const originalTz = process.env.TZ;
try {
    process.env.TZ = 'UTC';
    ok('blank date means no schedule', localInputToIso('') === null);
    ok('seconds are preserved when interpreting local input', localInputToIso('2026-09-09T15:46:23') === '2026-09-09T15:46:23.000Z');
    ok('minute-only browser values are accepted', localInputToIso('2026-09-09T18:00') === '2026-09-09T18:00:00.000Z');
    ok('valid leap day is accepted', localInputToIso('2028-02-29T12:00') === '2028-02-29T12:00:00.000Z');
    for (const value of ['not a date', '2026-02-29T12:00', '2026-04-31T12:00', '2026-09-09T24:00', '2026-09-09T18:00Z']) {
        ok(`invalid or zoned local input is rejected: ${value}`, rejects(value));
    }

    const input = createScheduleInput();
    ok('new planner defaults to planned start', input.mode === 'start');
    ok('blank planned start sends both anchors as null', JSON.stringify(input.fields('')) === '{"plannedStartAt":null,"targetArrivalAt":null}');
    let fields = input.fields('2026-09-09T15:46:23');
    ok('start mode sends only plannedStartAt', fields.plannedStartAt === '2026-09-09T15:46:23.000Z' && fields.targetArrivalAt === null);
    input.setMode('arrival');
    fields = input.fields('2026-09-09T18:00');
    ok('arrival mode sends only targetArrivalAt', fields.plannedStartAt === null && fields.targetArrivalAt === '2026-09-09T18:00:00.000Z');
    ok('arrival can also be unscheduled', input.fields('').targetArrivalAt === null);

    process.env.TZ = 'Europe/Warsaw';
    ok('Warsaw spring DST gap is rejected instead of normalized to 03:30', rejects('2026-03-29T02:30'));
    ok('valid time after the gap is converted to UTC', localInputToIso('2026-03-29T03:30:23') === '2026-03-29T01:30:23.000Z');
    const arrival = '2026-10-25T01:30:23.456Z';
    const loaded = input.load({ plannedStartAt: null, targetArrivalAt: arrival });
    ok('saved arrival restores its mode and local seconds', loaded.mode === 'arrival' && loaded.value === '2026-10-25T02:30:23', loaded);
    ok('unchanged autumn arrival preserves its second occurrence and milliseconds', input.fields(loaded.value).targetArrivalAt === arrival);
    ok('repeated preview/save reads retain the exact anchor', input.fields(loaded.value).targetArrivalAt === arrival);
    input.edit();
    ok('an actual date edit interprets the newly entered local time', input.fields('2026-10-25T03:30:24').targetArrivalAt === '2026-10-25T02:30:24.000Z');
    const minuteAnchor = '2026-10-25T01:30:00.000Z';
    input.load({ targetArrivalAt: minuteAnchor });
    ok('browser omission of :00 does not move a saved repeated hour', input.fields('2026-10-25T02:30').targetArrivalAt === minuteAnchor);
    input.setMode('start');
    fields = input.fields('');
    ok('switching modes discards the old anchor', fields.targetArrivalAt === null && fields.plannedStartAt === null);
    const start = input.load({ plannedStartAt: '2026-10-25T01:30:23.000Z' });
    ok('legacy planned starts preserve the second occurrence too', start.mode === 'start' && input.fields(start.value).plannedStartAt === '2026-10-25T01:30:23.000Z');
    const reset = input.load({ plannedStartAt: null, targetArrivalAt: null });
    ok('loading an unscheduled route resets mode, input and canonical anchor', reset.mode === 'start' && reset.value === '' && input.fields('').plannedStartAt === null);
    ok('formatting an ordinary ISO instant keeps local seconds', isoToLocalInput('2026-09-09T13:46:23Z') === '2026-09-09T15:46:23');

    process.env.TZ = 'America/New_York';
    ok('New York spring DST gap is rejected too', rejects('2026-03-08T02:30'));
    const us = input.load({ targetArrivalAt: '2026-11-01T06:30:23.000Z' });
    ok('saved New York repeated hour keeps its original instant', us.value === '2026-11-01T01:30:23' && input.fields(us.value).targetArrivalAt === '2026-11-01T06:30:23.000Z');
} finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
