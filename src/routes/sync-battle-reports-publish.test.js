// A battle report is published at the game's daily reset. A pull made earlier that day
// stores it with is_public = 0, and /sync/battle-reports is INSERT OR IGNORE, so the flag
// stayed 0 for good: on 2026-10-02 the API called reports public that the hub still held as
// 0, and battle-race-inference skips every is_public != 1 row. The sync now raises the flag
// (only ever up, and nothing else) for reports the API reports public.
// Drives the REAL route against a scratch sqlite database. Synthetic data only.
//
// Run with: node src/routes/sync-battle-reports-publish.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-br-publish-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
// Never attempt a real Discord login in a test process.
delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');
const { publishReports } = require('../utils/battle-reports');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-battle-reports-publish.test.js');

const app = express();
app.use(express.json());
// Stand-in for a logged-in session — requireAuth only checks req.session.userId.
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

const side = (over = {}) => ({
    playerId: null, playerName: null, allianceId: null, allianceTag: null, hasWon: false,
    combatValue: 100, survivedCombatValue: 50, lostCombatValue: 50, ...over,
});
const report = (id, over = {}) => {
    const r = {
        id, startedAt: '2026-09-20T10:00:00+02:00', isPublic: false, winner: 'Attacker', conqueredPlanet: false,
        killedPopulation: 0, randomNumber: 42.5, attacker: side({ hasWon: true }), defender: side(), ...over,
    };
    if (r.isPublic === undefined) delete r.isPublic; // the key itself absent, as an older API response
    return r;
};
const row = id => db.prepare('SELECT * FROM battle_reports WHERE id = ?').get(id);
const sync = (server, reports) => postJson(server, '/hub-api/sync/battle-reports', { reports });

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        console.log('\n── (a) a report stored before the reset becomes public on a later sync ' + '─'.repeat(5));
        const first = await sync(server, [report(9001, { isPublic: false })]);
        ok('first sync inserts it as not public', first.body.inserted === 1 && row(9001).is_public === 0 && first.body.published === 0, [first.body, row(9001)]);
        // Stand-ins for what happened to the stored row since: announced, and its CV as first stored.
        db.prepare('UPDATE battle_reports SET announced = 1 WHERE id = 9001').run();

        const second = await sync(server, [report(9001, { isPublic: true, attacker: side({ hasWon: true, combatValue: 999 }) })]);
        ok('the later sync raises the flag and reports it', row(9001).is_public === 1 && second.body.published === 1, [second.body, row(9001)]);
        ok('it is not counted as an insert', second.body.inserted === 0 && second.body.skipped === 1, second.body);
        ok('nothing but the flag changes (CV and announced untouched)',
            row(9001).att_combat_value === 100 && row(9001).announced === 1, row(9001));

        console.log('\n── (b) settled rows are left alone ' + '─'.repeat(37));
        const third = await sync(server, [report(9001, { isPublic: true })]);
        ok('re-syncing an already public report changes nothing', third.body.published === 0 && row(9001).is_public === 1, third.body);
        const lowered = await sync(server, [report(9001, { isPublic: false })]);
        ok('a stored 1 is never lowered', lowered.body.published === 0 && row(9001).is_public === 1, [lowered.body, row(9001)]);

        console.log('\n── (c) NULL, old-API and malformed flags ' + '─'.repeat(31));
        db.prepare(`INSERT INTO battle_reports (id, started_at, is_public) VALUES (9002, '2026-09-20T10:00:00+02:00', NULL)`).run();
        const fromNull = await sync(server, [report(9002, { isPublic: true })]);
        ok('a stored NULL becomes 1', row(9002).is_public === 1 && fromNull.body.published === 1, [fromNull.body, row(9002)]);

        await sync(server, [report(9003, { isPublic: false })]);
        const absent = await sync(server, [report(9003, { isPublic: undefined })]);
        ok('a response without the flag leaves the row as it was', row(9003).is_public === 0 && absent.body.published === 0, [absent.body, row(9003)]);
        const junk = await sync(server, [report(9003, { isPublic: 'yes' })]);
        ok('a non-boolean flag is not read as public', row(9003).is_public === 0 && junk.body.published === 0, [junk.body, row(9003)]);

        console.log('\n── (d) counts in a mixed batch ' + '─'.repeat(41));
        await sync(server, [report(9004, { isPublic: false }), report(9005, { isPublic: true })]);
        const mixed = await sync(server, [
            report(9004, { isPublic: true }),   // stored 0 -> raised
            report(9005, { isPublic: true }),   // stored 1 -> unchanged
            report(9006, { isPublic: true }),   // new, inserted already public -> not "published"
            report(9003, { isPublic: false }),  // still not public
        ]);
        ok('only the genuinely raised row is counted', mixed.body.published === 1 && mixed.body.inserted === 1 && mixed.body.skipped === 3, mixed.body);
        ok('the rows end up as expected', row(9004).is_public === 1 && row(9005).is_public === 1 && row(9006).is_public === 1 && row(9003).is_public === 0,
            [9003, 9004, 9005, 9006].map(i => [i, row(i).is_public]));

        console.log('\n── (e) publishReports on its own ' + '─'.repeat(39));
        const before = db.prepare('SELECT COUNT(*) AS n FROM battle_reports').get().n;
        const unheld = publishReports(db, [{ id: 987654, is_public: 1 }]);
        ok('an id the hub does not hold is not created or reported',
            unheld.length === 0 && db.prepare('SELECT COUNT(*) AS n FROM battle_reports').get().n === before, unheld);
        ok('rows that are not public in the payload are ignored', publishReports(db, [{ id: 9003, is_public: 0 }, { id: 9003, is_public: null }]).length === 0 && row(9003).is_public === 0);
        ok('an empty batch is fine', publishReports(db, []).length === 0);
    } finally {
        server.close();
    }

    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
