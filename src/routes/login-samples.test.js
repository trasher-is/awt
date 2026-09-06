// Every scan that carries a player's login counter is recorded as an observation (issue #137):
// both receivers write it, the profile route returns it raw, pruning and the round nuke
// clean it up.
//
// Run with: node src/routes/login-samples.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-login-samples-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const playersRepo = require('../repositories/players');
const syncRouter = require('./sync');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('login-samples.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', syncRouter);
app.use('/hub-api', intelRouter);

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
        const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const samplesOf = id => db.prepare('SELECT total_logins, observed_at FROM player_login_samples WHERE player_id = ? ORDER BY id').all(id);
const changesOf = id => db.prepare('SELECT COUNT(*) AS c FROM player_logins WHERE player_id = ?').get(id).c;

// The API detail payload, in the shape the receiver's named parameters require (every key
// present — see sync-player-detail.test.js for why).
const detailPayload = (id, logins) => JSON.parse(JSON.stringify({
    player: {
        id, name: 'ScanTarget', alliance_id: null, level: 5, points: 100,
        ranking: null, country: null, is_active_player: 1, joined: null,
        logins, last_activity_at: null, last_login_at: null, resigned_at: null,
        number_of_battles: null, battle_luckiness: null, multi_status: null,
        is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
        has_intel: 0,
        biology: null, economy: null, energy: null, mathematics: null, physics: null,
        social: null, trade_revenue: null, artefact: null,
        race_growth: null, race_science: null, race_culture: null, race_production: null, race_speed: null,
        race_attack: null, race_defense: null, race_trader: null, race_sul: null,
    },
}));

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── The profile scrape receiver records every scan, changed or not ' + '─'.repeat(9));
        let r = await request(server, 'POST', '/hub-api/sync/player', { id: 501, name: 'ScanTarget', logins: 12 });
        ok('first scan accepted', r.status === 200, r);
        ok('one sample, one change row', samplesOf(501).length === 1 && changesOf(501) === 1, samplesOf(501));

        r = await request(server, 'POST', '/hub-api/sync/player', { id: 501, name: 'ScanTarget', logins: 12 });
        ok('an unchanged counter adds a sample but no change row — that sample is the whole point', samplesOf(501).length === 2 && changesOf(501) === 1, samplesOf(501));

        r = await request(server, 'POST', '/hub-api/sync/player', { id: 501, name: 'ScanTarget', logins: 13 });
        ok('a moved counter adds both', samplesOf(501).length === 3 && changesOf(501) === 2, samplesOf(501));
        ok('samples keep the counter value as observed', samplesOf(501).map(s => s.total_logins).join(',') === '12,12,13');

        r = await request(server, 'POST', '/hub-api/sync/player', { id: 501, name: 'ScanTarget' });
        ok('a scrape without the counter (0) is no observation', r.status === 200 && samplesOf(501).length === 3, samplesOf(501));

        console.log('\n── The API detail receiver records the same observation ' + '─'.repeat(19));
        r = await request(server, 'POST', '/hub-api/sync/player-detail', detailPayload(501, 13));
        ok('detail sync accepted', r.status === 200, r);
        ok('adds a sample (counter unchanged, so still no change row)', samplesOf(501).length === 4 && changesOf(501) === 2, samplesOf(501));
        r = await request(server, 'POST', '/hub-api/sync/player-detail', detailPayload(501, null));
        ok('a detail without a counter records nothing', r.status === 200 && samplesOf(501).length === 4);
        r = await request(server, 'POST', '/hub-api/sync/player-detail', detailPayload(501, '14'));
        ok('a numeric string is read as the number it is (same tolerance as the other parsers)', samplesOf(501).length === 5 && samplesOf(501)[4].total_logins === 14, samplesOf(501));
        r = await request(server, 'POST', '/hub-api/sync/player-detail', detailPayload(501, 'fourteen'));
        ok('a non-numeric counter records nothing', r.status === 200 && samplesOf(501).length === 5);
        r = await request(server, 'POST', '/hub-api/sync/player-detail', detailPayload(501, 14.5));
        ok('a fractional counter records nothing', samplesOf(501).length === 5);

        console.log('\n── Pruning keeps two weeks per player ' + '─'.repeat(37));
        db.prepare(`INSERT INTO player_login_samples (player_id, total_logins, observed_at) VALUES (501, 1, datetime('now', '-20 days'))`).run();
        db.prepare(`INSERT INTO player_login_samples (player_id, total_logins, observed_at) VALUES (501, 2, datetime('now', '-10 days'))`).run();
        ok('two back-dated samples in place', samplesOf(501).length === 7);
        await request(server, 'POST', '/hub-api/sync/player', { id: 501, name: 'ScanTarget', logins: 14 });
        const after = samplesOf(501);
        ok('the write dropped the 20-day-old sample and kept the 10-day-old one', after.length === 7 && !after.some(s => s.total_logins === 1) && after.some(s => s.total_logins === 2), after);
        playersRepo.recordLoginSample(501, 14, 0);
        ok('keepDays below 1 is clamped to 1 day (the 10-day-old sample goes), not "delete everything"', samplesOf(501).length === 7 && samplesOf(501).some(s => s.total_logins === 2) === false, samplesOf(501).map(s => s.total_logins));

        console.log('\n── The profile route returns the raw observations of the last 8 days ' + '─'.repeat(6));
        r = await request(server, 'GET', '/hub-api/intel/player/501');
        ok('route answers with success', r.status === 200 && r.body && r.body.success === true, r.body && r.body.error);
        const ls = r.body.loginSamples;
        ok('loginSamples is an array of {t, n}', Array.isArray(ls) && ls.length === 7 && ls.every(s => typeof s.t === 'string' && typeof s.n === 'number'), ls);
        ok('t is the raw SQLite UTC stamp, untouched by the server\'s locale', ls.every(s => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s.t)), ls[0]);
        ok('ascending by time', ls.every((s, i) => i === 0 || s.t >= ls[i - 1].t));
        ok('the existing heatmap and activity fields are still there', Array.isArray(r.body.heatmap) && r.body.heatmap.length === 24 && Array.isArray(r.body.activity));

        await request(server, 'POST', '/hub-api/sync/player', { id: 502, name: 'NeverCounted' });
        r = await request(server, 'GET', '/hub-api/intel/player/502');
        ok('a player with no observations gets an empty array, not a missing field', r.body && Array.isArray(r.body.loginSamples) && r.body.loginSamples.length === 0, r.body && r.body.loginSamples);

        console.log('\n── The round nuke needs no extra delete ' + '─'.repeat(35));
        db.prepare('DELETE FROM players WHERE id = ?').run(501);
        ok('deleting the player row cascades to its samples', samplesOf(501).length === 0);
    } catch (err) {
        failed++;
        console.error('  NOT OK - unexpected error:', err);
    } finally {
        server.close();
    }

    console.log(`\n${failed === 0 ? 'ok' : 'FAILED'} - login-samples.test.js (${failed} failure${failed === 1 ? '' : 's'})`);
    process.exit(failed === 0 ? 0 : 1);
})();
