// Alliance-wide intel visibility, end to end through the route that can actually see it.
//
// THE BUG THIS EXISTS FOR (2026-09-15): the feature shipped hooked onto /sync/player-detail,
// the API sweep, on the reasoning that it walks the whole roster continuously and so observes
// every player rather than only whoever someone happened to open. The reasoning was sound;
// the signal was not. The API's Player/{id} response carries no intelligenceReport for us at
// all, so that route reports has_intel: 0 for everyone, forever. Measured in production: over
// two days and roughly a hundred sweep cycles, intel_visible was 0 or NULL for all 160
// players and never once 1, while 17 of them held intel the whole time.
//
// The consequence was not "fewer announcements" but "none, ever, of any kind": a permanent
// stream of zeros pins the confirmed state at not-visible, so no capture could ever read as
// a change. An earlier fix to the decision function's check ORDER was a real bug fix and
// still could not help, because the input feeding it was never true.
//
// The profile scrape is the honest observer — player-parser.js reads visibility off whether
// the page rendered its table.ir-summary block — so the announcements live here now. It
// samples sparsely (only when a member opens a profile), which is exactly why first_ever
// being exempt from the two-consecutive-observations rule matters: a fresh capture is the
// case the alliance actually cares about and it announces on the spot.
//
// Run with: node src/routes/sync-player-intel-visibility.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-player-intel-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

// With DISCORD_TOKEN unset the real sender no-ops silently, which cannot tell "correctly
// stayed quiet" apart from "never got there" — the exact distinction every check below turns
// on. So the bot is mocked into an observable list instead.
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

console.log('sync-player-intel-visibility.test.js');

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
            res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

(async () => {
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));

    try {
        // Shaped like public/js/scrapers/player-parser.js's output: `visible` stands for the
        // page having rendered its table.ir-summary block, which is the whole signal.
        const scrape = (id, visible, extra = {}) => postJson(server, '/hub-api/sync/player', {
            id, name: 'Watched', alliance_tag: 'FOE', level: 2, points: 2, logins: 0,
            has_intel: visible ? 1 : 0,
            biology: visible ? 3 : 0, economy: visible ? 6 : 0, energy: visible ? 8 : 0,
            mathematics: visible ? 6 : 0, physics: visible ? 3 : 0, social: visible ? 3 : 0,
            ...extra,
        });
        const titles = () => variousChanges.map(c => c.title);

        console.log('\n-- A first-ever capture, which is the case the bug swallowed ' + '-'.repeat(9));
        variousChanges.length = 0;
        await scrape(700, false);
        ok('the very first scrape of an unknown player is silent — it only sets a baseline',
            variousChanges.length === 0, titles());

        await scrape(700, true);
        const firstEver = variousChanges.filter(c => c.title.includes('First intel'));
        ok('the first ever capture announces immediately, without waiting for a second scrape',
            firstEver.length === 1, titles());
        ok('and it names the player it is about',
            firstEver[0] && firstEver[0].description.includes('Watched'), firstEver[0]);
        ok('the confirmed state moves with it',
            db.prepare('SELECT intel_visible FROM players WHERE id = 700').get().intel_visible === 1);

        // A player with no row AT ALL is the one case that stays silent even when the scrape
        // shows intel, and deliberately so: mass-scanner.js posts this route in bulk, so a
        // fresh database meeting the roster for the first time would otherwise announce a
        // capture for every player at once, describing nothing that changed. In production
        // it is close to unreachable anyway — the roster list sync seeds a row for all ~160
        // players, so anyone whose profile can be opened is already stored, which is why
        // this costs no real announcements. The case that DOES matter is the one above:
        // stored player, has_intel still 0, scrape sees a report.
        console.log('\n-- A player with no row at all is still a silent baseline ' + '-'.repeat(11));
        variousChanges.length = 0;
        await scrape(701, true);
        ok('a never-stored player records silently, so a bulk first scan cannot flood',
            variousChanges.length === 0, titles());
        ok('and the capture is still recorded, so the NEXT change is measured against it',
            db.prepare('SELECT intel_visible FROM players WHERE id = 701').get().intel_visible === 1);

        console.log('\n-- Losing and regaining still needs two consecutive observations ' + '-'.repeat(5));
        variousChanges.length = 0;
        await scrape(700, false);
        ok('one missed sighting stays quiet — a fleet drifting out of range is not news',
            variousChanges.length === 0, titles());
        ok('and the confirmed state has not moved yet',
            db.prepare('SELECT intel_visible FROM players WHERE id = 700').get().intel_visible === 1);

        await scrape(700, false);
        ok('a second consecutive miss announces the loss',
            titles().some(t => t.includes('Intel lost')), titles());
        ok('and the confirmed state follows',
            db.prepare('SELECT intel_visible FROM players WHERE id = 700').get().intel_visible === 0);

        variousChanges.length = 0;
        await scrape(700, true);
        ok('one sighting back is not yet a regain', variousChanges.length === 0, titles());
        await scrape(700, true);
        ok('two in a row announces the regain — and as a regain, not a second first capture',
            variousChanges.filter(c => c.title.includes('Intel regained')).length === 1, titles());

        variousChanges.length = 0;
        await scrape(700, true);
        await scrape(700, true);
        ok('steady visibility says nothing, scrape after scrape', variousChanges.length === 0, titles());

        // has_intel latches to 1 forever, so a sightless scrape must not be allowed to drag
        // the hard-won stat columns back to the parser's zero defaults.
        console.log('\n-- A sightless scrape does not erase the intel itself ' + '-'.repeat(16));
        await scrape(700, false);
        await scrape(700, false);
        const kept = db.prepare('SELECT has_intel, biology, energy FROM players WHERE id = 700').get();
        ok('has_intel stays latched and the captured values survive losing vision',
            kept.has_intel === 1 && kept.biology === 3 && kept.energy === 8, kept);

        // The one-shot baseline reset in database.js depends on this being the safe state:
        // NULL means "no baseline", which records silently instead of reading 0 -> 1 as a
        // change and announcing a regain for a player that was never lost.
        console.log('\n-- A cleared baseline records silently rather than crying regain ' + '-'.repeat(5));
        variousChanges.length = 0;
        db.prepare(`UPDATE players SET intel_visible = NULL, intel_seen_raw = NULL WHERE id = 700`).run();
        await scrape(700, true);
        ok('the scrape after a baseline reset announces nothing', variousChanges.length === 0, titles());
        ok('but it does establish the baseline it just observed',
            db.prepare('SELECT intel_visible FROM players WHERE id = 700').get().intel_visible === 1);
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
