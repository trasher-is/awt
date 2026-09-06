// A round reset removes routes and takeover assignments with the map — atomically.
//
// Run with:  node src/routes/admin-round-reset.test.js
//
// Confirmed against the real admin router on a synthetic database (issue #128): a
// successful POST /admin/nuke-intel answered 200 and left systems=0, routes=1,
// route_legs=1, planet_takeovers=1. Route endpoints join leg system ids to the CURRENT
// systems table, and the next round reuses the same ids, so an old plan came back
// showing new coordinates with last round's travel times; old takeover assignments
// reattached to planets nobody had assigned.
//
// This drives the REAL router and the REAL reset handler, then reseeds the same system
// ids as the "next round" and asks the real route and takeover endpoints what they see.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-round-reset-'));
process.env.AWT_DB_PATH = path.join(tmpRoot, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'master-pw-for-the-test';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const systemsRepo = require('../repositories/systems');
const routingRepo = require('../repositories/routing');
const playersRepo = require('../repositories/players');
const settingsRepo = require('../repositories/settings');
const { hubBody } = require('../utils/hub-body');
const adminRouter = require('./admin');
const routesRouter = require('./routes');
const intelRouter = require('./intel');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const admin = usersRepo.getUserByGameName('admin');
usersRepo.createUser('Planner', 'not-a-real-hash', 'user', null);
const planner = usersRepo.getUserByGameName('Planner');

// The master admin's session, exactly as the nuke handler checks it.
const app = express();
app.use('/hub-api', hubBody({ syncLimit: '1mb', limit: '256kb' }));
app.use((req, res, next) => { req.session = { userId: admin.id, gameName: 'admin', role: 'admin' }; next(); });
app.use('/hub-api', adminRouter);
app.use('/hub-api', routesRouter);
app.use('/hub-api', intelRouter);

let port;
function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
        const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* */ } resolve({ status: res.statusCode, body: b }); });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

const count = table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

