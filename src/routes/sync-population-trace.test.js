// population_trace: every population change /sync/system makes is recorded with the client
// path that sent it, so a wrong figure can be traced to its source.
//
// Why this exists: planet_events only ever logged DROPS. A planet held at a figure the game
// never showed (entered as a RISE, days earlier) surfaced only when a later, correct read
// "dropped" it — and nothing recorded which payload had put the wrong number there.
//
// Everything below is synthetic (invented ids and names); it drives the real /sync/system
// transaction. No game or Discord requests are made.
//
// Run with: node src/routes/sync-population-trace.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-population-trace-'));
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
const { SOURCES, normaliseSource, observationKind } = require('../utils/population-trace');

// A stand-in for the member's session; the x-test-user header lets one case carry a user id
// that does not exist in app_users.
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    const id = req.headers['x-test-user'] ? Number(req.headers['x-test-user']) : 1;
    req.session = { userId: id, gameName: 'Tester' };
    next();
});
app.use('/hub-api', require('./sync'));

let failed = 0;
function ok(name, condition, detail) {
    console.log(`  ${condition ? 'ok' : 'NOT OK'} - ${name}${!condition && detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`);
    if (!condition) failed++;
}
const minutesAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const owner = { id: 5001, name: 'TraceOwner' };
const rows = (systemId, planetIndex = 1) =>
    db.prepare('SELECT * FROM population_trace WHERE system_id=? AND planet_index=? ORDER BY id').all(systemId, planetIndex);
const backdate = (systemId, minutes, planetIndex = 1) =>
    db.prepare('UPDATE planets SET population_observed_at=? WHERE system_id=? AND planet_index=?').run(minutesAgo(minutes), systemId, planetIndex);
