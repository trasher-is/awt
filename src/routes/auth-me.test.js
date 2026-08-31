// Route-level coverage for GET /hub-api/me — specifically the bridgeResolved field added
// to fix a real production confusion (2026-08-31): the client-side "no allianceId" check
// couldn't tell a broken hub-username-to-player-name bridge apart from a bridge that
// resolved fine to a player who simply has no alliance yet (e.g. a fresh round). Both used
// to look identical (allianceId: null), and battle-sync.js's error message ("name bridge
// unresolved") was wrong for the second, far more common case.
//
// Run with: node src/routes/auth-me.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-auth-me-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const authRouter = require('./auth');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('auth-me.test.js');

// A real app_users row — the bridge join reads app_users.game_name for this session's
// userId from the DB, not from the mock session object, so it has to actually exist.
usersRepo.createUser('Caveman2', 'hash1', 'user', null);
const testUser = usersRepo.getUserByGameName('Caveman2');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: testUser.id, gameName: 'Caveman2', role: 'user' }; next(); });
app.use('/hub-api', authRouter);

function getJson(server, urlPath) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        }).on('error', reject);
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── no player row matches this hub account\'s game name at all ' + '─'.repeat(6));
        const noMatch = await getJson(server, '/hub-api/me');
        ok('bridgeResolved is false', noMatch.body.bridgeResolved === false, noMatch.body);
        ok('allianceId is null', noMatch.body.allianceId === null, noMatch.body);
        ok('playerId is null — nothing to fall back to either', noMatch.body.playerId === null, noMatch.body);

        console.log('\n── a matching player exists but has no alliance right now ' + '─'.repeat(10));
        // The exact scenario a real production report traced back to (2026-08-31): a fresh
        // round, before the account has joined an alliance. playerId is what lets
        // battle-sync.js fall back to a per-player search instead of skipping entirely.
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (701, 'Caveman2', NULL)`).run();
        const noAlliance = await getJson(server, '/hub-api/me');
        ok('bridgeResolved is true — the bridge itself worked', noAlliance.body.bridgeResolved === true, noAlliance.body);
        ok('allianceId is still null — this player genuinely has no alliance', noAlliance.body.allianceId === null, noAlliance.body);
        ok('playerId is the real player id, usable as a fallback search scope', noAlliance.body.playerId === 701, noAlliance.body);

        console.log('\n── a matching player with an alliance ' + '─'.repeat(30));
        db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (9001, 'Test Alliance', 'TA')`).run();
        db.prepare(`UPDATE players SET alliance_id = 9001 WHERE id = 701`).run();
        const withAlliance = await getJson(server, '/hub-api/me');
        ok('bridgeResolved is true', withAlliance.body.bridgeResolved === true, withAlliance.body);
        ok('allianceId is the real alliance id', withAlliance.body.allianceId === 9001, withAlliance.body);
        ok('playerId is still returned even once an alliance exists', withAlliance.body.playerId === 701, withAlliance.body);

        console.log('\n── case-insensitive match, per the bridge\'s own contract ' + '─'.repeat(11));
        db.prepare(`UPDATE players SET name = 'CAVEMAN2' WHERE id = 701`).run();
        const caseInsensitive = await getJson(server, '/hub-api/me');
        ok('still resolves despite a case difference between hub username and player name',
            caseInsensitive.body.bridgeResolved === true && caseInsensitive.body.allianceId === 9001, caseInsensitive.body);
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