// "A round": three systems with coordinates, one player, one shared two-leg route over
// them, and one takeover assignment. Coordinates differ per round on purpose — that is
// the whole failure: the ids come back, the positions do not.
function seedRound({ coords, routeToo }) {
    for (const [id, x, y] of coords) systemsRepo.upsertSystemFull(id, `System ${id}`, x, y);
    db.prepare(`INSERT OR IGNORE INTO players (id, name) VALUES (500, 'Runner')`).run();
    for (const [id] of coords) {
        db.prepare(`INSERT OR REPLACE INTO planets (game_planet_id, system_id, planet_index, owner_id, population) VALUES (?, ?, 2, NULL, 100)`)
            .run(id * 100 + 2, id);
    }
    if (routeToo) {
        const routeId = routingRepo.insertRoute(planner.id, 'Old plan', 'from last round', null, 10, 2, 0, 5, 'alliance', null);
        routingRepo.insertRouteLeg(routeId, 0, coords[0][0], 2, coords[1][0], 2, 36000, 10, 10);
        routingRepo.insertRouteLeg(routeId, 1, coords[1][0], 2, coords[2][0], 2, 36000, 10, 10);
        systemsRepo.upsertTakeover(coords[2][0], 2, 'Runner', 2, '18:00:00');
    }
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    port = server.address().port;

    try {
        console.log('── The round before the reset ' + '─'.repeat(45));
        seedRound({ coords: [[11, 0, 0], [12, 10, 0], [13, 20, 0]], routeToo: true });
        // Things that must SURVIVE a reset.
        settingsRepo.setSetting('discord_announce_channel', '1234');
        db.prepare(`INSERT INTO rz_plans (planet_id, text) VALUES (77, 'redzone note')`).run();
        db.prepare(`INSERT INTO alliance_broadcasts (message, author_name, display_time) VALUES ('hi', 'admin', '10:00')`).run();
        db.prepare(`INSERT INTO starbase_order_audit (order_id, system_id, planet_index, actor_user_id, actor_game_name) VALUES (1, 11, 2, ?, 'Planner')`).run(planner.id);
        const usersBefore = count('app_users');
        const roundsBefore = count('rounds');

        ok('the seed is what the issue describes: systems, a route with legs, an assignment',
            count('systems') === 3 && count('routes') === 1 && count('route_legs') === 2 && count('planet_takeovers') === 1,
            { systems: count('systems'), routes: count('routes'), legs: count('route_legs'), takeovers: count('planet_takeovers') });

        let r = await request('GET', '/hub-api/routes');
        ok('the route is visible through the real endpoint before the reset', r.status === 200 && r.body.routes.length === 1, r.body);
        ok('with last round\'s coordinates on its legs', r.body.routes[0].legs[0].to.x === 10, r.body.routes[0].legs[0]);
        r = await request('GET', '/hub-api/intel/takeover/13');
        ok('the assignment is visible on the takeover board', r.status === 200 && r.body.board.some(p => p.assigned_name === 'Runner'), r.body);

        console.log('\n── The reset ' + '─'.repeat(62));
        r = await request('POST', '/hub-api/admin/nuke-intel', { password: 'wrong', label: 'nope' });
        ok('a wrong master password is refused', r.status === 401, [r.status, r.body]);
        ok('...and deletes nothing', count('routes') === 1 && count('systems') === 3);

        r = await request('POST', '/hub-api/admin/nuke-intel', { password: 'master-pw-for-the-test', label: 'Round 1' });
        ok('the real reset endpoint answers 200', r.status === 200 && r.body.success === true, [r.status, r.body]);
        ok('it archived the round on the way', r.body.archived && r.body.archived.systems === 3 && count('rounds') === roundsBefore + 1, r.body.archived);

        const after = { systems: count('systems'), routes: count('routes'), legs: count('route_legs'), takeovers: count('planet_takeovers') };
        ok('systems are gone', after.systems === 0, after);
        ok('routes are gone too — the fix', after.routes === 0, after);
        ok('and their legs', after.legs === 0, after);
        ok('and the takeover assignments', after.takeovers === 0, after);

        console.log('\n── What a reset must NOT touch ' + '─'.repeat(44));
        ok('accounts survive', count('app_users') === usersBefore, count('app_users'));
        ok('settings survive', settingsRepo.getSetting('discord_announce_channel').value === '1234');
        ok('the redzone planner survives', count('rz_plans') === 1);
        ok('broadcasts survive', count('alliance_broadcasts') === 1);
        ok('the starbase-order audit survives', count('starbase_order_audit') === 1);
        ok('the round archive survives, and grew', count('round_systems') === 3 && count('rounds') === roundsBefore + 1);

        console.log('\n── The next round reuses the ids ' + '─'.repeat(42));
        seedRound({ coords: [[11, 5, 5], [12, 50, 50], [13, 90, 90]], routeToo: false });
        r = await request('GET', '/hub-api/routes');
        ok('no plan from the previous round reappears', r.status === 200 && r.body.routes.length === 0, r.body);
        r = await request('GET', '/hub-api/intel/takeover/13');
        ok('no assignment from the previous round reappears on the board',
            r.status === 200 && r.body.board.every(p => p.assigned_name == null), r.body);

        console.log('\n── An archive failure rolls back ALL deletions ' + '─'.repeat(29));
        // The next round is now live and has a route and an assignment of its own.
        const routeId = routingRepo.insertRoute(planner.id, 'This round', null, null, 0, 0, 0, 0, 'alliance', null);
        routingRepo.insertRouteLeg(routeId, 0, 11, 2, 12, 2, 1000, 1, 1);
        systemsRepo.upsertTakeover(11, 2, 'Runner', 1, null);
        // Make the snapshot fail the way a real fault would: its table is gone.
        db.exec(`DROP TABLE round_players`);
        r = await request('POST', '/hub-api/admin/nuke-intel', { password: 'master-pw-for-the-test', label: 'doomed' });
        ok('the reset reports failure', r.status === 500 && /Nothing was deleted/.test(r.body.error), [r.status, r.body]);
        const kept = { systems: count('systems'), routes: count('routes'), legs: count('route_legs'), takeovers: count('planet_takeovers') };
        ok('systems are still there', kept.systems === 3, kept);
        ok('the route and its leg are still there', kept.routes === 1 && kept.legs === 1, kept);
        ok('the assignment is still there', kept.takeovers === 1, kept);
        ok('and no half-written round was left behind', count('rounds') === roundsBefore + 1, count('rounds'));
    } finally {
        server.close();
    }

    console.log('\n── The reset path really calls the new deletes ' + '─'.repeat(28));
    const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const adminSrc = readCode('src/routes/admin.js');
    const txStart = adminSrc.indexOf('const nukeTx = db.transaction(');
    const txEnd = adminSrc.indexOf('nukeTx();');
    const tx = adminSrc.slice(txStart, txEnd);
    ok('the deletes sit inside the reset transaction', txStart !== -1 && txEnd !== -1 && txStart < txEnd);
    for (const call of ['routingRepo.deleteAllRouteLegs()', 'routingRepo.deleteAllRoutes()', 'systemsRepo.deleteAllTakeovers()']) {
        ok(`...including ${call}`, tx.includes(call));
    }
    ok('and after the archive snapshot, so a failing snapshot deletes nothing',
        tx.indexOf('archiveRound(db') !== -1 && tx.indexOf('archiveRound(db') < tx.indexOf('routingRepo.deleteAllRoutes()'));
    const ops = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'operations.md'), 'utf8');
    ok('docs/operations.md lists the round-scoped tables, routes and takeovers included',
        /round-scoped/i.test(ops) && /planet_takeovers/.test(ops) && /route_legs/.test(ops) && /rz_plans/.test(ops));

    db.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