const storedPopulation = (systemId, planetIndex = 1) =>
    db.prepare('SELECT population FROM planets WHERE system_id=? AND planet_index=?').get(systemId, planetIndex).population;

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const sync = async (systemId, planet, extra = {}, headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/hub-api/sync/system`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ system_id: systemId, planets: [{ planet_index: 1, starbase: 0, ...planet }], ...extra }),
        });
        if (!response.ok) throw new Error(`Sync failed: ${response.status} ${await response.text()}`);
        return response.json();
    };

    try {
        console.log('sync-population-trace.test.js');

        console.log('\n── labels ' + '─'.repeat(64));
        ok('every known client path is accepted verbatim', [...SOURCES].every(s => normaliseSource(s) === s), [...SOURCES]);
        ok('a client that sends nothing is recorded as unlabelled, not hidden',
            [undefined, null, ''].every(v => normaliseSource(v) === 'unlabelled'));
        ok('anything else — wrong case, a number, a long string — is stored as "other", never verbatim',
            ['DOM-PAGE', 'evil<script>', 123, {}, 'x'.repeat(500)].every(v => normaliseSource(v) === 'other'));
        ok('a cached picture outranks a live claim, matching the stale-observation guard',
            observationKind({ captured_at: '2026-09-13T00:00:00+02:00', observation_live: true }) === 'cached');
        ok('live without a stamp is live; neither is unordered; no body is unordered',
            observationKind({ observation_live: true }) === 'live' && observationKind({}) === 'unordered' && observationKind(null) === 'unordered');

        console.log('\n── a rise, a refused rise and a drop, each with its source ' + '─'.repeat(15));
        const A = 5100;
        await sync(A, { owner, population: 6 });
        ok('the first observation of a planet has no earlier figure, so nothing is traced', rows(A).length === 0, rows(A));

        // Retention runs on the first trace write in a process. Old rows on a spare planet
        // index, so they cannot be confused with the sequence below.
        const seedOld = db.prepare(`INSERT INTO population_trace
            (system_id, planet_index, outcome, source, observation, created_at)
            VALUES (?, 99, 'rise', 'dom-page', 'live', datetime('now', ?))`);
        seedOld.run(A, '-40 days');
        seedOld.run(A, '-10 days');

        backdate(A, 48 * 60);
        await sync(A, { owner, population: 7 }, { source: 'api-seed', observation_live: true });
        const [rise] = rows(A);
        ok('an accepted rise is recorded with old, claimed and stored figures',
            rise && rise.outcome === 'rise' && rise.old_pop === 6 && rise.claimed_pop === 7 && rise.stored_pop === 7, rise);
        ok('...the client path, the observation kind and the reporting member',
            rise && rise.source === 'api-seed' && rise.observation === 'live'
            && rise.actor_user_id === 1 && rise.actor_game_name === 'Tester', rise);
        ok('...and how long the previous figure had stood (48h here)',
            rise && rise.hours_since_change > 47.9 && rise.hours_since_change < 48.1, rise);
        ok('retention: a row past the keep window is pruned, a recent one is kept',
            db.prepare(`SELECT COUNT(*) n FROM population_trace WHERE system_id=? AND planet_index=99`).get(A).n === 1);

        await sync(A, { owner, population: 8 }, { source: 'dom-page' });
        const refused = rows(A).filter(r => r.outcome === 'rise_rejected');
        ok('a rise the regrowth guard refuses is recorded, with what was claimed and what was kept',
            refused.length === 1 && refused[0].old_pop === 7 && refused[0].claimed_pop === 8 && refused[0].stored_pop === 7
            && refused[0].source === 'dom-page' && refused[0].observation === 'unordered', refused);
        ok('...and the stored population really did stay at 7', storedPopulation(A) === 7);

        await sync(A, { owner, population: 8 }, { source: 'dom-page' });
        ok('the same refusal from the same source and member is not written again', rows(A).filter(r => r.outcome === 'rise_rejected').length === 1);
        await sync(A, { owner, population: 8 }, { source: 'api-seed' });
        ok('the same claim from a different source IS a new row (that is the point)',
            rows(A).filter(r => r.outcome === 'rise_rejected').length === 2);

        backdate(A, 5 * 24 * 60);
        await sync(A, { owner, population: 6 }, { source: 'api-update' });
        const drops = rows(A).filter(r => r.outcome === 'drop');
        ok('a drop is recorded with its source and how long the lost figure had stood (5 days here)',
            drops.length === 1 && drops[0].old_pop === 7 && drops[0].claimed_pop === 6 && drops[0].source === 'api-update'
            && drops[0].hours_since_change > 119.9 && drops[0].hours_since_change < 120.1, drops);
        ok('planet_events still logs the drop exactly as before',
            db.prepare('SELECT old_value, new_value FROM planet_events WHERE system_id=? AND event_type_id=2').all(A)
                .some(e => e.old_value === 7 && e.new_value === 6));

        await sync(A, { owner, population: 6 }, { source: 'api-update' });
        ok('an unchanged population adds nothing', rows(A).length === 4, rows(A).map(r => r.outcome));
        ok('getTraceForPlanet returns the same rows, newest first',
            populationTraceRepo.getTraceForPlanet(A, 1).map(r => r.outcome).join() === 'drop,rise_rejected,rise_rejected,rise',
            populationTraceRepo.getTraceForPlanet(A, 1).map(r => r.outcome));

        console.log('\n── cached pictures, odd labels, owner changes ' + '─'.repeat(28));
        const B = 5101, stamp = new Date().toISOString();
        await sync(B, { owner, population: 5 });
        await sync(B, { owner, population: 4 }, { source: 'api-seed', captured_at: stamp });
        const [cachedDrop] = rows(B);
        ok('a cached picture is recorded as cached, with its capture stamp',
            cachedDrop && cachedDrop.observation === 'cached' && cachedDrop.captured_at === stamp, cachedDrop);

        const C = 5102;
        for (const i of [1, 2, 3]) await sync(C, { owner, population: 5, planet_index: i });
        await sync(C, { owner, population: 4, planet_index: 1 });
        await sync(C, { owner, population: 4, planet_index: 2 }, { source: 'evil<script>' });
        await sync(C, { owner, population: 4, planet_index: 3 }, { source: 123 });
        ok('an older client build that sends no label is recorded as unlabelled', rows(C, 1)[0].source === 'unlabelled', rows(C, 1));
        ok('an unrecognised label is recorded as "other", not stored verbatim',
            rows(C, 2)[0].source === 'other' && rows(C, 3)[0].source === 'other', [rows(C, 2), rows(C, 3)]);

        const D = 5103;
        await sync(D, { owner, population: 6 });
        await sync(D, { owner: { id: 5002, name: 'TraceConqueror' }, population: 2 }, { source: 'dom-page' });
        ok('a conquest replaces the owner and population through its own branch and is not a traced rise or drop',
            rows(D).length === 0, rows(D));

        console.log('\n── a failed trace write never costs the sync ' + '─'.repeat(29));
        const E = 5104;
        await sync(E, { owner, population: 5 });
        const realError = console.error; const logged = [];
        console.error = (...args) => logged.push(args.join(' '));
        // 999999 is not an app_users row, so the trace insert violates its foreign key.
        try { await sync(E, { owner, population: 4 }, { source: 'dom-page' }, { 'x-test-user': '999999' }); }
        finally { console.error = realError; }
        ok('the population change is still applied', storedPopulation(E) === 4, storedPopulation(E));
        ok('...and the failed diagnostic write is logged, not thrown',
            logged.some(l => l.includes('[PopulationTrace] write failed')), logged);
        ok('...and left no trace row', rows(E).length === 0);

        console.log('\n── round reset ' + '─'.repeat(59));
        ok('trace rows exist for the system before it is removed', rows(A).length > 0);
        db.prepare('DELETE FROM systems WHERE id=?').run(A);
        ok('removing a system (a round reset) takes its trace with it',
            db.prepare('SELECT COUNT(*) n FROM population_trace WHERE system_id=?').get(A).n === 0);

        console.log('\n── every client path stamps a label the server knows ' + '─'.repeat(21));
        const root = path.join(__dirname, '..', '..');
        const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const read = rel => strip(fs.readFileSync(path.join(root, rel), 'utf8'));
        const expected = [
            ['public/js/scrapers/system-parser.js', ['dom-fetch', 'dom-page']],
            ['public/js/scrapers/api-galaxy-seed.js', ['api-seed']],
            ['public/js/ui/travel-calc-ui.js', ['api-update']],
        ];
        for (const [file, labels] of expected) {
            const found = [...read(file).matchAll(/\bsource(?::|\s*=)\s*'([^']+)'/g)].map(m => m[1]).sort();
            ok(`${file} stamps ${labels.join(' + ')}`, JSON.stringify(found) === JSON.stringify([...labels].sort()), found);
            ok(`...and the server accepts each of them`, found.every(l => SOURCES.has(l)), found);
        }
        // A new client that posts to /sync/system without a label would show up as
        // "unlabelled" in the trace, indistinguishable from a stale browser tab.
        const covered = expected.map(([file]) => path.basename(file));
        const posters = ['public/js/scrapers', 'public/js/ui', 'public/js/core', 'public/js/utils']
            .flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => [dir, f]))
            .filter(([dir, f]) => /hub-api\/sync\/system'/.test(strip(fs.readFileSync(path.join(root, dir, f), 'utf8'))))
            .map(([, f]) => f);
        ok('every client file that posts to /sync/system is covered above', posters.length > 0 && posters.every(f => covered.includes(f)), posters);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failed) { console.error(`${failed} check(s) failed`); process.exitCode = 1; }
    else console.log('All checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
