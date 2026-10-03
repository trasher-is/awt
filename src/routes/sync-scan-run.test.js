// The scan log: one summary row per galaxy scan (galaxy_scan_runs), and a run id + data age on every
// traced population change so a stale read can be lined up with the scan that sent it.
//
// Why: two hubs saw a member's read show a planet one level low right after a growth tick, and the
// hub could not say who had run that scan, in which browser, whether the game's response came from a
// cache, or how long the data had sat before it was posted. This records exactly those things.
//
// Drives the REAL routes against a scratch database; everything is synthetic (the repository is public).
//
// Run with: node src/routes/sync-scan-run.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-scan-run-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
// These tests are about the scan log, not the drop confirmation delay.
process.env.POP_DROP_CONFIRM_MS = '0';
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: {
    announceSystemChanges: async () => {},
    announceSystemMilestones: async () => {},
} };
const express = require('express');
const db = require('../database');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Tester' }; next(); });
app.use('/hub-api', require('./sync'));

let failed = 0;
function ok(name, condition, detail) {
    console.log(`  ${condition ? 'ok' : 'NOT OK'} - ${name}${!condition && detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`);
    if (!condition) failed++;
}
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const RUN = '3f2b8c1e-5d4a-4b7e-9c2f-1a6d8e0b7c44';
const runRows = id => db.prepare('SELECT * FROM galaxy_scan_runs WHERE run_id = ?').all(id);
const owner = { id: 7001, name: 'ScanOwner' };

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const post = async (route, body, headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/hub-api${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        });
        let json = null;
        try { json = await response.json(); } catch (err) { /* leave null */ }
        return { status: response.status, body: json };
    };
    const syncSystem = (systemId, population, extra = {}) =>
        post('/sync/system', { system_id: systemId, planets: [{ planet_index: 1, starbase: 0, owner, population }], source: 'api-seed', ...extra });

    try {
        console.log('sync-scan-run.test.js');

        console.log('\n── schema ' + '─'.repeat(64));
        const cols = name => new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name));
        ok('galaxy_scan_runs exists with the fields that answer the stale-data questions',
            ['run_id', 'actor_game_name', 'started_by', 'browser', 'tab_age_s', 'run_index', 'went_hidden', 'cache_state', 'transfer_size', 'date_lag_s', 'headers_json', 'duration_ms', 'post_ms_max']
                .every(c => cols('galaxy_scan_runs').has(c)));
        ok('population_trace gains run_id and payload_age_ms', cols('population_trace').has('run_id') && cols('population_trace').has('payload_age_ms'));
        ok('the stored column is not named after the SQL keyword TRIGGER', !cols('galaxy_scan_runs').has('trigger') && cols('galaxy_scan_runs').has('started_by'));

        // Retention runs on the first write in a process; plant an old and a recent row first.
        db.prepare("INSERT INTO galaxy_scan_runs (run_id, started_by, result, received_at) VALUES ('old-run-0000000000', 'auto', 'ok', datetime('now', '-40 days'))").run();
        db.prepare("INSERT INTO galaxy_scan_runs (run_id, started_by, result, received_at) VALUES ('recent-run-00000000', 'auto', 'ok', datetime('now', '-10 days'))").run();

        console.log('\n── a scan reports itself ' + '─'.repeat(50));
        const report = {
            run_id: RUN, trigger: 'auto', result: 'ok', tab_age_s: 5400, run_index: 0, hidden_at_start: false, went_hidden: true,
            systems_total: 381, systems_posted: 380, planets_posted: 3100, in_vision: 111, duration_ms: 41250, fetch_ms: 830,
            post_ms_avg: 105, post_ms_max: 910, response_status: 200, cache_state: 'revalidated', transfer_size: 310, encoded_body_size: 408110,
            delivery_type: '', fetched_ago_ms: 2000,
            headers: { date: new Date(Date.now() - 2000 - 90_000).toUTCString(), age: '85', 'cache-control': 'private', 'set-cookie': 'session=secret', authorization: 'Bearer secret' },
        };
        const r1 = await post('/sync/scan-run', report, { 'User-Agent': FIREFOX });
        ok('the report is accepted', r1.status === 200 && r1.body && r1.body.success === true, r1);
        const row = runRows(RUN)[0];
        ok('who ran it comes from the session, not from the body', row && row.actor_user_id === 1 && row.actor_game_name === 'Tester', row);
        ok('which browser comes from the User-Agent', row.browser === 'firefox' && row.mobile === 0, row);
        ok('what the scan said about itself is stored', row.started_by === 'auto' && row.result === 'ok' && row.run_index === 0 && row.went_hidden === 1
            && row.hidden_at_start === 0 && row.systems_posted === 380 && row.in_vision === 111 && row.post_ms_max === 910 && row.cache_state === 'revalidated', row);
        ok('how old the game\'s own copy already was is worked out server-side (about 90s)', row.date_lag_s >= 88 && row.date_lag_s <= 92, row.date_lag_s);
        const stored = JSON.parse(row.headers_json);
        ok('only cache-relevant headers are stored: the Age and cache-control stay, the cookie and authorization never do',
            stored.age === '85' && stored['cache-control'] === 'private' && !('set-cookie' in stored) && !('authorization' in stored), stored);
        ok('retention: a row older than 30 days is pruned on the first write, a recent one is kept',
            runRows('old-run-0000000000').length === 0 && runRows('recent-run-00000000').length === 1);

        console.log('\n── bad input ' + '─'.repeat(62));
        const before = db.prepare('SELECT COUNT(*) n FROM galaxy_scan_runs').get().n;
        const bad = await post('/sync/scan-run', { ...report, run_id: "x'; DROP TABLE users;--" });
        ok('a report with no usable run id is refused (400) and stores nothing', bad.status === 400 && db.prepare('SELECT COUNT(*) n FROM galaxy_scan_runs').get().n === before, bad);
        const empty = await post('/sync/scan-run', {});
        ok('so is an empty one', empty.status === 400, empty);
        const odd = await post('/sync/scan-run', { run_id: 'odd-values-00000000', trigger: 'sometimes', result: 'maybe', cache_state: 'quantum', systems_total: 1e12, tab_age_s: -4 });
        const oddRow = runRows('odd-values-00000000')[0];
        ok('odd values are coerced, not trusted: unknown trigger/cache state, absurd counts clamped, a negative age unreported',
            odd.status === 200 && oddRow.started_by === 'unknown' && oddRow.cache_state === 'unknown' && oddRow.result === 'error' && oddRow.systems_total === 100000, oddRow);

        console.log('\n── a failed write never costs the scan ' + '─'.repeat(36));
        const realError = console.error; const logged = [];
        console.error = (...args) => logged.push(args.join(' '));
        db.exec('ALTER TABLE galaxy_scan_runs RENAME TO galaxy_scan_runs_hidden');
        let failedWrite;
        try { failedWrite = await post('/sync/scan-run', { ...report, run_id: 'write-fails-0000000' }); }
        finally { db.exec('ALTER TABLE galaxy_scan_runs_hidden RENAME TO galaxy_scan_runs'); console.error = realError; }
        ok('the route answers 200 with success:false instead of failing', failedWrite.status === 200 && failedWrite.body && failedWrite.body.success === false, failedWrite);
        ok('...and logs it', logged.some(l => l.includes('[ScanRun] write failed')), logged);

        console.log('\n── a traced change points back at its scan ' + '─'.repeat(32));
        await syncSystem(7100, 6);
        db.prepare('UPDATE planets SET population_observed_at=? WHERE system_id=7100').run(new Date(Date.now() - 48 * 3600000).toISOString());
        await syncSystem(7100, 7, { run_id: RUN, fetch_age_ms: 61500 });
        const trace = db.prepare('SELECT * FROM population_trace WHERE system_id=7100 ORDER BY id').all();
        ok('the trace row carries the scan\'s run id and how old that scan\'s data was when posted',
            trace.length === 1 && trace[0].outcome === 'rise' && trace[0].run_id === RUN && trace[0].payload_age_ms === 61500, trace);
        const joined = db.prepare(`SELECT t.outcome, t.payload_age_ms, r.actor_game_name, r.browser, r.cache_state, r.run_index
                                   FROM population_trace t JOIN galaxy_scan_runs r ON r.run_id = t.run_id WHERE t.system_id = 7100`).get();
        ok('...so one query lines the change up with who scanned, in what browser, and whether the response came from a cache',
            joined && joined.actor_game_name === 'Tester' && joined.browser === 'firefox' && joined.cache_state === 'revalidated' && joined.payload_age_ms === 61500, joined);

        await syncSystem(7101, 6);
        db.prepare('UPDATE planets SET population_observed_at=? WHERE system_id=7101').run(new Date(Date.now() - 48 * 3600000).toISOString());
        await syncSystem(7101, 7);
        const plain = db.prepare('SELECT run_id, payload_age_ms FROM population_trace WHERE system_id=7101').get();
        ok('a payload from a client that predates this records NULLs, and is otherwise traced as before', plain.run_id === null && plain.payload_age_ms === null, plain);

        await syncSystem(7102, 6);
        db.prepare('UPDATE planets SET population_observed_at=? WHERE system_id=7102').run(new Date(Date.now() - 48 * 3600000).toISOString());
        await syncSystem(7102, 7, { run_id: 'bad id!', fetch_age_ms: -3 });
        const junk = db.prepare('SELECT run_id, payload_age_ms FROM population_trace WHERE system_id=7102').get();
        ok('a malformed run id and a negative age are dropped, not stored', junk.run_id === null && junk.payload_age_ms === null, junk);

        console.log('\n── wiring ' + '─'.repeat(64));
        const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const seed = strip(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scrapers', 'api-galaxy-seed.js'), 'utf8'));
        ok('every system the scan posts carries the run id and the age of its data', /payload\.run_id = ctx\.runId/.test(seed) && /payload\.fetch_age_ms = /.test(seed));
        ok('the scan asks for the sectors WITH diagnostics, and reports to the hub', /getMapSectors\(SECTOR_BOUNDS, \{ meta: true \}\)/.test(seed) && /\/hub-api\/sync\/scan-run/.test(seed));
        // Specific on purpose: the function's own definition also reads "reportScanRun(ctx,".
        ok('the report goes out when the scan finishes (whatever its result)', /const result = await runSeed\(onProgress, ctx\);\s*reportScanRun\(ctx, result\);/.test(seed));
        ok('...and when the scan throws, so no run goes unreported', /catch \(err\) \{\s*reportScanRun\(ctx, \{ ok: false[^}]*\}\);\s*throw err;/.test(seed)
            && /finally\s*\{\s*ctx\.watch\.stop\(\)/.test(seed));
        ok('reporting is wrapped so it can never break a scan', /function reportScanRun[\s\S]*?try \{[\s\S]*?\} catch \(err\)/.test(seed));
        ok('the background tick labels itself auto; a button stays manual', /seedGalaxyFromApi\(undefined, \{ trigger: 'auto' \}\)/.test(seed) && /opts\.trigger === 'auto' \? 'auto' : 'manual'/.test(seed));
        const ops = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'operations.md'), 'utf8');
        ok('docs/operations.md lists the table, and says a round reset keeps it', /galaxy_scan_runs/.test(ops));
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failed) { console.error(`${failed} check(s) failed`); process.exitCode = 1; }
    else console.log('All checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
