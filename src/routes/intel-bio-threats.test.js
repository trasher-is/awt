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
const playersRepo = require('../repositories/players');
const intelRouter = require('./intel');

const MY_BIO = 10;
const CONFIRMED_THRESHOLD = MY_BIO + playersRepo.BIO_THREAT_MARGIN_CONFIRMED;
const SUSPECTED_THRESHOLD = MY_BIO + playersRepo.BIO_THREAT_MARGIN_SUSPECTED;
// Two bars since 2026-09-13: confirmed biology waits for a decisive +6, while an unscanned
// player's science level is only a ceiling, so +4 warns earlier. Computed, not hardcoded, so this
                                                            // test tracks the margin wherever
                                                            // it's set rather than assuming it

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

// Me: biology MY_BIO -> threshold THRESHOLD (MY_BIO + the shared margin).
db.prepare(`INSERT INTO players (id, name, biology) VALUES (1, 'Caveman', ?)`).run(MY_BIO);
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (50, 'Raiders', 'RAID')`).run();

// Confirmed threat: real biology == threshold, has_intel = 1.
db.prepare(`INSERT INTO players (id, name, biology, has_intel, alliance_id) VALUES (2, 'BioGiant', ?, 1, 50)`).run(CONFIRMED_THRESHOLD);
// Not a threat: real biology one below threshold.
db.prepare(`INSERT INTO players (id, name, biology, has_intel) VALUES (3, 'JustUnder', ?, 1)`).run(CONFIRMED_THRESHOLD - 1);
// Suspected threat: never had biology scraped (has_intel = 0), but public science level >= threshold.
db.prepare(`INSERT INTO players (id, name, science_level, has_intel) VALUES (4, 'MysteryScientist', ?, 0)`).run(SUSPECTED_THRESHOLD + 4);
// Not a threat: has_intel = 0 but science level below threshold.
db.prepare(`INSERT INTO players (id, name, science_level, has_intel) VALUES (5, 'LowScience', ?, 0)`).run(SUSPECTED_THRESHOLD - 5);
// Confirmed AND high science, but has_intel = 1 — must land in "confirmed" only, never
// double-counted into "suspected" too (suspected is has_intel = 0 exclusively).
db.prepare(`INSERT INTO players (id, name, biology, science_level, has_intel) VALUES (6, 'ScannedAndStrong', ?, ?, 1)`).run(CONFIRMED_THRESHOLD, CONFIRMED_THRESHOLD + 14);

// A second caller, this one IN an alliance, for the own-alliance exclusion below. The
// original caller above has no alliance at all, which is what keeps that whole section a
// valid test of the unfiltered behaviour.
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (60, 'Friends', 'FRND')`).run();
db.prepare(`INSERT INTO players (id, name, biology, alliance_id) VALUES (10, 'AllyLeader', ?, 60)`).run(MY_BIO);
db.prepare(`INSERT INTO players (id, name, biology, has_intel, alliance_id) VALUES (11, 'MateWithBio', ?, 1, 60)`).run(CONFIRMED_THRESHOLD);
db.prepare(`INSERT INTO players (id, name, science_level, has_intel, alliance_id) VALUES (12, 'MateWithScience', ?, 0, 60)`).run(SUSPECTED_THRESHOLD + 4);
db.prepare(`INSERT INTO players (id, name, biology, has_intel, alliance_id) VALUES (13, 'RivalWithBio', ?, 1, 50)`).run(CONFIRMED_THRESHOLD);
db.prepare(`INSERT INTO players (id, name, science_level, has_intel) VALUES (14, 'LoneWolf', ?, 0)`).run(SUSPECTED_THRESHOLD + 4);

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── bio-threats for a known player ' + '─'.repeat(30));
        const res = await getJson(server, '/hub-api/intel/bio-threats');
        ok('responds 200', res.status === 200, res);
        ok(`myBio resolves to the caller's own biology (${MY_BIO})`, res.body && res.body.myBio === MY_BIO, res.body);
        ok(`confirmed bar is myBio + ${playersRepo.BIO_THREAT_MARGIN_CONFIRMED} = ${CONFIRMED_THRESHOLD}`,
            res.body && res.body.confirmedThreshold === CONFIRMED_THRESHOLD, res.body);
        ok(`suspected bar is LOWER — myBio + ${playersRepo.BIO_THREAT_MARGIN_SUSPECTED} = ${SUSPECTED_THRESHOLD} — because science level is only a ceiling`,
            res.body && res.body.suspectedThreshold === SUSPECTED_THRESHOLD, res.body);

        const confirmedNames = (res.body.confirmed || []).map(p => p.name).sort();
        // This caller has NO alliance, so the own-alliance exclusion removes nobody — which
        // is exactly what makes this section a test of the unfiltered classification. The
        // mates/rival below belong to the alliance-caller section further down.
        ok('confirmed list holds every player with real bio >= threshold and has_intel=1',
            JSON.stringify(confirmedNames) === JSON.stringify(['BioGiant', 'MateWithBio', 'RivalWithBio', 'ScannedAndStrong']), confirmedNames);
        ok('confirmedCount matches the list length (4)', res.body.confirmedCount === 4, res.body.confirmedCount);
        ok('JustUnder (one below the RED bar) is not red', !confirmedNames.includes('JustUnder'));

        const suspectedNames = (res.body.suspected || []).map(p => p.name).sort();
        // Yellow catches BOTH kinds of "worth watching": an unscanned player whose science
        // ceiling clears the lower bar, AND a CONFIRMED player above that bar but below the
        // red one. Splitting one margin into two originally left the latter in neither list
        // — JustUnder, at +5, matched no query at all — so this pins the hole shut.
        ok('yellow holds the unscanned players AND the confirmed one between the two bars',
            JSON.stringify(suspectedNames) === JSON.stringify(['JustUnder', 'LoneWolf', 'MateWithScience', 'MysteryScientist']), suspectedNames);
        ok('suspectedCount matches (4)', res.body.suspectedCount === 4, res.body.suspectedCount);
        ok('LowScience (science below threshold) is excluded', !suspectedNames.includes('LowScience'));
        ok('ScannedAndStrong never appears in suspected despite high science (has_intel=1, so it is CONFIRMED not suspected)',
            !suspectedNames.includes('ScannedAndStrong'), suspectedNames);

        ok('the caller never appears in either of their own lists',
            !confirmedNames.includes('Caveman') && !suspectedNames.includes('Caveman'));

        const bioGiant = res.body.confirmed.find(p => p.name === 'BioGiant');
        ok('a confirmed row carries player_id (for a clickable link) and the alliance tag',
            bioGiant && bioGiant.player_id === 2 && bioGiant.ally_tag === 'RAID', bioGiant);

        // Requested by another alliance running the hub (2026-09-15): your own mates crowd
        // the list without ever being the thing it is read for — they cannot attack you. The
        // exclusion happens in SQL, before the queries' LIMIT 25, so it does not merely hide
        // them but frees those rows for players who are actually a threat.
        console.log('\n── your own alliance is not a threat to you ' + '─'.repeat(28));
        const appAlly = express();
        appAlly.use(express.json());
        appAlly.use((req, res, next) => { req.session = { userId: 2, gameName: 'AllyLeader' }; next(); });
        appAlly.use('/hub-api', intelRouter);
        const serverAlly = appAlly.listen(0);
        await new Promise((resolve) => serverAlly.once('listening', resolve));
        try {
            const resAlly = await getJson(serverAlly, '/hub-api/intel/bio-threats');
            const names = [...(resAlly.body.confirmed || []), ...(resAlly.body.suspected || [])].map(p => p.name);
            ok('an alliance mate with confirmed biology over the bar is not listed',
                !names.includes('MateWithBio'), names);
            ok('nor is an unscanned mate whose science level clears the bar',
                !names.includes('MateWithScience'), names);
            ok('a rival in another alliance at the very same biology still is',
                names.includes('RivalWithBio'), names);
            // The IFNULL guard in the SQL: an unaffiliated player's NULL alliance must not be
            // read as "same alliance as me" and quietly swept out with the mates.
            ok('and so is a player with no alliance at all', names.includes('LoneWolf'), names);
            ok('the counts follow the filtered lists, so pill and modal cannot disagree',
                resAlly.body.confirmedCount === (resAlly.body.confirmed || []).length
                && resAlly.body.suspectedCount === (resAlly.body.suspected || []).length, resAlly.body);
        } finally {
            serverAlly.close();
        }

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
