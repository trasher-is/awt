// Regression test for a real production crash (2026-08-30): every /sync/player-detail call
// was throwing `RangeError: Missing named parameter "race_growth"` for specific players.
// Root cause: player-api-sync.js reads intel.race.growth (etc.) with no fallback — not every
// player race carries all nine race_* bonus categories, so a present-but-incomplete `race`
// sub-object produces a JS `undefined` for the missing one. JSON.stringify silently drops
// `undefined` keys, so the server never receives that field at all. better-sqlite3's named
// parameters require every key referenced in the SQL to be present (even if the value is
// null) regardless of which has_intel CASE branch actually wins — so the key being entirely
// absent (not merely null) crashed the upsert. Drives the REAL /sync/player-detail route
// end-to-end (express app + http server + fetch) against a scratch sqlite database, because
// the bug is specifically about better-sqlite3's named-parameter binding behavior.
//
// Run with: node src/routes/sync-player-detail.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-player-detail-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

// Mock the bot so the intel-visibility announcements are observable (2026-09-13): with
// DISCORD_TOKEN unset the real sender no-ops silently, which cannot tell "correctly stayed
// quiet" apart from "never got there".
const variousChanges = [];
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: {
    announceSystemChanges: async () => {},
    announceSystemMilestones: async () => {},
    sendVariousChangeEmbed: async (title, description) => { variousChanges.push({ title, description }); },
} };

