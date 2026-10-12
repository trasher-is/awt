// Invented profiles through the real SQLite repositories and local sync routers.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-current-intel-'));
process.env.AWT_DB_PATH = path.join(temporary, 'synthetic.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-restart-password';
process.env.RACE_LLM = '0';
delete process.env.DISCORD_TOKEN; delete process.env.BATTLE_DISCORD_TOKEN;
const db = require('../database');
const players = require('../repositories/players');
const model = require('../../public/js/utils/battle-model');
const inference = require('./race-inference-service');
const battleRace = require('../repositories/battleRace');
const { observedCombatSciences, truePower } = require('./true-power');
const { allySide } = require('./incoming-battle');
const express = require('express');
let failed = 0;
function ok(name, condition, detail) { console.log(`${condition ? 'ok' : 'NOT OK'} - ${name}`); if (!condition) { failed++; if (detail) console.error(JSON.stringify(detail)); } }
const profile = (id, joined = '2026-09-01', has_intel = 1) => ({ id, name: 'Invented subject ' + id,
    alliance_id: null, level: 20, points: 100, ranking: null, country: null, is_active_player: 1, joined, logins: 80,
    last_activity_at: null, last_login_at: null, resigned_at: null, number_of_battles: 0, battle_luckiness: 0,
    multi_status: 0, is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
    biology: 12, economy: 12, energy: 12, mathematics: 12, physics: 12, social: 12,
    trade_revenue: 0, artefact: null, race_growth: 0, race_science: 0, race_culture: 0, race_production: 0,
    race_speed: 0, race_attack: -3, race_defense: -2, race_trader: 0, race_sul: 0, has_intel });
const read = id => db.prepare('SELECT * FROM players WHERE id=?').get(id);
function seed(id) { players.upsertPlayerFromApiDetail(profile(id)); db.prepare("UPDATE players SET science_level=14,intel_updated_at='2026-09-02 12:00:00' WHERE id=?").run(id); }
const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.session = { userId: 1, role: 'admin' }; next(); });
app.use('/hub-api', require('../routes/sync'));
const server = app.listen(0, '127.0.0.1');
const post = (endpoint, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/hub-api' + endpoint,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(data);
});
server.once('listening', async () => {
    try {
        seed(7101); const historical = read(7101); players.resetPlayerOnRestart(7101);
        let row = read(7101);
        const historicalFields = ['has_intel', 'intel_updated_at', 'biology', 'economy', 'energy', 'mathematics', 'physics', 'social',
            'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed', 'race_attack', 'race_defense', 'race_trader', 'race_sul',
            'artefact', 'eco_bonus', 'trade_revenue'];
        ok('a heuristic preserves every historic race/science value and its intel stamp', historicalFields.every(field => row[field] === historical[field]));
        ok('bio before the heuristic cutoff cannot be used as current intel', model.resolveStats(row).source === 'worst');
        ok('stale bio does not lock either race estimator', inference.recompute(7101).status === 'updated' && battleRace.updateBattleRace(7101).status === 'updated');
        const display = require('./race-display').raceDisplay(7101, { role: 'admin' });
        ok('the member policy does not advertise pre-cutoff bio as authoritative', !display.has_bio && display.player.has_intel === 0 && display.resolution.source === 'worst');
        ok('combat SELECTs preserve identity and cutoff for incoming calculations', players.getPlayerCombatStatsById(7101).id === 7101 && model.resolveStats(players.getPlayerCombatStatsById(7101)).source === 'worst');
        const staleSheet = { ...row, sheet_physics: 30, sheet_mathematics: 30, sheet_sciences_updated_at: '2026-09-02 13:00:00' };
        ok('neither old bio nor old member-sheet sciences are reused after cutoff', observedCombatSciences(staleSheet).physics === null && truePower(staleSheet).tp === null && allySide(staleSheet).ra === 0);
        db.prepare('UPDATE players SET intel_updated_at=battle_race_not_before WHERE id=7101').run();
        ok('fresh intel at exactly the heuristic cutoff remains usable', model.hasCurrentIntel?.(read(7101)) === true);
        const equal = { has_intel: 1, joined: '2026-10-01', battle_race_not_before: '2026-10-01 01:00:00', intel_updated_at: '2026-10-01T03:00:00+02:00' };
        const oldTZ = process.env.TZ;
        process.env.TZ = 'Pacific/Honolulu'; const west = model.hasCurrentIntel?.(equal);
        process.env.TZ = 'Europe/Warsaw'; const east = model.hasCurrentIntel?.(equal);
        if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;
        const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/utils/battle-model.js'), 'utf8'), context);
        ok('SQLite UTC and explicit offset equality agree across Node zones and browser realm', west === true && east === true && context.AWBattleModel.hasCurrentIntel?.(equal) === true);

        ok('fractional Joined does not reject fresh bio recorded in the same SQLite second', model.hasCurrentIntel?.({
            has_intel: 1, joined: '2026-10-01T01:00:00.999Z', intel_updated_at: '2026-10-01 01:00:00' }) === true);

        seed(7102);
        for (const joined of [null, '', '03/10/2026', '2026-02-30', '2099-01-01', '2026-08-01']) {
            players.upsertPlayerFromApiList(7102, 'Invented subject', null, 20, 100, null, null, 1, joined);
            row = read(7102);
            ok('missing, malformed, future or older Joined cannot invalidate or regress confirmed intel', row.joined === '2026-09-01' && row.has_intel === 1 && row.race_attack === -3 && row.battle_race_not_before === null, joined);
        }
        let result = await post('/sync/player-list', { players: [{ id: 7102, name: 'Invented subject', level: 1, joined: 'N/A' }] });
        row = read(7102);
        ok('real API list confirms resign without deleting historical bio values', result.status === 200 && row.joined === 'N/A' && row.has_intel === 0 && row.race_attack === -3 && row.physics === 12 && row.intel_updated_at === '2026-09-02 12:00:00' && !!row.battle_race_not_before, result);
        const resignCutoff = row.battle_race_not_before;
        players.upsertPlayerFromApiList(7102, 'Invented subject', null, 0, 0, null, null, 0, 'N/A');
        ok('repeat resigned observations do not move the evidence cutoff', read(7102).battle_race_not_before === resignCutoff);
        ok('resigned profiles cannot create a new race estimate', inference.recompute(7102).status === 'resigned'
            && db.prepare('SELECT COUNT(*) n FROM player_race_estimates WHERE player_id=7102').get().n === 0);
        players.upsertPlayerFromApiList(7102, 'Invented subject', null, 20, 100, null, null, 1, '2026-09-01');
        ok('an old pre-resign Joined page cannot resurrect the previous incarnation', read(7102).joined === 'N/A' && read(7102).has_intel === 0);
        const today = new Date().toISOString().slice(0, 10);
        result = await post('/sync/player-list', { players: [{ id: 7102, name: 'Invented subject', level: 1, joined: today }] });
        ok('confirmed rejoin remains unknown until new bio is observed', result.status === 200 && read(7102).joined === today && read(7102).has_intel === 0);

        seed(7103);
        const fresh = { ...profile(7103, today), race_attack: 2, race_defense: 3, physics: 2, mathematics: 3 };
        result = await post('/sync/player-detail', { player: fresh }); row = read(7103);
        ok('a later Joined with fresh bio in the same API sync replaces the prior race', result.status === 200 && row.race_attack === 2 && row.race_defense === 3 && row.physics === 2 && row.has_intel === 1 && model.hasCurrentIntel?.(row) === true, { result, race: row.race_attack });
        result = await post('/sync/player-detail', { player: { ...fresh, race_attack: -4, physics: 4 } }); row = read(7103);
        ok('ordinary same-incarnation API scans still cannot rewrite recorded race', result.status === 200 && row.race_attack === 2 && row.physics === 4);
        seed(7104); players.resetPlayerOnRestart(7104);
        result = await post('/sync/player-detail', { player: { ...profile(7104), race_attack: 4, physics: 1 } }); row = read(7104);
        ok('a new genuine bio after the heuristic can refresh historical race without destructive reset', result.status === 200 && row.race_attack === 4 && row.physics === 1 && model.hasCurrentIntel?.(row) === true);
        seed(7105);
        players.upsertPlayerFromApiDetail({ ...profile(7105, today, 0), physics: null, mathematics: null }); row = read(7105);
        ok('real API detail rejoin without vision marks old bio historical and retains its values', row.has_intel === 0 && row.race_attack === -3 && row.physics === 12 && row.joined === today && model.resolveStats(row).source === 'worst');
        seed(7106); db.prepare('UPDATE players SET joined=NULL WHERE id=7106').run();
        result = await post('/sync/player-detail', { player: { ...profile(7106, today), race_attack: 1 } });
        ok('a newly learned Joined after the old bio stamp cannot freeze a previous race', result.status === 200 && read(7106).race_attack === 1 && model.hasCurrentIntel(read(7106)));
        inference.flush();
    } catch (error) { failed++; console.error(error); }
    finally { server.close(() => { db.close(); fs.rmSync(temporary, { recursive: true, force: true }); process.exitCode = failed ? 1 : 0; }); }
});
