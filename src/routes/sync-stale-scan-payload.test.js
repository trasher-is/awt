// A galaxy scan posts every system from ONE Map/sectors fetch, so a tab that is frozen
// mid-scan and resumed later posts data that is as old as the freeze. Real case
// (2026-10-06): a suspended mobile tab resumed 43 minutes later and posted the rest of a
// 06:27 fetch at 07:10, after another member's whole-map scan had already recorded four
// planets as colonised. Stamped on arrival, the old data outranked the fresh scan and the
// hub announced all four as lost, then colonised again seconds later.
//
// A live read is now stamped with when it was fetched (arrival minus fetch_age_ms), so the
// existing observation-order guard skips it whenever something fresher has already been
// applied. Drives the real /sync/system route against a scratch database; all data synthetic.
//
// Run with: node src/routes/sync-stale-scan-payload.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-stale-scan-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
// Population drops are applied at once here; the confirmation delay has its own suite.
process.env.POP_DROP_CONFIRM_MS = '0';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-stale-scan-payload.test.js');

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
            res.on('data', (chunk) => { raw += chunk; });
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

const MIN = 60 * 1000;
const owned = (index, pop) => ({ planet_index: index, owner: { id: 9001, name: 'SynthPilot', alliance_id: null }, population: pop, starbase: 0 });
const free = (index) => ({ planet_index: index, owner: null, population: 0, starbase: 0 });
const scanPost = (systemId, planets, ageMs) => {
    const body = { system_id: systemId, planets, fleets: [], observation_live: true, source: 'api-seed' };
    if (ageMs !== undefined) body.fetch_age_ms = ageMs;
    return body;
};
const planet = (systemId, index) => db.prepare('SELECT owner_id, population FROM planets WHERE system_id = ? AND planet_index = ?').get(systemId, index);
const eventCount = (systemId) => db.prepare('SELECT COUNT(*) n FROM planet_events WHERE system_id = ?').get(systemId).n;
const observedAtMs = (systemId) => {
    const row = db.prepare('SELECT observed_at FROM systems WHERE id = ?').get(systemId);
    return row && row.observed_at ? Date.parse(row.observed_at) : null;
};

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── (a) the 2026-10-06 case: a 43-minute-old scan after a fresh one ' + '─'.repeat(8));
        // System 801 was free; a fresh scan (fetched 3 s ago) sees it colonised.
        await postJson(server, '/hub-api/sync/system', scanPost(801, [free(1)], 50 * MIN));
        await postJson(server, '/hub-api/sync/system', scanPost(801, [owned(1, 1)], 3000));
        ok('the fresh scan records the colonisation', planet(801, 1) && planet(801, 1).owner_id === 9001, planet(801, 1));
        const eventsBefore = eventCount(801);

        // A resumed tab now posts its 43-minute-old fetch, from before the colonisation.
        const stale = await postJson(server, '/hub-api/sync/system', scanPost(801, [free(1)], 43 * MIN));
        ok('the stale post is skipped as an older observation',
            stale.status === 200 && stale.body && stale.body.skipped === 'stale_observation', stale);
        ok('the planet keeps its owner', planet(801, 1).owner_id === 9001, planet(801, 1));
        ok('and its population', planet(801, 1).population === 1, planet(801, 1));
        ok('no "lost it" event is written', eventCount(801) === eventsBefore, { before: eventsBefore, after: eventCount(801) });

        console.log('\n── (b) old data still applies when nothing fresher exists ' + '─'.repeat(17));
        // Nobody else scanned system 802 since its last read 2 hours ago; a 43-minute-old fetch
        // is the newest thing anyone has, and must not be thrown away.
        // (A drop, not a rise: a same-owner rise this soon is refused by the regrowth guard.)
        await postJson(server, '/hub-api/sync/system', scanPost(802, [owned(1, 5)], 120 * MIN));
        const late = await postJson(server, '/hub-api/sync/system', scanPost(802, [owned(1, 4)], 43 * MIN));
        ok('the late post is applied', late.status === 200 && late.body && !late.body.skipped, late);
        ok('and its figure is stored', planet(802, 1).population === 4, planet(802, 1));

        console.log('\n── (c) two members scanning at once: the later fetch wins, whatever arrives last ' + '─'.repeat(1));
        // The planet changes hands. Member B fetched 1 s ago and posts first; member A fetched
        // 20 s ago, before the conquest, and posts after.
        const conqueror = (index) => ({ planet_index: index, owner: { id: 9002, name: 'SynthRaider', alliance_id: null }, population: 1, starbase: 0 });
        await postJson(server, '/hub-api/sync/system', scanPost(803, [owned(1, 3)], 10 * MIN));
        const fresher = await postJson(server, '/hub-api/sync/system', scanPost(803, [conqueror(1)], 1000));
        ok('B (fetched later) applies', fresher.body && !fresher.body.skipped, fresher);
        const older = await postJson(server, '/hub-api/sync/system', scanPost(803, [owned(1, 3)], 20000));
        ok('A (fetched earlier, posted later) is skipped', older.body && older.body.skipped === 'stale_observation', older);
        ok('the new owner stands', planet(803, 1).owner_id === 9002, planet(803, 1));

        console.log('\n── (d) the watermark is the fetch time, not the arrival time ' + '─'.repeat(14));
        const before = Date.now();
        await postJson(server, '/hub-api/sync/system', scanPost(804, [owned(1, 2)], 30 * MIN));
        const after = Date.now();
        const stamped = observedAtMs(804);
        ok('observed_at is 30 minutes before arrival',
            stamped !== null && stamped >= before - 30 * MIN && stamped <= after - 30 * MIN, { stamped, before, after });

        console.log('\n── (e) payloads without a usable age are stamped on arrival, as before ' + '─'.repeat(4));
        for (const [label, age] of [['absent', undefined], ['negative', -5000], ['not a number', 'soon']]) {
            const sys = 810 + ['absent', 'negative', 'not a number'].indexOf(label);
            const t0 = Date.now();
            const r = await postJson(server, '/hub-api/sync/system', scanPost(sys, [owned(1, 3)], age));
            const t1 = Date.now();
            const at = observedAtMs(sys);
            ok(`age ${label}: applied`, r.status === 200 && r.body && !r.body.skipped, r);
            ok(`age ${label}: stamped at arrival`, at !== null && at >= t0 - 1000 && at <= t1 + 1000, { at, t0, t1 });
        }

        console.log('\n── (f) a cached capture is still ordered by its own stamp, not by the age ' + '─'.repeat(1));
        // captured_at (the game's daily snapshot) already says when the data is from; the age
        // must not move it.
        const capturedAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
        await postJson(server, '/hub-api/sync/system', { system_id: 820, planets: [owned(1, 6)], fleets: [], captured_at: capturedAt, fetch_age_ms: 10 * MIN });
        ok('observed_at equals the capture stamp', observedAtMs(820) === Date.parse(capturedAt), { got: observedAtMs(820), want: Date.parse(capturedAt) });
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch((err) => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