const express = require('express');
const db = require('../database');
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-player-detail.test.js');

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

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── a race_* key entirely absent (not null) from a has_intel:0 payload ' + '─'.repeat(6));
        // Real shape: JSON.stringify({player}) with player.race_growth === undefined simply
        // omits the key — this simulates the actual bytes that hit the wire, not the
        // in-memory JS object (which would still have the key set to `undefined`).
        const payloadA = JSON.parse(JSON.stringify({
            player: {
                id: 413, name: 'Someplayer', alliance_id: null, level: 5, points: 100,
                ranking: null, country: null, is_active_player: 1, joined: null,
                logins: null, last_activity_at: null, last_login_at: null, resigned_at: null,
                number_of_battles: null, battle_luckiness: null, multi_status: null,
                is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
                has_intel: 0,
                biology: null, economy: null, energy: null, mathematics: null, physics: null,
                social: null, trade_revenue: null, artefact: null,
                // race_growth deliberately omitted (undefined before stringify) — every other
                // race_* field present, mirroring a real API race object missing one bonus.
                race_science: null, race_culture: null, race_production: null, race_speed: null,
                race_attack: null, race_defense: null, race_trader: null, race_sul: null,
            },
        }));
        const resA = await postJson(server, '/hub-api/sync/player-detail', payloadA);
        ok('sync succeeds (200) instead of crashing with "Missing named parameter"', resA.status === 200, resA);

        const rowA = db.prepare('SELECT id, name FROM players WHERE id = ?').get(413);
        ok('player row was actually written', rowA && rowA.name === 'Someplayer', rowA);

        console.log('\n── a race_* key entirely absent from a has_intel:1 (complete-looking) payload ' + '─'.repeat(2));
        // hasCompleteIntel checks p.race_growth via `typeof p[f] === 'number'` — undefined
        // fails that check same as null, so has_intel correctly resolves to 0 either way.
        // This confirms the fix holds even when the caller claims has_intel:1.
        const payloadB = JSON.parse(JSON.stringify({
            player: {
                id: 414, name: 'Otherplayer', alliance_id: null, level: 5, points: 100,
                ranking: null, country: null, is_active_player: 1, joined: null,
                logins: null, last_activity_at: null, last_login_at: null, resigned_at: null,
                number_of_battles: null, battle_luckiness: null, multi_status: null,
                is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
                has_intel: 1,
                biology: 10, economy: 10, energy: 10, mathematics: 10, physics: 10,
                social: 10, trade_revenue: 10, artefact: null,
                race_science: 5, race_culture: 5, race_production: 5, race_speed: 5,
                race_attack: 5, race_defense: 5, race_trader: 5, race_sul: 5,
            },
        }));
        const resB = await postJson(server, '/hub-api/sync/player-detail', payloadB);
        ok('sync succeeds (200) even when has_intel:1 but a race_* key is missing', resB.status === 200, resB);

        const rowB = db.prepare('SELECT has_intel, race_growth FROM players WHERE id = ?').get(414);
        ok('has_intel correctly demoted to 0 (incomplete intel), race_growth left at default',
            rowB && rowB.has_intel === 0, rowB);

        // This route used to own the intel-visibility announcements. It no longer does, and
        // the end-to-end coverage moved with them to sync-player-intel-visibility.test.js —
        // see announceIntelVisibility in sync.js for the measurement behind that. What is
        // left here is the guarantee that this route keeps its hands off: it reports
        // has_intel: 0 for everyone because the API carries no intelligenceReport, and if it
        // were ever re-wired to record that as an observation it would pin every player's
        // confirmed state at "not visible" and silence the real signal all over again.
        console.log('\n-- The sweep must not touch intel visibility ' + '-'.repeat(25));
        // Mirrors what the API mapper really produces: has_intel 0 and every intel field
        // null, for every player, because the response carries no intelligenceReport.
        const sweepPayload = (id, extra = {}) => JSON.parse(JSON.stringify({
            player: {
                id, name: 'Unwatched', alliance_id: null, alliance_tag: 'FOE', level: 2, points: 2,
                ranking: null, country: null, is_active_player: 1, joined: null,
                logins: null, last_activity_at: null, last_login_at: null, resigned_at: null,
                number_of_battles: null, battle_luckiness: null, multi_status: null,
                is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
                has_intel: 0, biology: null, economy: null, energy: null, mathematics: null,
                physics: null, social: null, trade_revenue: null, artefact: null,
                ...extra,
            },
        }));
        const sync = (id, _unusedVisible, extra) => postJson(server, '/hub-api/sync/player-detail', sweepPayload(id, extra));

        variousChanges.length = 0;
        // A player the scrape has already confirmed we can see, exactly as production looked.
        await sync(520);
        db.prepare(`UPDATE players SET has_intel = 1, intel_visible = 1, intel_seen_raw = 1 WHERE id = 520`).run();

        await sync(520);
        await sync(520);
        const afterSweeps = db.prepare('SELECT intel_visible, intel_seen_raw FROM players WHERE id = 520').get();
        ok('two blind sweeps in a row leave the confirmed state untouched',
            afterSweeps.intel_visible === 1 && afterSweeps.intel_seen_raw === 1, afterSweeps);
        ok('and announce nothing — a source that cannot see is not evidence of not seeing',
            variousChanges.length === 0, variousChanges.map(c => c.title));

        // ORIGIN from the API sweep (2026-09-13). The game reveals a player's origin only
        // for a system WE have vision of, and it arrives as coordinates. This nearly shipped
        // broken: the assignment was made but the API upsert had no origin_system column, and
        // better-sqlite3 silently ignores a named parameter the statement does not mention —
        // so every origin would have been dropped on the floor while looking like "the API
        // just doesn't expose any".
        console.log('\n-- Origin captured from the sweep ' + '-'.repeat(36));
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (640, 'Sceptrum', -9, 12)`).run();
        await sync(521, false, { origin_x: -9, origin_y: 12 });
        const stored = db.prepare('SELECT origin_system FROM players WHERE id = 521').get();
        ok('coordinates resolve to the system id and are stored', stored.origin_system === 640, stored);

        await sync(521, false, { origin_x: null, origin_y: null });
        const afterBlind = db.prepare('SELECT origin_system FROM players WHERE id = 521').get();
        ok('a later sync with no origin does NOT erase it — losing vision of a system does not\n     un-know where somebody started',
            afterBlind.origin_system === 640, afterBlind);

        await sync(522, false, { origin_x: 999, origin_y: 999 });
        const unmapped = db.prepare('SELECT origin_system FROM players WHERE id = 522').get();
        ok('coordinates matching no known system leave the origin unset rather than guessing',
            unmapped.origin_system === null, unmapped);

        // The bug this exists to prevent, which reached production: Number(null) is 0, and
        // ZERO IS A REAL COORDINATE — a system sits at (0,0) — so an absent origin was
        // silently recorded as "started at the grid origin". It looked entirely plausible
        // and was wrong for 116 of 159 players.
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (641, 'GridOrigin', 0, 0)`).run();
        for (const [label, extra] of [
            ['both null', { origin_x: null, origin_y: null }],
            ['absent entirely', {}],
            ['empty strings', { origin_x: '', origin_y: '' }],
            ['one axis missing', { origin_x: 0, origin_y: null }],
        ]) {
            const id = 530 + label.length;
            await sync(id, false, extra);
            const row = db.prepare('SELECT origin_system FROM players WHERE id = ?').get(id);
            ok(`no origin (${label}) is NOT recorded as the system at (0,0)`, row.origin_system === null, row);
        }

        // And the flip side: a player genuinely AT (0,0) must still resolve, or the guard
        // would have traded one silent error for another.
        await sync(540, false, { origin_x: 0, origin_y: 0 });
        const atGridOrigin = db.prepare('SELECT origin_system FROM players WHERE id = 540').get();
        ok('a real origin of exactly (0,0) still resolves — 0 is a coordinate, not a blank',
            atGridOrigin.origin_system === 641, atGridOrigin);
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
