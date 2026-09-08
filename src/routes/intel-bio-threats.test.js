// GET /hub-api/intel/bio-threats (issue #153): same rule as the !bio Discord command —
// players 6+ biology levels above the caller (confirmed, real intel) or 6+ science levels
// above (suspected — an upper bound on unscanned biology, per docs/game-rules.md).
//
// Run with: node src/routes/intel-bio-threats.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-bio-threats-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-bio-threats.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'Caveman' }; next(); });
app.use('/hub-api', intelRouter);

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

// Me: biology 10 -> threshold 16.
db.prepare(`INSERT INTO players (id, name, biology) VALUES (1, 'Caveman', 10)`).run();
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (50, 'Raiders', 'RAID')`).run();

// Confirmed threat: real biology 16 (== threshold), has_intel = 1.
db.prepare(`INSERT INTO players (id, name, biology, has_intel, alliance_id) VALUES (2, 'BioGiant', 16, 1, 50)`).run();
// Not a threat: real biology 15, one below threshold.
db.prepare(`INSERT INTO players (id, name, biology, has_intel) VALUES (3, 'JustUnder', 15, 1)`).run();
// Suspected threat: never had biology scraped (has_intel = 0), but public science level 20 >= threshold.
db.prepare(`INSERT INTO players (id, name, science_level, has_intel) VALUES (4, 'MysteryScientist', 20, 0)`).run();
// Not a threat: has_intel = 0 but science level below threshold.
db.prepare(`INSERT INTO players (id, name, science_level, has_intel) VALUES (5, 'LowScience', 10, 0)`).run();
// Confirmed AND high science, but has_intel = 1 — must land in "confirmed" only, never
// double-counted into "suspected" too (suspected is has_intel = 0 exclusively).
db.prepare(`INSERT INTO players (id, name, biology, science_level, has_intel) VALUES (6, 'ScannedAndStrong', 16, 30, 1)`).run();

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── bio-threats for a known player ' + '─'.repeat(30));
        const res = await getJson(server, '/hub-api/intel/bio-threats');
        ok('responds 200', res.status === 200, res);
        ok('myBio resolves to the caller\'s own biology (10)', res.body && res.body.myBio === 10, res.body);
        ok('threshold is myBio + 6 = 16', res.body && res.body.threshold === 16, res.body);

        const confirmedNames = (res.body.confirmed || []).map(p => p.name).sort();
        ok('confirmed list has exactly BioGiant and ScannedAndStrong (real bio >= 16, has_intel=1)',
            JSON.stringify(confirmedNames) === JSON.stringify(['BioGiant', 'ScannedAndStrong']), confirmedNames);
        ok('confirmedCount matches the list length (2)', res.body.confirmedCount === 2, res.body.confirmedCount);
        ok('JustUnder (bio 15, one below threshold) is excluded', !confirmedNames.includes('JustUnder'));

        const suspectedNames = (res.body.suspected || []).map(p => p.name);
        ok('suspected list has exactly MysteryScientist (has_intel=0, science 20 >= 16)',
            JSON.stringify(suspectedNames) === JSON.stringify(['MysteryScientist']), suspectedNames);
        ok('suspectedCount matches (1)', res.body.suspectedCount === 1, res.body.suspectedCount);
        ok('LowScience (science 10, below threshold) is excluded', !suspectedNames.includes('LowScience'));
        ok('ScannedAndStrong never appears in suspected despite high science (has_intel=1, so it is CONFIRMED not suspected)',
            !suspectedNames.includes('ScannedAndStrong'), suspectedNames);

        ok('the caller never appears in either of their own lists',
            !confirmedNames.includes('Caveman') && !suspectedNames.includes('Caveman'));

        const bioGiant = res.body.confirmed.find(p => p.name === 'BioGiant');
        ok('a confirmed row carries player_id (for a clickable link) and the alliance tag',
            bioGiant && bioGiant.player_id === 2 && bioGiant.ally_tag === 'RAID', bioGiant);

        console.log('\n── an unrecognized/never-scanned session player degrades gracefully ' + '─'.repeat(4));
        const app2 = express();
        app2.use(express.json());
        app2.use((req, res, next) => { req.session = { userId: 999, gameName: 'GhostAccount' }; next(); });
        app2.use('/hub-api', intelRouter);
        const server2 = app2.listen(0);
        await new Promise((resolve) => server2.once('listening', resolve));
        try {
            const res2 = await getJson(server2, '/hub-api/intel/bio-threats');
            ok('still responds 200, not 500', res2.status === 200, res2);
            ok('myBio is null (no matching players row)', res2.body && res2.body.myBio === null, res2.body);
            ok('confirmed/suspected are empty rather than fabricated', res2.body && res2.body.confirmed.length === 0 && res2.body.suspected.length === 0, res2.body);
        } finally {
            server2.close();
        }
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
