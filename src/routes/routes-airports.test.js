// Friendly SB=0 staging is a planning assumption based on synthetic, last-recorded intel.
// These HTTP tests keep staging eligibility independent of each flight's time modifier.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-airports-'));
process.env.AWT_DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const systems = require('../repositories/systems');
const settings = require('../repositories/settings');
const { calcTravelSeconds } = require('../utils/travel-calc');
const { blockGuestWrites } = require('./_middleware');
const discord = require('../utils/discord-post');
const messages = [];
discord.postEmbed = async (channel, embed) => { messages.push(embed); return { ok: true, messageId: 'synthetic' }; };
const router = require('./routes');

let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const authorId = db.prepare('INSERT INTO app_users (game_name, password_hash) VALUES (?, ?)').run('Synthetic navigator', 'fake-hash').lastInsertRowid;
for (const [id, tag] of [[100, 'OWN'], [101, 'fri'], [102, 'OTHER']]) {
    db.prepare('INSERT INTO alliances (id, name, tag) VALUES (?, ?, ?)').run(id, 'Synthetic ' + tag, tag);
    db.prepare('INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)').run(id - 90, 'Synthetic owner ' + tag, id);
}
db.prepare('INSERT INTO alliance_member_stats (player_id) VALUES (10)').run();
settings.setSetting('alliance_relations_allied', 'FRI');
function planet(id, x, y, owner, sb, siege = 0, index = 1, inVision = null) {
    systems.upsertSystemFull(id, 'Synthetic ' + id, x, y);
    db.prepare('UPDATE systems SET is_in_vision = ? WHERE id = ?').run(inVision, id);
    db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, starbase, is_sieged, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '2098-12-31 12:34:56')`).run(id * 100 + index, id, index, owner, sb, siege);
}
planet(1, 0, 0, 10, 0); // Already used start, excluded from suggestions.
planet(2, 10, 0, 12, 0); // Hostile destination gets no automatic halving.
planet(3, 9, 0, 10, 0, 0, 1, 1); // Own airport with a useful time saving.
planet(4, 4, 0, 11, 0, 0, 1, 0); // Configured ally, recorded outside vision.
planet(5, 30, 30, 11, 0); // Valid staging point even though the detour takes longer.
planet(6, 5, 0, 11, null); // NULL starbase is unknown, never coalesced to zero.
planet(7, 5, 0, 11, 1);
planet(8, 5, 0, 12, 0);
planet(9, 5, 0, 11, 0, 1);
planet(10, 5, 0, null, 0);
planet(11, null, null, 11, 0);
planet(12, Infinity, 0, 11, 0);
planet(13, 5, 0, 11, 0, 0, 13);
planet(14, 5, 0, 11, 0, 0, 2.5);
planet(0, 5, 0, 11, 0); // Not a valid route system id, even if the row is corrupt.
systems.upsertSystemFull(15, 'Synthetic unscanned', 5, 0);

let port;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    const role = req.headers['x-test-role'] || 'user';
    req.session = role === 'anonymous' ? null : { userId: authorId, role };
    next();
});
app.use('/hub-api', blockGuestWrites, router);
function request(method, url, body, role) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { ...(role ? { 'x-test-role': role } : {}), ...(payload === null ? {} : { 'Content-Type': 'application/json' }) };
        const req = http.request({ hostname: '127.0.0.1', port, method, path: '/hub-api' + url, headers }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (err) { reject(err); } });
        });
        req.on('error', reject);
        req.end(payload);
    });
}
const body = extra => ({ waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 2, planetIndex: 1 }],
    energy: 10, raceSpeed: 2, biology: 5, isAllianceMove: false, ...extra });
const target = '2099-06-01T18:00:07.000Z';
const preview = b => request('POST', '/routes/preview', b);
const airports = b => request('POST', '/routes/airports', b);
const totalChanges = () => db.prepare('SELECT total_changes() n').get().n;
const withAirport = (original, suggestion) => ({ ...original, waypoints: [
    ...original.waypoints.slice(0, suggestion.insertAfterIndex + 1), suggestion.waypoint,
    ...original.waypoints.slice(suggestion.insertAfterIndex + 1)
] });

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
    try {
        const before = totalChanges();
        let r = await airports(body({ targetArrivalAt: target }));
        ok('airport comparison is read-only', r.status === 200 && totalChanges() === before, r);
        ok('only own/allied SB=0 unsieged finite valid locations qualify',
            same(r.body.suggestions.map(s => s.waypoint.systemId).sort((a, b) => a - b), [3, 4, 5]), r.body);
        ok('the best suggestion saves time', r.body.suggestions[0].waypoint.systemId === 3 && r.body.suggestions[0].savedSeconds > 0);
        ok('slower but valid staging points stay visible with negative savings', r.body.suggestions.find(s => s.waypoint.systemId === 5).savedSeconds < 0);
        ok('last-recorded timestamp is explicit UTC', r.body.suggestions.every(s => s.lastSeenAt === '2098-12-31T12:34:56.000Z'));
        ok('visibility retains true, false and unknown separately', r.body.suggestions.find(s => s.waypoint.systemId === 3).isInVision === true
            && r.body.suggestions.find(s => s.waypoint.systemId === 4).isInVision === false
            && r.body.suggestions.find(s => s.waypoint.systemId === 5).isInVision === null);
        const comparison = r.body;
        const directSeconds = calcTravelSeconds(0, 0, 1, 10, 0, 1, 10, 2, false);
        ok('baseline remains the direct hostile-destination travel time', comparison.current.totalSeconds === directSeconds);
        for (const suggestion of comparison.suggestions) {
            const inserted = await preview(withAirport(body({ targetArrivalAt: target }), suggestion));
            ok(`airport ${suggestion.waypoint.systemId} matches ordinary preview after insertion`, inserted.status === 200
                && inserted.body.totalSeconds === suggestion.totalSeconds && inserted.body.departsAt === suggestion.departsAt
                && inserted.body.arrivesAt === suggestion.arrivesAt && suggestion.arrivesAt === target);
            ok('saving is the exact difference in rounded per-leg seconds', suggestion.savedSeconds === directSeconds - inserted.body.totalSeconds);
            ok('candidate biology warnings match preview before the airport is selected', suggestion.outOfReach === inserted.body.legs.some(l => l.outOfReach)
                && suggestion.bioNeeded === Math.max(...inserted.body.legs.map(l => l.bioNeeded)));
            ok('airport arrival is halved but onward hostile flight is not', inserted.body.legs[0].isAllianceMove === true && inserted.body.legs[1].isAllianceMove === false);
            ok('only the intermediate destination carries jump-point status', inserted.body.legs[0].jumpPoint.status === 'friendly-no-starbase'
                && !Object.hasOwn(inserted.body.legs[1], 'jumpPoint'));
        }
        r = await airports(body({ plannedStartAt: target }));
        ok('start-based comparison preserves departure and recalculates arrival', r.status === 200 && r.body.suggestions.every(s => s.departsAt === target
            && Date.parse(s.arrivesAt) === Date.parse(target) + s.totalSeconds * 1000));
        r = await airports(body());
        ok('unscheduled comparisons keep both timestamps empty', r.status === 200 && r.body.suggestions.every(s => s.departsAt === null && s.arrivesAt === null));
        r = await airports(body({ biology: 11 }));
        ok('biology warnings flag the detour without excluding future plans', r.status === 200
            && r.body.suggestions.find(s => s.waypoint.systemId === 5).outOfReach === true
            && r.body.suggestions.find(s => s.waypoint.systemId === 3).outOfReach === false);

        const multi = body({ targetArrivalAt: target, waypoints: [{ systemId: 1, planetIndex: 1 }, { systemId: 4, planetIndex: 1 }, { systemId: 2, planetIndex: 1 }] });
        r = await airports(multi);
        ok('already-used locations are excluded from multi-leg suggestions', r.body.suggestions.every(s => ![1, 2, 4].includes(s.waypoint.systemId)));
        const ownSuggestion = r.body.suggestions.find(s => s.waypoint.systemId === 3);
        const variants = await Promise.all([0, 1].map(index => preview(withAirport(multi, { waypoint: ownSuggestion.waypoint, insertAfterIndex: index }))));
        ok('each distinct airport appears once at its fastest insertion position', r.body.suggestions.filter(s => s.waypoint.systemId === 3).length === 1
            && ownSuggestion.totalSeconds === Math.min(...variants.map(v => v.body.totalSeconds)));
        r = await airports(body({ waypoints: [1, 3, 4, 5, 7, 8, 2].map(systemId => ({ systemId, planetIndex: 1 })) }));
        ok('six existing legs return the baseline and an explicit limit without adding a seventh', r.status === 200 && r.body.limitReached === true && r.body.suggestions.length === 0);
        r = await airports(body({ waypoints: [1, 3, 4, 5, 7, 8, 9, 2].map(systemId => ({ systemId, planetIndex: 1 })) }));
        ok('an over-limit route is rejected consistently with preview', r.status === 400 && r.body.field === 'waypoints');
        r = await airports(body({ targetArrivalAt: 'not a timestamp' }));
        ok('airport requests share normal date validation', r.status === 400 && r.body.field === 'targetArrivalAt');

        const statusStops = [3, 6, 7, 8, 9];
        const manual = body({ targetArrivalAt: target, waypoints: [1, ...statusStops, 2].map(systemId => ({ systemId, planetIndex: 1 })) });
        r = await preview(manual);
        const statuses = ['friendly-no-starbase', 'unknown-intel', 'starbase-present', 'not-friendly', 'sieged'];
        ok('manual jumps distinguish friendly, unknown SB, SB present, hostile and siege', r.status === 200
            && same(r.body.legs.slice(0, -1).map(l => l.jumpPoint.status), statuses), r.body);
        ok('SB/siege eligibility does not remove a friendly destination travel modifier', r.body.legs[2].isAllianceMove === true
            && r.body.legs[4].isAllianceMove === true && r.body.legs[3].isAllianceMove === false);
        r = await preview(body({ waypoints: [1, 15, 2].map(systemId => ({ systemId, planetIndex: 1 })) }));
        ok('missing planet intel is unknown, not a safe airport', r.body.legs[0].jumpPoint.status === 'unknown-intel' && r.body.legs[0].jumpPoint.starbase === null);
        r = await preview({ ...manual, isAllianceMove: true });
        ok('manual travel override never turns a hostile jump into a friendly airport', r.body.legs.every(l => l.isAllianceMove)
            && r.body.legs[3].jumpPoint.status === 'not-friendly');

        r = await request('POST', '/routes', manual);
        const routeId = r.body.id;
        const savedBefore = db.prepare('SELECT * FROM route_legs WHERE route_id = ? ORDER BY leg_index').all(routeId);
        r = await request('GET', `/routes/${routeId}`);
        const savedSchedule = r.body.route.legs.map(l => [l.departsAt, l.arrivesAt, l.travelSeconds]);
        ok('saved GET carries the same manual jump statuses', same(r.body.route.legs.slice(0, -1).map(l => l.jumpPoint.status), statuses));
        db.prepare('UPDATE planets SET starbase = 2 WHERE system_id = 3').run();
        r = await request('GET', `/routes/${routeId}`);
        ok('saved jump eligibility follows current recorded intel without changing saved flight times', r.body.route.legs[0].jumpPoint.status === 'starbase-present'
            && same(r.body.route.legs.map(l => [l.departsAt, l.arrivesAt, l.travelSeconds]), savedSchedule)
            && same(db.prepare('SELECT * FROM route_legs WHERE route_id = ? ORDER BY leg_index').all(routeId), savedBefore));
        r = await request('POST', `/routes/${routeId}/announce`);
        ok('Discord marks unsafe/unknown staging using last-recorded language', r.status === 200 && messages.length === 1
            && messages[0].description.includes('jump point has a starbase') && messages[0].description.includes('jump point eligibility unknown')
            && messages[0].description.includes('jump point is under siege') && messages[0].description.includes('last recorded intel'));
        db.prepare('UPDATE planets SET starbase = 0 WHERE system_id = 3').run();

        const beforeGuest = totalChanges();
        r = await request('POST', '/routes/airports', body(), 'guest');
        ok('guests can compare airports without writes', r.status === 200 && totalChanges() === beforeGuest);
        r = await request('POST', '/routes', body(), 'guest');
        ok('the guest exception does not grant save access', r.status === 403 && totalChanges() === beforeGuest);
        r = await request('POST', '/routes/airports/evil', body(), 'guest');
        ok('near-miss paths remain guest-blocked', r.status === 403);
        r = await request('POST', '/routes/airports', body(), 'anonymous');
        ok('airport intel still requires authentication', r.status === 401);

        for (let id = 20; id < 40; id++) planet(id, id - 20, 1, 11, 0);
        const calls = {};
        const originals = {};
        for (const name of ['getSystemsByIds', 'getRoutePlanetIntelByLocations', 'getFriendlyRouteAirports']) {
            originals[name] = systems[name];
            systems[name] = (...args) => { calls[name] = (calls[name] || 0) + 1; return originals[name](...args); };
        }
        try { r = await airports(body()); }
        finally { Object.assign(systems, originals); }
        ok('large candidate sets reuse one batched lookup per data set', r.status === 200 && Object.values(calls).every(n => n === 1), calls);
        ok('comparison returns at most five distinct airports in descending savings order', r.body.suggestions.length === 5
            && new Set(r.body.suggestions.map(s => `${s.waypoint.systemId}:${s.waypoint.planetIndex}`)).size === 5
            && r.body.suggestions.every((s, i, all) => i === 0 || all[i - 1].savedSeconds >= s.savedSeconds));
        const ranked = r.body.suggestions.map(s => [s.waypoint.systemId, s.waypoint.planetIndex, s.savedSeconds]);
        const again = await airports(body());
        ok('ranking is deterministic across repeated requests', same(ranked, again.body.suggestions.map(s => [s.waypoint.systemId, s.waypoint.planetIndex, s.savedSeconds])));

        settings.setSetting('alliance_relations_allied', '');
        r = await airports(body());
        ok('removing a configured ally removes its airports immediately', r.status === 200 && same(r.body.suggestions.map(s => s.waypoint.systemId), [3]));
        db.prepare('DELETE FROM alliance_member_stats').run();
        r = await airports(body());
        ok('without known friendly tags no airport is invented', r.status === 200 && r.body.suggestions.length === 0);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`\n${pass} checks passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err); process.exitCode = 1; });
