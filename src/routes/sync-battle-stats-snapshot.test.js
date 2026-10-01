// Per-battle stats snapshot: when /sync/battle-reports stores a NEW report it also records both
// sides' race attack/defense, physics, mathematics and player level as the hub knows them then.
//
// Why: the model inputs a battle needs are not on the report, and the players table only holds the
// CURRENT value. Physics and maths climb several levels in a day or two, so a report read a day
// later cannot be replayed through the real in-game calculator with any confidence. Capturing at
// sync time keeps the stats within hours of the battle, and *_intel_at says how old they already were.
//
// Drives the REAL route against a scratch database. Everything here is synthetic (invented ids and
// names); the repository is public and a real report carries other players' names and stats.
//
// Run with: node src/routes/sync-battle-stats-snapshot.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-battle-stats-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);

function postJson(server, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const addPlayer = db.prepare(`INSERT INTO players
    (id, name, has_intel, race_attack, race_defense, physics, mathematics, level, intel_updated_at)
    VALUES (@id, @name, @has_intel, @ra, @rd, @phys, @math, @lvl, @iu)`);
const report = (id, attId, defId) => ({
    id, startedAt: '2026-10-01T10:00:00Z', winner: 'Attacker',
    attacker: { playerId: attId, playerName: `Att${id}` },
    defender: { playerId: defId, playerName: `Def${id}` },
});
const row = id => db.prepare('SELECT * FROM battle_reports WHERE id = ?').get(id);

(async () => {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    try {
        console.log('sync-battle-stats-snapshot.test.js');

        console.log('\n── schema ' + '─'.repeat(64));
        const cols = new Set(db.prepare('PRAGMA table_info(battle_reports)').all().map(c => c.name));
        const wanted = ['stats_snapshot_at'];
        for (const s of ['att', 'def']) wanted.push(...['race_attack', 'race_defense', 'physics', 'mathematics', 'player_level', 'intel_at'].map(c => `${s}_${c}`));
        ok('a fresh database has all 13 snapshot columns', wanted.every(c => cols.has(c)), wanted.filter(c => !cols.has(c)));

        console.log('\n── a new report records both sides ' + '─'.repeat(39));
        addPlayer.run({ id: 8001, name: 'SyntheticAtt', has_intel: 1, ra: 2, rd: -1, phys: 14, math: 12, lvl: 6, iu: '2026-10-01 08:00:00' });
        addPlayer.run({ id: 8002, name: 'SyntheticDef', has_intel: 1, ra: 0, rd: 0, phys: 0, math: 0, lvl: 1, iu: '2026-10-01 07:30:00' });
        const r1 = await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70001, 8001, 8002)] });
        ok('the sync succeeds', r1.status === 200 && r1.body && r1.body.success !== false, r1);
        const a = row(70001);
        ok('the attacker\'s race, sciences and level are stored',
            a.att_race_attack === 2 && a.att_race_defense === -1 && a.att_physics === 14 && a.att_mathematics === 12 && a.att_player_level === 6, a);
        ok('...with how old that read was', a.att_intel_at === '2026-10-01 08:00:00', a.att_intel_at);
        ok('the defender\'s are stored too, and a real 0 stays 0 (never NULL)',
            a.def_race_attack === 0 && a.def_race_defense === 0 && a.def_physics === 0 && a.def_mathematics === 0 && a.def_player_level === 1, a);
        ok('the capture time is stamped', typeof a.stats_snapshot_at === 'string' && a.stats_snapshot_at.length > 0, a.stats_snapshot_at);

        console.log('\n── unknown players are NULL, not zero ' + '─'.repeat(36));
        // has_intel = 0 rows can still carry stale numbers; they must not be trusted.
        addPlayer.run({ id: 8003, name: 'NoIntel', has_intel: 0, ra: 3, rd: 3, phys: 9, math: 9, lvl: 4, iu: '2026-09-01 00:00:00' });
        await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70002, 8003, 8999)] });
        const b = row(70002);
        const statCols = c => ['race_attack', 'race_defense', 'physics', 'mathematics', 'player_level', 'intel_at'].map(k => c + '_' + k);
        ok('a player without intel records NULL for every stat, whatever stale numbers the row holds',
            statCols('att').every(k => b[k] === null), b);
        ok('a player id the hub has never seen records NULL too', statCols('def').every(k => b[k] === null), b);
        ok('...but the capture time is still set, so "no intel" is distinguishable from a legacy row', b.stats_snapshot_at !== null);
        await postJson(server, '/hub-api/sync/battle-reports', { reports: [{ id: 70003, startedAt: '2026-10-01T10:00:00Z', winner: 'Defender' }] });
        const c = row(70003);
        ok('a report with no player ids at all is stored and snapshotted with NULL stats',
            c && c.stats_snapshot_at !== null && statCols('att').concat(statCols('def')).every(k => c[k] === null), c);

        console.log('\n── captured once, never rewritten, never backfilled ' + '─'.repeat(22));
        db.prepare('UPDATE players SET physics = 20, intel_updated_at = ? WHERE id = 8001').run('2026-10-03 12:00:00');
        const stamp = row(70001).stats_snapshot_at;
        await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70001, 8001, 8002)] });
        const again = row(70001);
        ok('re-syncing the same report after the player\'s stats moved changes nothing',
            again.att_physics === 14 && again.att_intel_at === '2026-10-01 08:00:00' && again.stats_snapshot_at === stamp, again);

        db.prepare(`INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, winner) VALUES (70004, '2026-09-20T10:00:00Z', 8001, 8002, 'Attacker')`).run();
        await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70004, 8001, 8002)] });
        const legacy = row(70004);
        ok('a report stored before this existed is NOT backfilled with today\'s stats',
            legacy.stats_snapshot_at === null && statCols('att').every(k => legacy[k] === null), legacy);

        const both = await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70001, 8001, 8002), report(70005, 8001, 8002)] });
        ok('a batch mixing a known and a new report snapshots only the new one',
            row(70005).att_physics === 20 && row(70001).att_physics === 14, [row(70005), row(70001)].map(r => r.att_physics));

        console.log('\n── a failed capture never costs the sync ' + '─'.repeat(33));
        // Real failure: the players lookup cannot run. The report must still be stored and the sync succeed.
        const realError = console.error; const logged = [];
        console.error = (...args) => logged.push(args.join(' '));
        db.exec('ALTER TABLE players RENAME TO players_hidden');
        let r6;
        try { r6 = await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70006, 8001, 8002)] }); }
        finally { db.exec('ALTER TABLE players_hidden RENAME TO players'); console.error = realError; }
        ok('the sync still answers 200', r6 && r6.status === 200, r6);
        const f = row(70006);
        ok('...the report is stored, with no snapshot', f && f.stats_snapshot_at === null && f.att_physics === null, f);
        ok('...and the failure is logged, not thrown', logged.some(l => l.includes('[BattleStats] snapshot failed')), logged);
        await postJson(server, '/hub-api/sync/battle-reports', { reports: [report(70007, 8001, 8002)] });
        ok('once the table is back, the next report is captured normally', row(70007).att_physics === 20, row(70007));

        console.log('\n── wiring ' + '─'.repeat(64));
        const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const sync = strip(fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8'));
        const upsertAt = sync.indexOf('upsertReports(db, rows)');
        const snapAt = sync.indexOf('snapshotStatsForReports(inserted.map(');
        ok('/sync/battle-reports snapshots exactly the rows upsertReports just inserted, right after it',
            upsertAt !== -1 && snapAt > upsertAt && snapAt - upsertAt < 200, { upsertAt, snapAt });
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failed) { console.error(`${failed} check(s) failed`); process.exitCode = 1; }
    else console.log('All checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
