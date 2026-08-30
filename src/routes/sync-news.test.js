// Regression tests for the "battle challenge tracker news" final-review fix wave
// (2026-08-30), findings C1 and C2 on POST /sync/news:
//   C1 — the route had no try/catch, and news_events.other_player_id has a FOREIGN KEY to
//        players(id); storing raw.other_player_id verbatim throws SQLITE_CONSTRAINT_FOREIGNKEY
//        whenever the hub has never scanned that player, which (pre-fix) also meant the
//        whole batch never got its watermark advanced, wedging that player's ingestion.
//   C2 — an unparseable occurred_at can poison matching (new Date(NaN...) throws) and the
//        watermark (a garbage string that string-compares "greater than" every real ISO
//        timestamp would halt future pagination for that player).
//
// Drives the REAL /sync/news route end-to-end (express app + http server + fetch) against
// a scratch sqlite database, following the harness style of sync-system.test.js.
//
// Run with: node src/routes/sync-news.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-news-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-news.test.js');

// Session player (id 1, "Alice") is who /sync/news resolves req.session.gameName against.
// Player 2 ("Bob") is a resolvable other_player_id. Player 999 ("Ghost") deliberately does
// NOT exist — the hub has never scanned them.
db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Alice'), (2, 'Bob')`).run();

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Alice' }; next(); });
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

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── (a) valid entry with a resolvable other_player_id inserts successfully ' + '─'.repeat(5));
        const resA = await postJson(server, '/hub-api/sync/news', {
            entries: [{
                message_type: 'battle-bombarded',
                occurred_at: '2026-08-24T20:54:00.000Z',
                game_planet_id: 111,
                system_id: 5,
                other_player_id: 2,
                population_delta: 400,
                direction: 'killed',
            }],
        });
        ok('responds 200', resA.status === 200, resA);
        ok('inserted count is 1', resA.body && resA.body.inserted === 1, resA.body);

        const rowA = db.prepare(`SELECT * FROM news_events WHERE player_id = 1 AND game_planet_id = 111`).get();
        ok('row was actually stored', !!rowA, rowA);
        ok('other_player_id stored as the resolvable player', rowA && rowA.other_player_id === 2, rowA);
        ok('credited_player_id resolved to the scraping player (direction: killed)', rowA && rowA.credited_player_id === 1, rowA);

        console.log('\n── (a2) self-bombing row with no other_player_id at all still credits the scraper ' + '─'.repeat(2));
        // Regression test for a real News-page example: "You killed N population" rows
        // carry no player-profile link, so other_player_id is null from the client. The
        // scraping player must still get credited (see resolveBombardmentCredit); only the
        // battle_reports cross-reference is skipped since there's no opponent to match on.
        const resA2 = await postJson(server, '/hub-api/sync/news', {
            entries: [{
                message_type: 'battle-bombarded',
                occurred_at: '2026-08-24T20:55:00.000Z',
                game_planet_id: 112,
                system_id: 5,
                other_player_id: null,
                population_delta: 5,
                direction: 'killed',
            }],
        });
        ok('responds 200', resA2.status === 200, resA2);
        ok('inserted count is 1', resA2.body && resA2.body.inserted === 1, resA2.body);

        const rowA2 = db.prepare(`SELECT * FROM news_events WHERE player_id = 1 AND game_planet_id = 112`).get();
        ok('row was stored', !!rowA2, rowA2);
        ok('other_player_id stays NULL (never known)', rowA2 && rowA2.other_player_id === null, rowA2);
        ok('credited_player_id STILL resolves to the scraping player despite no other_player_id', rowA2 && rowA2.credited_player_id === 1, rowA2);
        ok('matched_battle_report_id stays NULL (no opponent to cross-reference against)', rowA2 && rowA2.matched_battle_report_id === null, rowA2);

        console.log('\n── (b) other_player_id with no players row does not throw/500 ' + '─'.repeat(10));
        const resB = await postJson(server, '/hub-api/sync/news', {
            entries: [{
                message_type: 'battle-bombarded',
                occurred_at: '2026-08-24T21:00:00.000Z',
                game_planet_id: 222,
                system_id: 5,
                other_player_id: 999, // never scanned — no players row
                population_delta: 250,
                direction: 'lost',
            }],
        });
        ok('responds 200, not 500 (regression test for C1)', resB.status === 200, resB);
        ok('the entry still got inserted', resB.body && resB.body.inserted === 1, resB.body);

        const rowB = db.prepare(`SELECT * FROM news_events WHERE player_id = 1 AND game_planet_id = 222`).get();
        ok('row was stored', !!rowB, rowB);
        ok('other_player_id was dropped to NULL (never fabricated a players row)', rowB && rowB.other_player_id === null, rowB);
        ok('credited_player_id also dropped to NULL (no valid player to attribute pop credit to)', rowB && rowB.credited_player_id === null, rowB);
        ok('no players row was fabricated for id 999', db.prepare('SELECT 1 FROM players WHERE id = 999').get() === undefined);

        console.log('\n── (c) unparseable occurred_at does not throw/500 and does not corrupt the watermark ' + '─'.repeat(2));
        const beforeWatermark = db.prepare('SELECT last_news_scraped_at FROM players WHERE id = 1').get().last_news_scraped_at;

        const resC = await postJson(server, '/hub-api/sync/news', {
            entries: [
                {
                    message_type: 'battle-conquer',
                    occurred_at: 'not-a-real-timestamp',
                    game_planet_id: 333,
                    system_id: 5,
                    other_player_id: null,
                    population_delta: null,
                    direction: null,
                },
                {
                    message_type: 'battle-conquer',
                    occurred_at: '2026-08-24T22:00:00.000Z',
                    game_planet_id: 444,
                    system_id: 5,
                    other_player_id: null,
                    population_delta: null,
                    direction: null,
                },
            ],
        });
        ok('responds 200, not 500', resC.status === 200, resC);
        ok('only the valid entry was inserted (bad one skipped)', resC.body && resC.body.inserted === 1, resC.body);
        ok('no row was stored for the unparseable entry', db.prepare(`SELECT 1 FROM news_events WHERE game_planet_id = 333`).get() === undefined);

        const afterWatermark = db.prepare('SELECT last_news_scraped_at FROM players WHERE id = 1').get().last_news_scraped_at;
        ok('watermark advanced using the GOOD entry\'s timestamp, not the garbage one',
            afterWatermark === '2026-08-24T22:00:00.000Z', { beforeWatermark, afterWatermark });
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
