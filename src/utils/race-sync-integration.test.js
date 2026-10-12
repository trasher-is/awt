// Real routers and SQLite, local HTTP only. No game, Discord or AI transport.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-race-sync-'));
process.env.AWT_DB_PATH = path.join(temporary, 'synthetic.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-sync-password';
process.env.RACE_LLM = '0';
delete process.env.DISCORD_TOKEN; delete process.env.BATTLE_DISCORD_TOKEN;
const db = require('../database');
const express = require('express');
const inference = require('./race-inference-service');
const Model = require('../../public/js/utils/battle-model');
const version = require('../../public/js/utils/race-inference').modelVersion();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    if (req.headers['x-test-role']) req.session = { userId: 1, role: req.headers['x-test-role'], gameName: 'admin' };
    next();
});
app.use('/hub-api', require('../routes/api'));
const server = app.listen(0, '127.0.0.1');
let failed = 0;
function ok(name, condition, detail) {
    console.log(`${condition ? 'ok' : 'NOT OK'} - ${name}`);
    if (!condition) { failed++; if (detail) console.error(JSON.stringify(detail)); }
}
const send = (method, endpoint, body, role = 'admin') => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, method,
        path: '/hub-api' + endpoint, headers: { 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload), ...(role ? { 'x-test-role': role } : {}) } }, response => {
        let data = ''; response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    request.on('error', reject); request.end(payload);
});
server.once('listening', async () => {
    try {
        const flags = { bestPlanet: true, bestGuarded: false, strongestFleets: true, recentBattles: true };
        const now = new Date().toISOString();
        const system = { system_id: 501, planets: [{ planet_index: 1, game_planet_id: 50101,
            population: 0, starbase: 0, api_statistics: flags }], fleets: [], captured_at: now };
        let response = await send('POST', '/sync/system', system);
        let planet = db.prepare('SELECT * FROM planets WHERE system_id=501 AND planet_index=1').get();
        ok('system receiver persists API statistics through the real planet upsert', response.status === 200
            && JSON.parse(planet.api_statistics).strongestFleets && planet.api_statistics_observed_at === now, response);
        response = await send('POST', '/sync/system', { ...system, captured_at: new Date(Date.now() - 3600000).toISOString(),
            planets: [{ ...system.planets[0], api_statistics: null }] });
        planet = db.prepare('SELECT * FROM planets WHERE system_id=501 AND planet_index=1').get();
        ok('an older API observation cannot clear fresher stored statistics', response.body.skipped === 'stale_observation'
            && JSON.parse(planet.api_statistics).strongestFleets);
        response = await send('POST', '/sync/system', { ...system, captured_at: null,
            planets: [{ planet_index: 1, game_planet_id: 50102, population: 0, starbase: 0 }] });
        planet = db.prepare('SELECT * FROM planets WHERE system_id=501 AND planet_index=1').get();
        ok('replacement identity cannot inherit availability badges', response.status === 200
            && planet.game_planet_id === 50102 && planet.api_statistics === null);

        db.prepare("INSERT INTO players(id,name,has_intel,science_level,level,joined) VALUES(6101,'Synthetic Subject',0,14,20,'2026-09-01')").run();
        db.prepare("INSERT INTO players(id,name,has_intel,race_attack,race_defense,physics,mathematics,level,intel_updated_at) VALUES(6102,'Synthetic Known',1,0,0,12,12,20,'2026-10-01 10:00:00')").run();
        const atkFleet = [0, 300, 0], defFleet = [2600, 0, 0];
        const outcome = Model.simulate({ atkFleet, defFleet, atk: { ra: 2, rd: 1, phys: 12, math: 11, lvl: 20 }, def: { ra: 0, rd: 0, phys: 12, math: 12, lvl: 20 } });
        db.prepare(`INSERT INTO battle_reports(id,started_at,is_public,att_player_id,def_player_id,att_has_won,def_has_won,
            att_combat_value,def_combat_value,stats_snapshot_at,def_race_attack,def_race_defense,def_physics,def_mathematics,def_player_level,def_intel_at)
            VALUES(6201,'2026-10-01T12:00:00Z',1,6101,6102,1,0,?,?,'2026-10-01 12:01:00',0,0,12,12,20,'2026-10-01 10:00:00')`).run(Model.cvOf(atkFleet), Model.cvOf(defFleet));
        const detail = { att_win_chance: outcome.winA * 100, dice_roll: 0 };
        for (const [side, fleet, alive] of [['att', atkFleet, outcome.survAtk], ['def', defFleet, outcome.survDef]]) {
            Model.SHIPS.forEach((ship, i) => { detail[`${side}_${ship.key}`] = fleet[i]; detail[`${side}_${ship.key}_lost`] = fleet[i] - Math.round(alive[i]); });
            for (const ship of ['transports', 'colony_ships', 'starbases']) detail[`${side}_${ship}`] = detail[`${side}_${ship}_lost`] = 0;
        }
        const lossCv = side => Model.cvOf(Model.SHIPS.map(ship => detail[`${side}_${ship.key}_lost`]));
        db.prepare('UPDATE battle_reports SET att_lost_cv=?,def_lost_cv=?,att_survived_cv=?,def_survived_cv=? WHERE id=6201')
            .run(lossCv('att'), lossCv('def'), Model.cvOf(atkFleet) - lossCv('att'), Model.cvOf(defFleet) - lossCv('def'));
        response = await send('POST', '/sync/battle-report-ship-detail', { id: 6201, ...detail });
        inference.flush();
        const stored = db.prepare('SELECT dice_consistent,att_win_chance FROM battle_reports WHERE id=6201').get();
        ok('ship detail validates separate probability and dice and queues local estimates', response.status === 200
            && stored.dice_consistent === 1 && stored.att_win_chance === detail.att_win_chance
            && db.prepare('SELECT COUNT(*) n FROM player_race_estimates WHERE player_id=6101').get().n === 2, response);
        let admin = await send('GET', '/intel/player/6101/race-estimate');
        let member = await send('GET', '/intel/player/6101/race-estimate', null, 'user');
        ok('shadow distributions remain admin-only through real endpoint', admin.body.estimate?.attack.evidence_count === 1
            && member.body.estimate === null && member.body.resolution.source === 'worst');
        ok('unauthenticated member view is rejected', (await send('GET', '/intel/player/6101/race-estimate', null, null)).status === 401);
        const queued = await send('POST', '/intel/race/6101/check-request', {}, 'user');
        ok('member approval receipt never starts a paid call', queued.status === 200 && queued.body.request.status === 'pending'
            && db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === 0, queued);
        ok('check-request queue is not swallowed by the generic admin player route', Array.isArray((await send('GET', '/admin/race/check-requests')).body.requests));
        ok('guests cannot enqueue approval', (await send('POST', '/intel/race/6101/check-request', {}, 'guest')).status === 403);
        db.prepare(`INSERT INTO player_race_checks(player_id,request_id,input_hash,model_version,prompt_version,model,verdict,output,status)
            VALUES(6101,?,? ,?,'synthetic','synthetic','disagrees',?,'ok')`).run(queued.body.request.id, 'a'.repeat(64), version,
            JSON.stringify({ explanation: 'SECRET_HELD_ESTIMATE +2', trait_checks: [], confidence_adjustment: { direction: 'none', traits: [] } }));
        admin = await send('GET', '/intel/player/6101/race-estimate');
        member = await send('GET', '/intel/player/6101/race-estimate', null, 'user');
        ok('held output stays available to admins and absent from member payloads', admin.body.check.state === 'held'
            && !JSON.stringify(member.body).includes('SECRET_HELD_ESTIMATE') && member.body.estimate === null);
        const before = db.prepare('SELECT total_changes() n').get().n;
        const replies = [];
        await require('../discord_bot').handleMessage({ content: '!race Synthetic Subject', author: { bot: false, username: 'Synthetic' },
            channel: { id: 'synthetic' }, reply: async message => replies.push(message) });
        ok('Discord stored-race summary reads without writes or provider calls', replies.length === 1
            && /Worst case/.test(replies[0]) && db.prepare('SELECT total_changes() n').get().n === before && db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === 0, replies);
        db.prepare("INSERT INTO llm_calls(model,cost_usd,status) VALUES('synthetic',0.01,'ok')").run();
        response = await send('POST', '/admin/nuke-intel', { password: 'synthetic-sync-password', label: 'Synthetic round' });
        ok('real round reset deletes all race state and history while preserving cost accounting', response.status === 200
            && ['race_evidence','player_race_estimates','race_estimate_calibrations','player_race_checks','llm_requests','player_public_history','planet_starbase_history','player_combat_history']
                .every(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n === 0)
            && db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === 1, response);
    } catch (error) { failed++; console.error(error); }
    finally { server.close(() => { db.close(); fs.rmSync(temporary, { recursive: true, force: true }); process.exitCode = failed ? 1 : 0; }); }
});
