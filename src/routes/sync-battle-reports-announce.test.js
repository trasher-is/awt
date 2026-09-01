// Regression test for the alliance-tag relevance filter on the battle-report Discord
// announcer (2026-09-02): battle-sync.js now pulls EVERY battle report on the server
// (confirmed against production that the game API's search endpoint returns global results
// when no FirstParty/SecondParty filter is given, same as getPlayers()'s "no filter" shape),
// not just the tracked account's own alliance. Without a relevance filter at announce time,
// every random battle anywhere in the game would post to Discord. See routes/sync.js's
// getBattleReportAllianceTags and its use in the /sync/battle-reports handler.
//
// Drives the REAL /sync/battle-reports route end-to-end (express app + http server + fetch)
// against a scratch sqlite database, with discord-post.js's postEmbed/postBattleEmbed
// monkey-patched to record calls instead of hitting the network — patched BEFORE sync.js is
// first required, since sync.js destructures { postEmbed, postBattleEmbed } from the module
// at require time (a later patch on the exports object would not reach that copied local).
//
// Run with: node src/routes/sync-battle-reports-announce.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-battle-announce-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const settingsRepo = require('../repositories/settings');

const discordPost = require('../utils/discord-post');
const posted = [];
discordPost.postEmbed = (settingKey, embed) => { posted.push({ settingKey, embed }); return Promise.resolve({ ok: true }); };
discordPost.postBattleEmbed = discordPost.postEmbed;

// Must be required AFTER the patch above — sync.js destructures postEmbed/postBattleEmbed
// from discord-post.js at its own module-top-level require() call.
const syncRouter = require('./sync');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('sync-battle-reports-announce.test.js');

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
    settingsRepo.setSetting('discord_battlereport_channel', '999999999999999999');
    settingsRepo.setSetting('discord_battlereport_alliance_tags', 'RAID, NAP1');

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── a global sync with one relevant and one irrelevant battle ' + '─'.repeat(8));
        const payload = {
            reports: [
                {
                    id: 40001, startedAt: '2026-09-02T10:00:00Z', winner: 'Attacker', killedPopulation: 10,
                    attacker: { allianceTag: 'RAID', playerName: 'OurGuy' },
                    defender: { allianceTag: 'ZOD', playerName: 'SomeEnemy' },
                },
                {
                    id: 40002, startedAt: '2026-09-02T09:00:00Z', winner: 'Defender', killedPopulation: 5,
                    attacker: { allianceTag: 'ICE1756FAM', playerName: 'ice1756' },
                    defender: { allianceTag: 'ATASCA', playerName: 'atascaburras' },
                },
            ],
        };
        const res = await postJson(server, '/hub-api/sync/battle-reports', payload);
        ok('sync succeeds (200)', res.status === 200, res);
        ok('both reports were inserted (global sync, not filtered at storage time)',
            res.body && res.body.inserted === 2, res.body);

        ok('exactly one embed was posted (the RAID-tagged battle)', posted.length === 1, posted);
        ok('the posted embed is for the relevant report, not the unrelated one',
            posted.length === 1 && JSON.stringify(posted[0].embed).includes('OurGuy'), posted);
        ok('the irrelevant report was NOT posted to Discord',
            !posted.some(p => JSON.stringify(p.embed).includes('ice1756')), posted);

        const rows = db.prepare('SELECT id, announced FROM battle_reports WHERE id IN (40001, 40002) ORDER BY id').all();
        ok('BOTH rows are marked announced=1 (irrelevant is handled, not left as a retry queue forever)',
            rows.length === 2 && rows.every(r => r.announced === 1), rows);

        console.log('\n── a re-sync of the same two reports must not re-announce either one ' + '─'.repeat(2));
        posted.length = 0;
        const res2 = await postJson(server, '/hub-api/sync/battle-reports', payload);
        ok('re-sync succeeds (200)', res2.status === 200, res2);
        ok('nothing new inserted (INSERT OR IGNORE, same ids)', res2.body && res2.body.inserted === 0, res2.body);
        ok('no embed posted on re-sync — already announced', posted.length === 0, posted);
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
