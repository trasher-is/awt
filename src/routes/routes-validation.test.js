// Route input is validated before anything is calculated or written.
//
// Run with:  node src/routes/routes-validation.test.js
//
// Confirmed against the real router on a synthetic database (issue #130):
// POST /hub-api/routes/preview with {"waypoints":[null,{}]} answered HTTP 500 with a
// TypeError (reading systemId) — the length of the array was checked, the shape of its
// elements was not. parseInt also took "12abc" as 12, and the planet index had no
// server-side ceiling although the panel declares max=12 and the game has 12 slots.
//
// The route handlers are driven over HTTP, as the panel drives them, with a mock session.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-routes-validation-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const systemsRepo = require('../repositories/systems');
const { hubBody } = require('../utils/hub-body');
const { calcTravelSeconds } = require('../utils/travel-calc');
const routesRouter = require('./routes');
const { validateRouteInput, strictInt, MAX_PLANET_INDEX } = routesRouter;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

usersRepo.createUser('Navigator', 'not-a-real-hash', 'user', null);
const me = usersRepo.getUserByGameName('Navigator');

const app = express();
app.use('/hub-api', hubBody({ syncLimit: '1mb', limit: '256kb' }));
app.use((req, res, next) => { req.session = { userId: me.id, gameName: 'Navigator', role: 'user' }; next(); });
app.use('/hub-api', routesRouter);

let port;
function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
        const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* */ } resolve({ status: res.statusCode, body: b, raw }); });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}
const preview = body => request('POST', '/hub-api/routes/preview', body);
const count = table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

// A rejected request answers 400 with a JSON body that names the field, and never a 500.
function rejected(r, field) {
    return r.status === 400 && r.body && typeof r.body.error === 'string' && r.body.error.length > 0
        && (field === undefined || r.body.field === field);
}

// Two systems five units apart, one with no coordinates yet.
systemsRepo.upsertSystemFull(1, 'Alpha', 0, 0);
systemsRepo.upsertSystemFull(2, 'Beta', 3, 4);
systemsRepo.upsertSystemStub(3);

