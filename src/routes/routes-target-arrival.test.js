// Issue #163: exercise preview, storage and Discord using only a synthetic galaxy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-target-arrival-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const systemsRepo = require('../repositories/systems');
const settingsRepo = require('../repositories/settings');
const { calcTravelSeconds } = require('../utils/travel-calc');
const discord = require('../utils/discord-post');
const messages = [];
discord.postEmbed = async (setting, embed) => {
    messages.push({ setting, embed });
    return { ok: true, messageId: 'synthetic-message' };
};
const router = require('./routes');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const iso = ms => new Date(ms).toISOString();
const sqlDate = ms => iso(ms).replace('T', ' ').slice(0, 19);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejected = (r, field) => r.status === 400 && r.body.field === field && typeof r.body.error === 'string';

const authorId = db.prepare('INSERT INTO app_users (game_name, password_hash) VALUES (?, ?)')
    .run('Synthetic navigator', 'synthetic-hash').lastInsertRowid;
systemsRepo.upsertSystemFull(1, 'Synthetic home', 0, 0);
systemsRepo.upsertSystemFull(2, 'Synthetic ally', 3, 4);
systemsRepo.upsertSystemFull(3, 'Synthetic target', 9, 12);
db.prepare('INSERT INTO alliances (id, name, tag) VALUES (100, ?, ?)').run('Synthetic friends', 'SYN');
db.prepare('INSERT INTO players (id, name, alliance_id) VALUES (10, ?, 100)').run('Synthetic ally');
db.prepare('INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (201, 2, 2, 10)').run();
settingsRepo.setSetting('alliance_relations_allied', 'SYN');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: authorId, role: 'user' }; next(); });
app.use('/hub-api', router);
let port;
function request(method, url, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
        const req = http.request({ hostname: '127.0.0.1', port, method, path: '/hub-api' + url, headers }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch (err) { reject(new Error(`Unexpected response ${res.statusCode}: ${raw}`)); }
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}
const preview = body => request('POST', '/routes/preview', body);
const routeBody = extra => ({
    waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 2 }, { systemId: 3, planetIndex: 3 }],
    energy: 10, raceSpeed: 2, biology: 20, isAllianceMove: false,
    title: 'Synthetic timing plan', visibility: 'alliance', plannedStartAt: null, targetArrivalAt: null,
    ...extra
});
const expectedLegSeconds = [
    calcTravelSeconds(0, 0, 1, 3, 4, 2, 10, 2, true),
    calcTravelSeconds(3, 4, 2, 9, 12, 3, 10, 2, false)
];
const totalSeconds = expectedLegSeconds.reduce((a, b) => a + b, 0);
const target = '2099-06-01T00:00:07.000Z';
const departure = iso(Date.parse(target) - totalSeconds * 1000);
const snapshot = id => ({
    route: db.prepare('SELECT * FROM routes WHERE id = ?').get(id),
    legs: db.prepare('SELECT * FROM route_legs WHERE route_id = ? ORDER BY leg_index').all(id)
});

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
    try {
        let r = await preview(routeBody({ targetArrivalAt: target }));
        ok('multi-leg arrival preview succeeds', r.status === 200, r.body);
        const initial = r.body;
        ok('each leg retains the shared formula and individual alliance modifier',
            same(initial.legs.map(l => l.travelSeconds), expectedLegSeconds)
            && initial.legs[0].isAllianceMove && !initial.legs[1].isAllianceMove, initial.legs);
        ok('departure subtracts the exact sum without re-rounding', initial.totalSeconds === totalSeconds && initial.departsAt === departure, initial);
        ok('last arrival exactly equals the target, including seconds', initial.arrivesAt === target && initial.legs.at(-1).arrivesAt === target);
        ok('legs depart consecutively with no gaps or overlap', initial.legs[0].departsAt === departure && initial.legs[1].departsAt === initial.legs[0].arrivesAt);
        ok('only the chosen user anchor is returned', initial.plannedStartAt === null && initial.targetArrivalAt === target);
        ok('back-calculation can cross midnight', initial.departsAt.slice(0, 10) < target.slice(0, 10));

        r = await preview(routeBody({ targetArrivalAt: target, waypoints: routeBody().waypoints.slice(0, 2) }));
        ok('single leg lands exactly at the target', r.status === 200 && r.body.legs.length === 1 && r.body.arrivesAt === target
            && Date.parse(target) - Date.parse(r.body.departsAt) === expectedLegSeconds[0] * 1000, r.body);
        for (const change of [{ energy: 25 }, { raceSpeed: -2 }, { isAllianceMove: true }, { waypoints: routeBody().waypoints.slice(0, 2) }]) {
            r = await preview(routeBody({ targetArrivalAt: target, ...change }));
            ok(`editing ${Object.keys(change)[0]} preserves arrival and adjusts departure`,
                r.status === 200 && r.body.arrivesAt === target && r.body.departsAt !== departure, r.body);
        }
        r = await preview(routeBody({ plannedStartAt: '2099-06-01T02:00:07+02:00' }));
        ok('existing start mode is canonical UTC and remains forward-calculated', r.status === 200
            && r.body.plannedStartAt === target && r.body.targetArrivalAt === null && r.body.departsAt === target
            && r.body.arrivesAt === iso(Date.parse(target) + totalSeconds * 1000), r.body);
        r = await preview(routeBody({ plannedStartAt: ' ', targetArrivalAt: '' }));
        ok('both blank anchors preserve unscheduled preview', r.status === 200 && r.body.departsAt === null
            && r.body.arrivesAt === null && r.body.legs.every(l => l.departsAt === null && l.arrivesAt === null));
        r = await preview(routeBody({ targetArrivalAt: '2000-01-01T00:00:07.000Z' }));
        ok('past required departure is returned without clamping to now', r.status === 200
            && r.body.arrivesAt === '2000-01-01T00:00:07.000Z' && Date.parse(r.body.departsAt) < Date.parse(r.body.arrivesAt));
        for (const [input, canonical] of [
            ['2099-06-01T02:00+02:00', '2099-06-01T00:00:00.000Z'],
            ['2026-03-29T03:00:07+02:00', '2026-03-29T01:00:07.000Z'],
            ['2026-10-25T02:30:07+02:00', '2026-10-25T00:30:07.000Z'],
            ['2026-10-25T02:30:07+01:00', '2026-10-25T01:30:07.000Z']
        ]) {
            r = await preview(routeBody({ targetArrivalAt: input }));
            ok(`UTC scheduling preserves the explicit offset at ${input}`, r.status === 200 && r.body.arrivesAt === canonical
                && Date.parse(r.body.arrivesAt) - Date.parse(r.body.departsAt) === totalSeconds * 1000, r.body);
        }

        const invalidBodies = [
            [routeBody({ plannedStartAt: target, targetArrivalAt: target }), 'targetArrivalAt'],
            ...['not a date', 123, true, [], {}, '2099-06-01T12:00', '2099-02-30T12:00:00Z',
                '2099-06-01T24:00:00Z', '9999-12-31T23:59:59.000Z', '0000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.000Z']
                .map(value => [routeBody({ targetArrivalAt: value }), 'targetArrivalAt']),
            [routeBody({ plannedStartAt: '9999-12-31T00:00:00.000Z' }), 'plannedStartAt']
        ];
        for (const [body, field] of invalidBodies) {
            r = await preview(body);
            ok(`invalid/conflicting/overflow date preview is rejected: ${JSON.stringify(body[field])}`, rejected(r, field), r);
            r = await request('POST', '/routes', body);
            ok('the same invalid create is a field-specific 400', rejected(r, field), r);
        }
        ok('rejected creates wrote neither routes nor legs', db.prepare('SELECT COUNT(*) n FROM routes').get().n === 0
            && db.prepare('SELECT COUNT(*) n FROM route_legs').get().n === 0);

        r = await request('POST', '/routes', routeBody({ targetArrivalAt: target }));
        ok('arrival route saves', r.status === 200 && Number.isInteger(r.body.id), r);
        const id = r.body.id;
        const stored = snapshot(id);
        ok('database stores only the selected arrival anchor', stored.route.target_arrival_at === target && stored.route.planned_start_at === null, stored.route);
        ok('expiry is exactly 24 hours after final arrival', stored.route.expires_at === sqlDate(Date.parse(target) + 86400000), stored.route.expires_at);
        r = await request('GET', `/routes/${id}`);
        ok('GET preserves both anchor and full computed schedule', r.status === 200 && r.body.route.targetArrivalAt === target
            && r.body.route.plannedStartAt === null && r.body.route.departsAt === departure && same(r.body.route.legs.map(l => [l.departsAt, l.arrivesAt]), initial.legs.map(l => [l.departsAt, l.arrivesAt])), r.body);
        for (const [body, field] of invalidBodies) {
            r = await request('PUT', `/routes/${id}`, { ...body, title: 'must not be written' });
            ok('invalid update is rejected before any mutation', rejected(r, field) && same(snapshot(id), stored), r);
        }

        // Current intel may change after saving; read/share uses saved travel_seconds.
        systemsRepo.upsertSystemFull(2, 'Synthetic ally', 30, 40);
        settingsRepo.setSetting('alliance_relations_allied', '');
        r = await request('GET', `/routes/${id}`);
        ok('GET uses the saved leg durations after coordinates/ownership data changes', r.status === 200
            && r.body.route.departsAt === departure && r.body.route.arrivesAt === target
            && same(r.body.route.legs.map(l => l.travelSeconds), expectedLegSeconds), r.body);
        r = await request('POST', `/routes/${id}/announce`);
        const description = messages.at(-1)?.embed.description || '';
        ok('Discord uses computed departure and target from the saved snapshot with seconds', r.status === 200 && messages.length === 1
            && description.includes(`Departs <t:${Date.parse(departure) / 1000}:D> <t:${Date.parse(departure) / 1000}:T>`)
            && description.includes(`Target arrival <t:${Date.parse(target) / 1000}:D> <t:${Date.parse(target) / 1000}:T>`)
            && description.includes(`arrives <t:${Date.parse(target) / 1000}:T>`), description);
        systemsRepo.upsertSystemFull(2, 'Synthetic ally', 3, 4);
        settingsRepo.setSetting('alliance_relations_allied', 'SYN');

        r = await request('PUT', `/routes/${id}`, routeBody({ plannedStartAt: target }));
        let updated = snapshot(id).route;
        ok('switch to start mode clears the previous target', r.status === 200 && updated.planned_start_at === target && updated.target_arrival_at === null);
        ok('start-based expiry remains final arrival plus 24 hours', updated.expires_at === sqlDate(Date.parse(target) + totalSeconds * 1000 + 86400000));
        r = await request('PUT', `/routes/${id}`, routeBody({ targetArrivalAt: target }));
        updated = snapshot(id).route;
        ok('switch back to arrival mode clears the previous start', r.status === 200 && updated.planned_start_at === null && updated.target_arrival_at === target);
        const beforeUnscheduled = Date.now();
        r = await request('PUT', `/routes/${id}`, routeBody());
        updated = snapshot(id).route;
        const expiryMs = Date.parse(updated.expires_at.replace(' ', 'T') + 'Z');
        ok('clearing the schedule clears both stored anchors', r.status === 200 && updated.planned_start_at === null && updated.target_arrival_at === null);
        ok('unscheduled route keeps the seven-day TTL', expiryMs >= beforeUnscheduled + 7 * 86400000 - 1000
            && expiryMs <= Date.now() + 7 * 86400000, updated.expires_at);

        // The target route has a later arrival but an earlier departure than the other
        // plan; sorting by the anchor (or NULL/created_at) would put these in the wrong order.
        r = await request('POST', '/routes', routeBody({ targetArrivalAt: target }));
        const arrivalId = r.body.id;
        r = await request('POST', '/routes', routeBody({ plannedStartAt: iso(Date.parse(departure) - 1000) }));
        const earlierId = r.body.id;
        r = await request('POST', '/routes', routeBody({ plannedStartAt: iso(Date.parse(departure) + 1000) }));
        const laterId = r.body.id;
        r = await request('GET', '/routes');
        const ids = r.body.routes.map(route => route.id);
        ok('saved list orders both modes by actual departure', r.status === 200 && ids.indexOf(earlierId) < ids.indexOf(arrivalId)
            && ids.indexOf(arrivalId) < ids.indexOf(laterId), ids);
        ok('listed arrival route retains its selected mode and schedule', r.body.routes.find(route => route.id === arrivalId).targetArrivalAt === target
            && r.body.routes.find(route => route.id === arrivalId).departsAt === departure);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    console.log(`\n${pass} checks passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
