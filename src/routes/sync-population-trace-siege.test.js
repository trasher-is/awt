// population_trace records the siege state around every population change: what the hub held before
// the read, what it holds after it, and the besieger's name when a live page named one.
//
// Why: two planets of one player each lost one population in a single read while a hostile siege sat
// on both, and nothing could say whether the siege had begun in that same read or hours earlier —
// `planets` only holds the current flag. A siege is the obvious suspect (it is the only visible
// thing that changed), and the next such drop must be able to confirm or clear it.
//
// Drives the REAL /sync/system transaction against a scratch database with synthetic ids and names
// (the repository is public). No game or Discord requests are made.
//
// Run with: node src/routes/sync-population-trace-siege.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-trace-siege-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'test.db');
// These tests are about what a drop DOES (attribution, alerts, the trace), not about the confirmation delay,
// so they run with it off. The delay itself is covered by sync-population-provisional-drop.test.js.
process.env.POP_DROP_CONFIRM_MS = '0';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: {
    announceSystemChanges: async () => {},
    announceSystemMilestones: async () => {},
} };
const express = require('express');
const db = require('../database');
const populationTraceRepo = require('../repositories/populationTrace');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Tester' }; next(); });
app.use('/hub-api', require('./sync'));

let failed = 0;
function ok(name, condition, detail) {
    console.log(`  ${condition ? 'ok' : 'NOT OK'} - ${name}${!condition && detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`);
    if (!condition) failed++;
}
const owner = { id: 5201, name: 'SiegeOwner' };
const rows = systemId => db.prepare('SELECT * FROM population_trace WHERE system_id=? AND planet_index=1 ORDER BY id').all(systemId);
const siege = r => r && [r.sieged_before, r.siege_friendly_before, r.sieged_after, r.siege_friendly_after, r.siege_attacker];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const sync = async (systemId, planet) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/hub-api/sync/system`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: systemId, planets: [{ planet_index: 1, starbase: 0, owner, ...planet }], source: 'api-seed', observation_live: false }),
        });
        if (!response.ok) throw new Error(`Sync failed: ${response.status} ${await response.text()}`);
        return response.json();
    };

    try {
        console.log('sync-population-trace-siege.test.js');

        console.log('\n── schema ' + '─'.repeat(64));
        const cols = new Set(db.prepare('PRAGMA table_info(population_trace)').all().map(c => c.name));
        const wanted = ['sieged_before', 'siege_friendly_before', 'sieged_after', 'siege_friendly_after', 'siege_attacker'];
        ok('a fresh database has the five siege columns', wanted.every(c => cols.has(c)), wanted.filter(c => !cols.has(c)));

        console.log('\n── a drop records the siege around it ' + '─'.repeat(36));
        await sync(5200, { population: 6, is_sieged: 0 });
        await sync(5200, { population: 5, is_sieged: 0 });
        ok('no siege before or after: 0 / 0, nothing else',
            same(siege(rows(5200)[0]), [0, null, 0, null, null]), siege(rows(5200)[0]));

        await sync(5201, { population: 6, is_sieged: 0 });
        await sync(5201, { population: 5, is_sieged: 1, siege_is_friendly: false, siege_attacker_name: 'SyntheticBesieger' });
        ok('a siege that first shows up in the same read as the drop: 0 before, hostile after, with the besieger\'s name',
            same(siege(rows(5201)[0]), [0, null, 1, 0, 'SyntheticBesieger']), siege(rows(5201)[0]));

        await sync(5202, { population: 6, is_sieged: 1, siege_is_friendly: false });
        await sync(5202, { population: 5, is_sieged: 1 });
        ok('already hostile-sieged before the drop: the allegiance the page settled earlier is carried through',
            same(siege(rows(5202)[0]), [1, 0, 1, 0, null]), siege(rows(5202)[0]));

        await sync(5203, { population: 6, is_sieged: 0 });
        await sync(5203, { population: 5, is_sieged: 1 });
        ok('an API-style hasSiege with no allegiance: sieged after, allegiance left NULL (not guessed)',
            same(siege(rows(5203)[0]), [0, null, 1, null, null]), siege(rows(5203)[0]));

        await sync(5204, { population: 6, is_sieged: 1, siege_is_friendly: false });
        await sync(5204, { population: 5, is_sieged: 0 });
        ok('a siege that lifts in the same read: hostile before, none after, allegiance cleared',
            same(siege(rows(5204)[0]), [1, 0, 0, null, null]), siege(rows(5204)[0]));

        await sync(5207, { population: 6, is_sieged: 1, siege_is_friendly: true });
        await sync(5207, { population: 5, is_sieged: 1, siege_attacker_name: 'SyntheticAlly' });
        ok('a friendly siege is recorded as friendly (1), with the name the page gave',
            same(siege(rows(5207)[0]), [1, 1, 1, 1, 'SyntheticAlly']), siege(rows(5207)[0]));

        await sync(5208, { population: 6, is_sieged: 0 });
        await sync(5208, { population: 5, is_sieged: 0, siege_attacker_name: 'LeftoverName' });
        ok('a besieger\'s name is only kept while a siege is actually reported', rows(5208)[0].siege_attacker === null, rows(5208)[0]);

        console.log('\n── rises carry it too ' + '─'.repeat(52));
        await sync(5205, { population: 6, is_sieged: 1, siege_is_friendly: false });
        db.prepare('UPDATE planets SET population_observed_at=? WHERE system_id=5205').run(new Date(Date.now() - 48 * 3600000).toISOString());
        await sync(5205, { population: 7, is_sieged: 1 });
        const rise = rows(5205)[0];
        ok('an accepted rise records the siege state too', rise.outcome === 'rise' && same(siege(rise), [1, 0, 1, 0, null]), rise);

        console.log('\n── a refused rise repeats only until the siege state changes ' + '─'.repeat(13));
        await sync(5206, { population: 6, is_sieged: 0 });
        await sync(5206, { population: 7, is_sieged: 0 });
        await sync(5206, { population: 7, is_sieged: 0 });
        ok('the identical refusal is still written once', rows(5206).length === 1 && rows(5206)[0].outcome === 'rise_rejected', rows(5206).length);
        await sync(5206, { population: 7, is_sieged: 1 });
        ok('the same claim after a siege appeared IS a new row (the siege is the new information)',
            rows(5206).length === 2 && rows(5206)[1].sieged_before === 0 && rows(5206)[1].sieged_after === 1, rows(5206).map(siege));
        await sync(5206, { population: 7, is_sieged: 1 });
        ok('...and repeats of that are deduped again', rows(5206).length === 2, rows(5206).length);

        console.log('\n── old rows and callers without siege context ' + '─'.repeat(28));
        db.prepare("INSERT INTO systems (id) VALUES (5209) ON CONFLICT DO NOTHING").run();
        db.prepare(`INSERT INTO population_trace (system_id, planet_index, outcome, source, observation) VALUES (5209, 1, 'drop', 'api-seed', 'live')`).run();
        ok('a row written before this existed has NULL siege fields', same(siege(rows(5209)[0]), [null, null, null, null, null]), siege(rows(5209)[0]));
        populationTraceRepo.recordPopulationChange({
            system_id: 5209, planet_index: 1, owner_id: null, outcome: 'drop', old_pop: 3, claimed_pop: 2, stored_pop: 2,
            hours_since_change: 1, source: 'api-seed', observation: 'live', captured_at: null, actor_user_id: 1, actor_game_name: 'Tester',
        });
        ok('the repository still writes a row from a caller that passes no siege context', rows(5209).length === 2, rows(5209).length);

        console.log('\n── wiring ' + '─'.repeat(64));
        const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const sync_js = strip(fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8'));
        // Every call to tracePopulation (not its definition) must hand over a siege state built from
        // THIS planet's values: either traceSiege(oldP, finalIsSieged, ...) inline, or the `siegeNow`
        // built from exactly that call a few lines earlier (the provisional-drop rows share one).
        const calls = [];
        for (let at = sync_js.indexOf('tracePopulation('); at !== -1; at = sync_js.indexOf('tracePopulation(', at + 1)) {
            if (/const\s+tracePopulation\s*=\s*$/.test(sync_js.slice(Math.max(0, at - 40), at).replace(/\s+$/, '') + '')
                || /const tracePopulation =/.test(sync_js.slice(Math.max(0, at - 20), at + 16))) continue;
            calls.push(sync_js.slice(at, sync_js.indexOf(');', at) + 2));
        }
        const siegeFromThisPlanet = 'traceSiege(oldP, finalIsSieged, finalSiegeIsFriendly, p.siege_attacker_name)';
        const builtOnce = (sync_js.match(/const siegeNow = traceSiege\(oldP, finalIsSieged, finalSiegeIsFriendly, p\.siege_attacker_name\)/g) || []).length;
        ok('every population change recorded in /sync/system passes the siege state computed for that same planet',
            calls.length >= 2 && builtOnce === 1
                && calls.every(c => c.includes(siegeFromThisPlanet) || /,\s*siegeNow\)/.test(c)),
            { calls: calls.length, builtOnce, offenders: calls.filter(c => !(c.includes(siegeFromThisPlanet) || /,\s*siegeNow\)/.test(c))) });
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failed) { console.error(`${failed} check(s) failed`); process.exitCode = 1; }
    else console.log('All checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