const good = () => ({
    waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 2 }],
    energy: 10, raceSpeed: 2, biology: 5, isAllianceMove: false,
    plannedStartAt: null, title: 'Alpha to Beta', note: null, visibility: 'alliance',
});
const expectedSeconds = calcTravelSeconds(0, 0, 1, 3, 4, 2, 10, 2, false);

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    port = server.address().port;

    try {
        console.log('── The reproduction from the issue ' + '─'.repeat(40));
        let r = await preview({ waypoints: [null, {}] });
        ok('[null, {}] is a 400, not a 500', rejected(r, 'waypoints[0]'), [r.status, r.body || r.raw.slice(0, 80)]);
        ok('and the body is JSON with a plain-language error', r.body && /Stop 1/.test(r.body.error), r.body);
        r = await preview({ waypoints: [{ systemId: 1 }, {}] });
        ok('an empty object as a stop is rejected on its missing system id', rejected(r, 'waypoints[1].systemId'), r.body);
        r = await preview({ waypoints: [{ systemId: 1 }, 'Beta'] });
        ok('a string as a stop is rejected', rejected(r, 'waypoints[1]'), r.body);
        r = await preview({ waypoints: [[1, 1], [2, 2]] });
        ok('an array as a stop is rejected', rejected(r, 'waypoints[0]'), r.body);

        console.log('\n── Waypoint shape ' + '─'.repeat(57));
        r = await preview({});
        ok('no waypoints at all', rejected(r, 'waypoints'), r.body);
        r = await preview({ waypoints: { systemId: 1 } });
        ok('waypoints that are not an array', rejected(r, 'waypoints'), r.body);
        r = await preview({ waypoints: [{ systemId: 1 }] });
        ok('a single stop', rejected(r, 'waypoints'), r.body);
        r = await preview({ waypoints: Array.from({ length: 8 }, () => ({ systemId: 1 })) });
        ok('more than 6 legs', rejected(r, 'waypoints') && /at most 6 legs/.test(r.body.error), r.body);
        r = await preview({ waypoints: [{ systemId: 1 }, { systemId: 99 }] });
        ok('an unknown system is a 400 naming the stop', rejected(r, 'waypoints[1].systemId') && /#99/.test(r.body.error), r.body);
        r = await preview({ waypoints: [{ systemId: 1 }, { systemId: 3 }] });
        ok('a system with no coordinates yet is a 400 naming the stop', rejected(r, 'waypoints[1].systemId') && /coordinates/.test(r.body.error), r.body);
        r = await preview(Object.assign(good(), { waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 2 }, { systemId: 3 }] }));
        ok('in a longer route the offending stop is the one named', rejected(r, 'waypoints[2].systemId'), r.body);

        console.log('\n── Numbers must be whole numbers, all the way to the end of the string ' + '─'.repeat(4));
        r = await preview({ waypoints: [{ systemId: '2abc' }, { systemId: 1 }] });
        ok('"2abc" is not a system id (parseInt used to say 2)', rejected(r, 'waypoints[0].systemId'), r.body);
        r = await preview({ waypoints: [{ systemId: 1.5 }, { systemId: 2 }] });
        ok('1.5 is not a system id', rejected(r, 'waypoints[0].systemId'), r.body);
        r = await preview({ waypoints: [{ systemId: -1 }, { systemId: 2 }] });
        ok('-1 is not a system id', rejected(r, 'waypoints[0].systemId'), r.body);
        r = await preview({ waypoints: [{ systemId: true }, { systemId: 2 }] });
        ok('true is not a system id', rejected(r, 'waypoints[0].systemId'), r.body);
        r = await preview(Object.assign(good(), { energy: '5x' }));
        ok('"5x" is not an energy level', rejected(r, 'energy'), r.body);
        r = await preview(Object.assign(good(), { energy: -1 }));
        ok('a negative energy level is rejected', rejected(r, 'energy'), r.body);
        r = await preview(Object.assign(good(), { energy: 2.5 }));
        ok('a fractional energy level is rejected', rejected(r, 'energy'), r.body);
        r = await preview(Object.assign(good(), { biology: '7 bio' }));
        ok('"7 bio" is not a biology level', rejected(r, 'biology'), r.body);
        r = await preview(Object.assign(good(), { biology: -3 }));
        ok('a negative biology level is rejected', rejected(r, 'biology'), r.body);
        r = await preview(Object.assign(good(), { raceSpeed: 'fast' }));
        ok('"fast" is not a race speed', rejected(r, 'raceSpeed'), r.body);
        r = await preview(Object.assign(good(), { raceSpeed: '1e3' }));
        ok('"1e3" is not a race speed either (Number() would say 1000)', rejected(r, 'raceSpeed'), r.body);

        console.log('\n── Documented ranges, not invented ones ' + '─'.repeat(36));
        for (const bad of [0, 13, -2, '0', '13']) {
            r = await preview(Object.assign(good(), { waypoints: [{ systemId: 1, planetIndex: bad }, { systemId: 2, planetIndex: 1 }] }));
            ok(`planet index ${JSON.stringify(bad)} is outside 1..${MAX_PLANET_INDEX}`, rejected(r, 'waypoints[0].planetIndex'), r.body);
        }
        for (const edge of [1, MAX_PLANET_INDEX, String(MAX_PLANET_INDEX)]) {
            r = await preview(Object.assign(good(), { waypoints: [{ systemId: 1, planetIndex: edge }, { systemId: 2, planetIndex: 1 }] }));
            ok(`planet index ${JSON.stringify(edge)} is accepted`, r.status === 200 && r.body.legs[0].from.planetIndex === Number(edge), r.body);
        }
        r = await preview(Object.assign(good(), { waypoints: [{ systemId: 1 }, { systemId: 2, planetIndex: '' }] }));
        ok('an absent planet index still defaults to 1, as the panel has always relied on',
            r.status === 200 && r.body.legs[0].from.planetIndex === 1 && r.body.legs[0].to.planetIndex === 1, r.body);
        for (const bad of [5, -5, '+5']) {
            r = await preview(Object.assign(good(), { raceSpeed: bad }));
            ok(`race speed ${JSON.stringify(bad)} is outside -4..+4`, rejected(r, 'raceSpeed'), r.body);
        }
        for (const edge of [-4, 4, '+4', '-4']) {
            r = await preview(Object.assign(good(), { raceSpeed: edge }));
            ok(`race speed ${JSON.stringify(edge)} is accepted`, r.status === 200, r.body);
        }
        r = await preview(Object.assign(good(), { energy: 60, biology: 40 }));
        ok('energy and biology have no documented ceiling, so large levels pass', r.status === 200, r.body);

        console.log('\n── Dates and enumerations ' + '─'.repeat(49));
        r = await preview(Object.assign(good(), { plannedStartAt: 'not a date' }));
        ok('an unparseable planned start is a 400', rejected(r, 'plannedStartAt'), r.body);
        r = await preview(Object.assign(good(), { plannedStartAt: 1725000000000 }));
        ok('a number is not a planned start either', rejected(r, 'plannedStartAt'), r.body);
        r = await preview(Object.assign(good(), { plannedStartAt: '2026-09-10T12:00:00.000Z' }));
        ok('a real timestamp schedules the legs',
            r.status === 200 && r.body.arrivesAt === new Date(Date.parse('2026-09-10T12:00:00.000Z') + expectedSeconds * 1000).toISOString(), r.body);
        r = await preview(Object.assign(good(), { plannedStartAt: '' }));
        ok('an empty planned start means "none"', r.status === 200 && r.body.arrivesAt === null, r.body);
        r = await request('POST', '/hub-api/routes', Object.assign(good(), { visibility: 'public' }));
        ok('an unknown visibility is a 400', rejected(r, 'visibility'), r.body);
        r = await request('POST', '/hub-api/routes', Object.assign(good(), { title: { x: 1 } }));
        ok('a non-text title is a 400', rejected(r, 'title'), r.body);

        console.log('\n── Valid requests still get the same numbers ' + '─'.repeat(30));
        r = await preview(good());
        ok('a valid preview answers 200', r.status === 200 && r.body.success === true, r.body);
        ok('with the travel time the shared formula gives', r.body.totalSeconds === expectedSeconds && r.body.legs[0].travelSeconds === expectedSeconds, [r.body.totalSeconds, expectedSeconds]);
        ok('and the distance and biology requirement', r.body.legs[0].distance === 5 && r.body.legs[0].bioNeeded === 5, r.body.legs[0]);
        const asStrings = Object.assign(good(), { energy: '10', raceSpeed: '2', biology: '5',
            waypoints: [{ systemId: '1', planetIndex: '1' }, { systemId: '2', planetIndex: '2' }] });
        r = await preview(asStrings);
        ok('whole-number strings, as form inputs send them, give the identical result',
            r.status === 200 && r.body.totalSeconds === expectedSeconds, r.body);
        r = await preview(Object.assign(good(), { isAllianceMove: true }));
        ok('an allied move is still halved', r.status === 200 && r.body.totalSeconds === calcTravelSeconds(0, 0, 1, 3, 4, 2, 10, 2, true), r.body);

        console.log('\n── A rejected write leaves the database untouched ' + '─'.repeat(26));
        ok('no routes exist yet', count('routes') === 0 && count('route_legs') === 0);
        r = await request('POST', '/hub-api/routes', { waypoints: [null, {}], title: 'ghost' });
        ok('a malformed create is a 400', rejected(r), r.body);
        r = await request('POST', '/hub-api/routes', Object.assign(good(), { waypoints: [{ systemId: 1, planetIndex: 13 }, { systemId: 2 }] }));
        ok('an out-of-range create is a 400', rejected(r, 'waypoints[0].planetIndex'), r.body);
        r = await request('POST', '/hub-api/routes', Object.assign(good(), { energy: '12abc' }));
        ok('a partial-number create is a 400', rejected(r, 'energy'), r.body);
        ok('and none of them wrote anything', count('routes') === 0 && count('route_legs') === 0, [count('routes'), count('route_legs')]);

        r = await request('POST', '/hub-api/routes', good());
        ok('a valid create is a 200 with an id', r.status === 200 && Number.isInteger(r.body.id), r.body);
        const id = r.body.id;
        r = await request('GET', `/hub-api/routes/${id}`);
        ok('the stored route carries the same travel time', r.status === 200 && r.body.route.legs[0].travelSeconds === expectedSeconds, r.body);
        ok('and the planet indices as sent', r.body.route.legs[0].from.planetIndex === 1 && r.body.route.legs[0].to.planetIndex === 2, r.body.route.legs[0]);
        const legsBefore = db.prepare(`SELECT leg_index, travel_seconds, to_planet_index FROM route_legs WHERE route_id = ? ORDER BY leg_index`).all(id);
        const rowBefore = db.prepare(`SELECT title, energy, updated_at FROM routes WHERE id = ?`).get(id);

        r = await request('PUT', `/hub-api/routes/${id}`, Object.assign(good(), { title: 'tampered', energy: '9x' }));
        ok('a malformed update is a 400', rejected(r, 'energy'), r.body);
        r = await request('PUT', `/hub-api/routes/${id}`, Object.assign(good(), { title: 'tampered', waypoints: [{ systemId: 1 }, null] }));
        ok('...so is a malformed waypoint on update', rejected(r, 'waypoints[1]'), r.body);
        ok('and the stored route is byte-for-byte what it was',
            JSON.stringify(db.prepare(`SELECT leg_index, travel_seconds, to_planet_index FROM route_legs WHERE route_id = ? ORDER BY leg_index`).all(id)) === JSON.stringify(legsBefore)
            && JSON.stringify(db.prepare(`SELECT title, energy, updated_at FROM routes WHERE id = ?`).get(id)) === JSON.stringify(rowBefore));

        r = await request('PUT', `/hub-api/routes/${id}`, Object.assign(good(), { title: 'edited', energy: 12 }));
        ok('a valid update goes through', r.status === 200, r.body);
        ok('and changes the row', db.prepare(`SELECT title, energy FROM routes WHERE id = ?`).get(id).title === 'edited');
    } finally {
        server.close();
    }

    console.log('\n── The strict integer parser ' + '─'.repeat(46));
    ok('accepts integers and integer strings', strictInt(7) === 7 && strictInt('7') === 7 && strictInt(' 7 ') === 7 && strictInt('-3') === -3 && strictInt('+2') === 2);
    ok('rejects partial strings', Number.isNaN(strictInt('12abc')) && Number.isNaN(strictInt('1e3')) && Number.isNaN(strictInt('0x10')));
    ok('rejects fractions', Number.isNaN(strictInt(1.5)) && Number.isNaN(strictInt('1.5')));
    ok('rejects non-numbers', Number.isNaN(strictInt(true)) && Number.isNaN(strictInt(null)) && Number.isNaN(strictInt(undefined)) && Number.isNaN(strictInt([1])) && Number.isNaN(strictInt({})) && Number.isNaN(strictInt('')));
    ok('validateRouteInput copes with a non-object body', validateRouteInput(null).field === 'waypoints' && validateRouteInput([1, 2]).field === 'waypoints' && validateRouteInput('x').field === 'waypoints');

    console.log('\n── One validation step, shared by all three handlers ' + '─'.repeat(23));
    const src = fs.readFileSync(path.join(__dirname, 'routes.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const previewIdx = src.indexOf(`router.post('/routes/preview'`);
    const previewBlock = src.slice(previewIdx, src.indexOf('router.get', previewIdx));
    ok('the preview handler validates first', /validateRouteInput\(req\.body\)/.test(previewBlock));
    const writeIdx = src.indexOf('function writeRoute(');
    const writeBlock = src.slice(writeIdx, src.indexOf('db.transaction', writeIdx));
    ok('create and update (writeRoute) validate before the transaction opens', /validateRouteInput\(body\)/.test(writeBlock));
    ok('parseInt survives only inside the strict parser', (src.match(/parseInt\(/g) || []).length === 1, (src.match(/parseInt\(/g) || []).length);

    db.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
