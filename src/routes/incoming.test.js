// Issue #161: a News replay after arrival must not open a duplicate alert or replace
// the next wave's ships, arrival or covering roster. Exercise the real routes and SQLite
// repositories; only the Discord boundary is stubbed, so there is no external traffic.
const http = require('http');
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-incoming-test-only';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const incomingRepo = require('../repositories/incoming');
const { getCovering, toggleCovering } = require('../utils/covering');
const calls = [], messages = new Map(), coverUpdates = [];
const discordPath = require.resolve('../discord_bot');
require.cache[discordPath] = {
    id: discordPath, filename: discordPath, loaded: true,
    exports: {
        async sendOrEditIncoming(key, content) {
            const old = incomingRepo.getMessageRef(key);
            const edited = !!(old && old.message_id);
            const messageId = edited ? old.message_id : `synthetic-${calls.length}`;
            incomingRepo.upsertMessageRef(key, 'synthetic-channel', messageId);
            messages.set(key, content);
            calls.push({ key, edited });
            return { ok: true, edited, messageId, channelId: 'synthetic-channel' };
        },
        async replyToIncoming() { throw new Error('No synthetic defenders should be pinged'); },
        async updateIncomingCover(key) { coverUpdates.push(key); return true; }
    }
};
const incomingRouter = require('./incoming');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ok - ${name}`); }
    else { fail++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    req.session = { userId: 1, gameName: 'SyntheticCoverOne' };
    next();
});
app.use('/hub-api', incomingRouter);
const T1 = 1_800_000_000, T2 = T1 + 3600;
const base = '1234:5:syntheticattacker';
const key1 = `${base}:${T1}`, key2 = `${base}:${T2}`;
const report = (arrivalUnix, cv = 100) => ({
    attacker: { name: 'SyntheticAttacker' },
    target: { systemId: 1234, planetIndex: 5 }, arrivalUnix, cv
});
const savedNow = Date.now;
let now = T1 - 7200;
Date.now = () => now * 1000;
db.prepare('INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)').run(1234, 'SyntheticSystem', 1, 1);

function post(server, endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const request = http.request({
            hostname: '127.0.0.1', port: server.address().port,
            path: `/hub-api/incoming/${endpoint}`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, response => {
            let raw = '';
            response.on('data', chunk => { raw += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
        });
        request.on('error', reject);
        request.end(data);
    });
}
const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM incoming_msgs ORDER BY alert_key').all());
function reset() {
    incomingRepo.deleteAllIncomingMsgs();
    calls.length = 0; coverUpdates.length = 0; messages.clear();
    now = T1 - 7200;
}

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        console.log('incoming.test.js');
        const first = await post(server, 'announce', report(T1));
        ok('a live incoming opens its own alert', first.status === 200 && first.body.edited === false && calls[0].key === key1, first);
        const cover = await post(server, 'cover', report(T1));
        ok('a live cover claim is attached to its wave', cover.status === 200 && getCovering(key1).includes('SyntheticCoverOne'), cover);
        now = T1 + 1;
        let before = snapshot();
        const replay = await post(server, 'announce', report(T1));
        ok('an expired replay is rejected rather than creating another alert', replay.status === 410 && replay.body.success === false && calls.length === 1, replay);
        ok('rejecting an expired replay preserves message reference and covering state', snapshot() === before);
        const read = await post(server, 'defenders', report(T1));
        ok('historical defender lookup reads the original covering roster', read.status === 200 && read.body.covering.includes('SyntheticCoverOne'), read);
        ok('historical defender lookup does not write identity rows', snapshot() === before);
        const retract = await post(server, 'cover', report(T1));
        ok('cover can be retracted after arrival on the same wave', retract.status === 200 && retract.body.added === false && getCovering(key1).length === 0 && coverUpdates.at(-1) === key1, retract);

        reset();
        await post(server, 'announce', report(T1));
        await post(server, 'announce', report(T2, 500));
        toggleCovering(key1, 'SyntheticCoverOne');
        toggleCovering(key2, 'SyntheticCoverTwo');
        const secondMessage = messages.get(key2);
        now = T1 + 1;
        before = snapshot();
        const replayWithNext = await post(server, 'announce', report(T1));
        ok('expired wave replay never edits the next live wave', replayWithNext.status === 410 && calls.length === 2 && messages.get(key2) === secondMessage, replayWithNext);
        ok('both waves keep their original identities and covering after rejection', snapshot() === before);
        const readWithNext = await post(server, 'defenders', report(T1));
        ok('historical covering does not switch to the next live wave', JSON.stringify(readWithNext.body.covering) === '["SyntheticCoverOne"]', readWithNext);
        await post(server, 'cover', report(T1));
        ok('historical cover retraction leaves the next wave untouched', getCovering(key1).length === 0 && JSON.stringify(getCovering(key2)) === '["SyntheticCoverTwo"]');

        reset();
        await post(server, 'announce', report(T1 + 60, 500));
        const nearKey = `${base}:${T1 + 60}`;
        toggleCovering(nearKey, 'SyntheticCoverTwo');
        now = T1 + 1;
        before = snapshot();
        const nearCover = await post(server, 'cover', report(T1));
        const nearRead = await post(server, 'defenders', report(T1));
        ok('an expired cover cannot adopt a still-live wave within arrival tolerance',
            nearCover.status === 410 && coverUpdates.length === 0 && snapshot() === before, nearCover);
        ok('an expired lookup cannot display a nearby live wave covering roster',
            nearRead.status === 200 && nearRead.body.covering.length === 0, nearRead);

        reset();
        now = T1;
        before = snapshot();
        const unknownExpired = await post(server, 'announce', report(T1));
        const unknownCover = await post(server, 'cover', report(T1));
        const unknownRead = await post(server, 'defenders', report(T1));
        ok('the arrival boundary rejects an unknown expired announcement', unknownExpired.status === 410 && calls.length === 0, unknownExpired);
        ok('an unknown expired cover claim is rejected', unknownCover.status === 410 && coverUpdates.length === 0, unknownCover);
        ok('an unknown expired defender lookup has an empty covering roster', unknownRead.status === 200 && unknownRead.body.covering.length === 0, unknownRead);
        ok('unknown expired requests cannot create identity or covering rows', snapshot() === before);

        reset();
        before = snapshot();
        // Arrival can pass between the announce guard and the resolver's own clock read.
        let clockReads = 0;
        Date.now = () => (clockReads++ === 0 ? T1 - 1 : T1) * 1000;
        const crossing = await incomingRouter.announceIncoming(report(T1));
        Date.now = () => now * 1000;
        ok('crossing arrival during resolution cannot send an untracked null-key alert',
            crossing.ok === false && crossing.status === 410 && calls.length === 0 && snapshot() === before, crossing);

        reset();
        await post(server, 'announce', report(T1));
        before = snapshot();
        clockReads = 0;
        Date.now = () => (clockReads++ === 0 ? T1 - 1 : T1) * 1000;
        const knownCrossing = await incomingRouter.announceIncoming(report(T1));
        Date.now = () => now * 1000;
        ok('crossing arrival with a stored identity still cannot reach Discord',
            knownCrossing.ok === false && knownCrossing.status === 410 && calls.length === 1 && snapshot() === before, knownCrossing);

        reset();
        before = snapshot();
        const liveRead = await post(server, 'defenders', report(T1));
        ok('a live read-only lookup does not create an identity', liveRead.status === 200 && snapshot() === before, liveRead);
        const untimed = await post(server, 'announce', report(0));
        // SQLite's CURRENT_TIMESTAMP uses the wall clock, independently of Date.now.
        db.prepare('UPDATE incoming_msgs SET updated_at = ? WHERE alert_key = ?')
            .run(new Date(now * 1000).toISOString().slice(0, 19).replace('T', ' '), base);
        const live = await post(server, 'announce', report(T1));
        ok('a timed announcement still adopts the legacy untimed alert', untimed.status === 200 && live.body.edited === true && calls[0].key === base && calls[1].key === base, live);
        const untimedAgain = await post(server, 'announce', report(0));
        ok('a genuinely untimed report still edits the known live wave', untimedAgain.status === 200 && untimedAgain.body.edited === true && calls.at(-1).key === base, untimedAgain);
    } finally {
        Date.now = savedNow;
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
