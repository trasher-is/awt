// Exercise the real database and HTTP boundary with invented players and reports only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-battle-race-route-'));
process.env.AWT_DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const players = require('../repositories/players');
const repo = require('../repositories/battleRace');
const router = require('./battleRace');
const { blockGuestWrites } = require('./_middleware');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`, detail === undefined ? '' : detail); }
}
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    if (req.headers['x-test-role']) req.session = { userId: 1, role: req.headers['x-test-role'] };
    next();
});
app.use('/hub-api', blockGuestWrites, router);
// Intel is recorded two hours before the synthetic battle below, inside the known-side window.
const insertPlayer = db.prepare(`INSERT INTO players
    (id, name, has_intel, race_attack, race_defense, physics, mathematics, intel_updated_at, joined,
     science_level, level)
    VALUES (?, ?, ?, ?, ?, 20, 21, '2026-09-05 10:00:00', '2026-08-29T00:00:00Z', 15, 20)`);
insertPlayer.run(1, 'Synthetic unknown', 0, 0, 0);
insertPlayer.run(2, 'Synthetic bio', 1, 0, 0);
insertPlayer.run(3, 'Synthetic restart', 0, 0, 0);
const core = id => db.prepare(`SELECT has_intel, race_attack, race_defense, physics, mathematics,
    intel_updated_at, updated_at FROM players WHERE id = ?`).get(id);
const getPlayer = id => db.prepare('SELECT * FROM players WHERE id = ?').get(id);

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/hub-api/intel/player/`;
    async function request(id, method = 'GET', role = 'user', payload = {}) {
        const res = await fetch(`${base}${id}/battle-race-inference`, {
            method, headers: { ...(role ? { 'X-Test-Role': role } : {}), 'Content-Type': 'application/json' },
            ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        });
        return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
    }
    try {
        for (const method of ['GET', 'POST']) {
            ok(`${method} requires authentication`, (await request(1, method, null)).status === 401);
            ok(`${method} rejects malformed IDs`, (await request('1abc', method)).status === 400);
            ok(`${method} rejects unsafe IDs`, (await request('9007199254740992', method)).status === 400);
            ok(`${method} reports missing players`, (await request(999, method)).status === 404);
        }
        ok('guests may read analyses', (await request(1, 'GET', 'guest')).status === 200);
        ok('guests cannot recalculate shared intelligence', (await request(1, 'POST', 'guest')).status === 403);
        const before = JSON.stringify(core(1));
        const result = await request(1, 'POST', 'user', { race_attack: 4, race_defense: 4, has_intel: 1,
            inference: { status: 'certain' }, reports: [{ id: 999 }] });
        ok('empty evidence is a successful honest analysis', result.status === 200 && result.body.inference.status === 'insufficient', result);
        ok('client-provided reports and candidates are ignored', result.body.inference.report_count === 0);
        ok('recalculation never changes confirmed-field values or freshness', JSON.stringify(core(1)) === before);
        ok('result is stored with its own time and account boundary', !!getPlayer(1).battle_race_inference
            && result.body.inference.updated_at.endsWith('Z') && result.body.inference.not_before === '2026-08-29T00:00:00.000Z');
        const read = await request(1);
        ok('saved analysis survives later profile reads', read.body.inference.updated_at === result.body.inference.updated_at);
        ok('GET prevents private intelligence from being cached', read.cache === 'no-store');

        const bioBefore = JSON.stringify(getPlayer(2));
        const locked = await request(2, 'POST');
        ok('bio blocks writes even for neutral zero race picks', locked.status === 409 && locked.body.has_bio && locked.body.inference === null);
        ok('blocked request leaves every bio field untouched', JSON.stringify(getPlayer(2)) === bioBefore);
        players.upsertPlayerFromApiDetail({ ...getPlayer(1), has_intel: 1, race_attack: 3, race_defense: -2 });
        ok('bio that arrives after the page loaded wins at POST time', (await request(1, 'POST')).status === 409);
        ok('later bio hides the previous inference', (await request(1)).body.inference === null);
        ok('later bio remains unchanged', core(1).race_attack === 3 && core(1).race_defense === -2);

        // Complete ship details from a synthetic winner: the API and detail scraper
        // jointly supply these columns in production, including a free-text winner.
        const report = { id: 101, started_at: '2026-09-05T12:00:00Z', is_public: 1,
            att_player_id: 3, def_player_id: 2, att_has_won: 1, def_has_won: 0,
            winner: 'Synthetic restart', att_combat_value: 300, def_combat_value: 300,
            att_lost_cv: 270, att_survived_cv: 30 };
        for (const side of ['att', 'def']) {
            for (const ship of ['destroyers', 'cruisers', 'battleships', 'transports', 'colony_ships', 'starbases']) {
                report[`${side}_${ship}`] = ship === 'destroyers' ? 100 : 0;
                report[`${side}_${ship}_lost`] = side === 'att' && ship === 'destroyers' ? 90 : 0;
            }
        }
        db.prepare(`INSERT INTO battle_reports (${Object.keys(report).join(',')})
            VALUES (${Object.keys(report).map(key => '@' + key).join(',')})`).run(report);
        // The same winner against a player the hub has no row for: no known side.
        db.prepare(`INSERT INTO battle_reports (${Object.keys(report).join(',')})
            VALUES (${Object.keys(report).map(key => '@' + key).join(',')})`).run({ ...report, id: 102, def_player_id: 4 });
        const evidenceResult = await request(3, 'POST');
        ok('stored winning ship evidence narrows a DEF range through the real HTTP path',
            evidenceResult.body.inference.defense.status === 'compatible'
            && evidenceResult.body.inference.eligible_report_count === 1, evidenceResult);
        ok('the opponent\'s stored bio intel is the known side, and a positive pick can be shown',
            evidenceResult.body.inference.defense.candidates.join(',') === '1', evidenceResult.body.inference.defense);
        ok('a report against a player without bio is skipped, not guessed',
            evidenceResult.body.inference.skipped.no_known_side === 1, evidenceResult.body.inference.skipped);
        ok('another player cannot borrow the winning-side evidence',
            evidenceResult.body.inference.used_report_ids.join(',') === '101');
        const saved = JSON.parse(getPlayer(3).battle_race_inference);
        db.prepare('UPDATE players SET battle_race_inference = ? WHERE id = 3')
            .run(JSON.stringify({ ...saved, version: 1 }));
        ok('a result saved by the one-sided version 1 is not shown as current', repo.getBattleRace(3).inference === null);
        db.prepare("UPDATE players SET science_level = 0 WHERE id = 3").run();
        ok('an unfilled public science level blocks narrowing instead of acting as a zero ceiling',
            (await request(3, 'POST')).body.inference.skipped.science_level_unknown === 1);
        db.prepare("UPDATE players SET science_level = 15 WHERE id = 3").run();

        await request(3, 'POST');
        db.prepare("UPDATE players SET joined = '2026-09-10T00:00:00Z' WHERE id = 3").run();
        ok('changed Joined boundary invalidates saved candidates', repo.getBattleRace(3).inference === null);
        const refreshed = await request(3, 'POST');
        ok('recalculation uses the later Joined timestamp', refreshed.body.inference.not_before === '2026-09-10T00:00:00.000Z');
        ok('battles before the new race do not constrain the range', refreshed.body.inference.eligible_report_count === 0
            && refreshed.body.inference.skipped.before_current_player === 2);
        db.prepare("UPDATE players SET joined = '2026-08-29T00:00:00Z' WHERE id = 3").run();
        players.resetPlayerOnRestart(3);
        ok('restart clears the inference and records a new evidence boundary', getPlayer(3).battle_race_inference === null && !!getPlayer(3).battle_race_not_before);
        ok('restart cannot promote unknown race to bio', core(3).has_intel === 0);
        db.prepare("UPDATE players SET science_level = 15, level = 20 WHERE id = 3").run();
        const afterRestart = await request(3, 'POST');
        ok('battles before a detected restart do not constrain the new race',
            afterRestart.body.inference.eligible_report_count === 0
            && afterRestart.body.inference.skipped.before_current_player === 2, afterRestart.body.inference);

        db.prepare("UPDATE players SET battle_race_inference = '{broken' WHERE id = 3").run();
        ok('malformed old saved analysis degrades to no estimate', (await request(3)).body.inference === null);
        db.prepare("UPDATE players SET joined = '10/09/2026', battle_race_not_before = NULL WHERE id = 3").run();
        const localized = await request(3, 'POST');
        ok('localized Joined is not guessed using the machine timezone', localized.body.inference.not_before === null);
        db.prepare("UPDATE players SET joined = '2026-02-30T00:00:00Z' WHERE id = 3").run();
        ok('impossible Joined dates are not silently rolled into another month', (await request(3, 'POST')).body.inference.not_before === null);

        process.env.TARGET_URL = 'https://redzone.astrowars.games';
        const redzone = await request(3, 'POST');
        ok('RedZone cannot receive standard-universe conclusions', redzone.body.inference.status === 'insufficient');
        delete process.env.TARGET_URL;
        db.prepare('DELETE FROM players WHERE id = 3').run();
        ok('removing the player removes saved inference at round reset', repo.getBattleRace(3) === null);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (failed) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
