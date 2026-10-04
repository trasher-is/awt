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
const calls = [], messages = new Map(), coverUpdates = [], replies = [];
const discordPath = require.resolve('../discord_bot');
require.cache[discordPath] = {
    id: discordPath, filename: discordPath, loaded: true,
    exports: {
        // Mirrors the real postIncomingOnce: a known message is left alone, never edited.
        async postIncomingOnce(key, content) {
            const old = incomingRepo.getMessageRef(key);
            const existed = !!(old && old.message_id);
            calls.push({ key, existed });
            if (existed) return { ok: true, existed, messageId: old.message_id, channelId: 'synthetic-channel' };
            const messageId = `synthetic-${calls.length}`;
            incomingRepo.upsertMessageRef(key, 'synthetic-channel', messageId);
            messages.set(key, content);
            return { ok: true, existed, messageId, channelId: 'synthetic-channel' };
        },
        async replyToIncoming(channelId, messageId, text) { replies.push({ messageId, text }); return true; },
        async replyIncomingCover(key, name, added) { coverUpdates.push(key); return true; }
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
    // x-test-name lets the live-panel tests open streams as different members.
    req.session = { userId: 1, gameName: req.get('x-test-name') || 'SyntheticCoverOne' };
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
            path: endpoint.startsWith('/') ? `/hub-api${endpoint}` : `/hub-api/incoming/${endpoint}`, method: 'POST',
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
function get(server, pathAndQuery) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port, path: `/hub-api/${pathAndQuery}` }, response => {
            let raw = '';
            response.on('data', chunk => { raw += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
        }).on('error', reject);
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
        ok('a live incoming opens its own alert', first.status === 200 && first.body.existed === false && calls[0].key === key1, first);
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
        ok('a timed announcement still adopts the legacy untimed alert', untimed.status === 200 && live.body.existed === true && calls[0].key === base && calls[1].key === base, live);
        const untimedAgain = await post(server, 'announce', report(0));
        ok('a genuinely untimed report still lands on the known live wave', untimedAgain.status === 200 && untimedAgain.body.existed === true && calls.at(-1).key === base, untimedAgain);

        // 2026-09-15: the alert named the attacker and the planet but never the player
        // being attacked, so readers could not tell whose planet was in danger.
        reset();
        db.prepare('INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)').run(4321, 'SyntheticTargetSystem', 2, 2);
        db.prepare('INSERT INTO alliances (id, name, tag) VALUES (?, ?, ?)').run(77, 'SyntheticAlliance', 'SYN');
        db.prepare('INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)').run(9001, 'SyntheticDefender', 77);
        db.prepare('INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (?, ?, ?, ?)').run(990001, 4321, 7, 9001);
        db.prepare('INSERT INTO app_users (game_name, password_hash, discord_id) VALUES (?, ?, ?)').run('SyntheticDefender', 'synthetic', '424242');
        const owned = await post(server, 'announce', {
            attacker: { name: 'SyntheticAttacker' },
            target: { systemId: 4321, planetIndex: 7, planetName: 'SyntheticTargetSystem #7' },
            arrivalUnix: T1, cv: 100
        });
        const ownedMsg = messages.get(`4321:7:syntheticattacker:${T1}`);
        ok('the alert names the attacked player', owned.status === 200 && /SyntheticDefender/.test(ownedMsg), ownedMsg);
        ok('and their alliance tag', /\[SYN\]/.test(ownedMsg || ''), ownedMsg);
        ok('and pings them — a defenceless owner never appears in the roster below',
            /<@424242>/.test(ownedMsg || ''), ownedMsg);

        // 2026-10-04: two fleets from one attacker landing in the same cycle shared one
        // alert, and the second report rewrote the first fleet's message.
        reset();
        const fleetA = { ...report(T1, 153), ships: { destroyers: 51, transports: 5 } };
        const fleetB = { ...report(T1 + 20, 27), ships: { destroyers: 9 } };
        await post(server, 'announce', fleetA);
        const firstText = messages.get(key1);
        const b = await post(server, 'announce', fleetB);
        const keyB = calls.at(-1).key;
        ok('a second fleet in the same cycle gets its own alert', b.body.existed === false && keyB !== key1 && messages.has(keyB), calls);
        const fleetC = { ...report(T1, 60), ships: { destroyers: 20 } };
        await post(server, 'announce', fleetC);
        ok('a third fleet on the exact same second gets a ship-tagged key', calls.at(-1).key === `${key1}:20-0-0` && !calls.at(-1).existed, calls.at(-1));
        ok('and the first fleet\'s alert is untouched', messages.get(key1) === firstText && /51 DS/.test(firstText), firstText);
        const again = await post(server, 'announce', { ...fleetA, arrivalUnix: T1 + 30 });
        ok('re-reporting the first fleet finds its alert and does not post or edit', again.body.existed === true && calls.at(-1).key === key1 && messages.get(key1) === firstText, calls.at(-1));
        ok('the alert carries no "updated" footer any more (it is never edited)', !/_updated/.test(firstText), firstText);
        const coverB = await post(server, 'cover', { ...fleetB });
        ok('a cover click with ship counts claims the right fleet', coverB.status === 200 && getCovering(keyB).includes('SyntheticCoverOne') && getCovering(key1).length === 0, coverB);
        ok('and is posted as a reply under that fleet\'s alert', coverUpdates.at(-1) === keyB, coverUpdates);

        // 2026-10-04: the attacker fights the planet's starbase first. A starbase that holds
        // on its own says so and pings nobody; one that does not shows what its own saved PP
        // can still buy before the attack lands.
        reset();
        db.prepare('UPDATE planets SET starbase = 12 WHERE system_id = 4321 AND planet_index = 7').run();
        await post(server, 'announce', {
            attacker: { name: 'SyntheticRaider' }, target: { systemId: 4321, planetIndex: 7, planetName: 'SyntheticTargetSystem #7' },
            arrivalUnix: T1, cv: 27, ships: { destroyers: 9 }
        });
        const strongMsg = messages.get(`4321:7:syntheticraider:${T1}`) || '';
        ok('a starbase that beats the attack alone says so', /Holds on its own\*\* — SB 12/.test(strongMsg), strongMsg);
        ok('and lists no defenders to fly in', !/Land right AFTER|Can defend in time/.test(strongMsg), strongMsg);

        reset();
        db.prepare('UPDATE planets SET starbase = 0 WHERE system_id = 4321 AND planet_index = 7').run();
        db.prepare(`INSERT INTO planet_banking (game_planet_id, player_id, system_id, name, production_pp, production_rate)
                    VALUES (990001, 9001, 4321, 'SyntheticTargetSystem #7', 300, 0)`).run();
        await post(server, 'announce', {
            attacker: { name: 'SyntheticRaider' }, target: { systemId: 4321, planetIndex: 7, planetName: 'SyntheticTargetSystem #7' },
            arrivalUnix: T1, cv: 27, ships: { destroyers: 9 }
        });
        const weakMsg = messages.get(`4321:7:syntheticraider:${T1}`) || '';
        ok('a planet without a starbase shows what is left of the attacker on it', /Planet alone\*\* — no starbase: falls · the enemy keeps 9 DS \(27 CV\)/.test(weakMsg), weakMsg);
        ok('and the starbase its own saved PP buys before arrival', /SyntheticDefender\*\*: the PP saved there reaches \*\*SB \d+\*\*/.test(weakMsg), weakMsg);
        ok('nobody with a real chance says so, for keeping and for retaking',
            /Nobody can keep it with a real chance \(25%\+\)/.test(weakMsg) && /Nobody can retake it in time with a real chance/.test(weakMsg), weakMsg);
        ok('an attacker the hub never scanned is flagged as a worst-case guess', /never scanned` — worst case assumed/.test(weakMsg), weakMsg);
        ok('the retake window is the attacker\'s 2-minute cycle', /land <t:1800000000:T>–<t:1800000119:T>, same cycle/.test(weakMsg), weakMsg);

        // The owner with enough PP builds on the attacked planet itself: no flight, and he
        // stands with his starbase; the line says the fleet assumes PP saved until launch.
        reset();
        db.prepare('UPDATE planet_banking SET production_pp = 3000, production_rate = 100 WHERE game_planet_id = 990001').run();
        await post(server, 'announce', {
            attacker: { name: 'SyntheticRaider' }, target: { systemId: 4321, planetIndex: 7, planetName: 'SyntheticTargetSystem #7' },
            arrivalUnix: T1, cv: 27, ships: { destroyers: 9 }
        });
        const richMsg = messages.get(`4321:7:syntheticraider:${T1}`) || '';
        ok('the owner\'s own build is the first way to keep it, with his starbase',
            /Keep it\*\* — land before[^\n]*\n1\. 🏗️ \*\*SyntheticDefender\*\*[^\n]*· holds 100%[^\n]*build by <t:1799999999:T> \*\(own fleet \+ SB/.test(richMsg), richMsg);
        ok('the report is stored for the Defence panel', (() => { const r = incomingRepo.getIncoming(`4321:7:syntheticraider:${T1}`); return r && r.payload.ships.destroyers === 9 && r.payload.arrivalUnix === T1; })());

        // The Defence panel: the live list, and the full analysis of one attack.
        const liveList = await get(server, 'defence/live');
        const richKey = `4321:7:syntheticraider:${T1}`;
        ok('the live list carries the stored attack, with its owner', liveList.status === 200
            && liveList.body.attacks.some(a => a.key === richKey && a.ownerName === 'SyntheticDefender' && a.ships.destroyers === 9), liveList.body);
        const detail = await get(server, `defence/attack?key=${encodeURIComponent(richKey)}`);
        const d = detail.body;
        ok('the panel analysis recomputes the planet fight', detail.status === 200 && d.planet && d.planet.sbLevel === 0 && /the enemy keeps 9 DS/.test(d.planet.outcomeText), d.planet);
        ok('and lists every starbase level the saved PP reaches, cheapest first',
            d.sbOptions.length >= 7 && d.sbOptions[0].level === 1 && d.sbOptions.every((o, k) => k === 0 || o.cost > d.sbOptions[k - 1].cost), d.sbOptions);
        ok('every member option is there, grouped by member', d.members.some(m => m.name === 'SyntheticDefender' && m.options.length >= 1), d.members);
        ok('the keep list matches the alert\'s', d.keep[0] && d.keep[0].name === 'SyntheticDefender' && d.keep[0].winText === '100%', d.keep);
        ok('the cycle window is part of it', d.window && d.window.cycleEnd === T1 + 119, d.window);
        const missing = await get(server, 'defence/attack?key=nope');
        ok('an unknown attack is a 404', missing.status === 404);

        // Landing planner (2026-10-04): chains of landings, and the sacrifice search.
        {
            const own = await post(server, '/defence/plan', { key: richKey, landings: [{ name: 'SyntheticDefender', ships: [40, 0, 0], when: 'before' }] });
            ok('the planet owner landing first never fights his own planet',
                own.status === 200 && own.body.chain.likely[0].fight === false && own.body.chain.held > 0.99, own.body.chain);
            const two = await post(server, '/defence/plan', { key: richKey, landings: [
                { name: 'SyntheticAllyA', ships: [30, 0, 0], when: 'before' },
                { name: 'SyntheticAllyB', ships: [30, 0, 0], when: 'before' }] });
            ok('a second ally landing first fights the first one', two.body.chain.likely[1].fight && two.body.chain.likely[1].against === 'SyntheticAllyA', two.body.chain.likely);
            ok('the outcomes add up to 1', Math.abs(two.body.chain.held + two.body.chain.retaken + two.body.chain.lost - 1) < 1e-9, two.body.chain);
            const sac = await post(server, '/defence/plan', { key: richKey, landings: [],
                sacrifice: { decoy: { name: 'SyntheticAllyA', ships: [20, 0, 0] }, closer: { name: 'SyntheticAllyB', ships: [8, 0, 0] } } });
            ok('the sacrifice search answers best, cheapest, the closer alone, and a table',
                sac.status === 200 && sac.body.sacrifice.best && sac.body.sacrifice.cheapest && sac.body.sacrifice.baseline
                && sac.body.sacrifice.table.length > 0 && sac.body.sacrifice.cheapest.cv <= sac.body.sacrifice.best.cv, sac.body.sacrifice);
            const badSac = await post(server, '/defence/plan', { key: richKey, sacrifice: { decoy: { name: 'X' } } });
            ok('a sacrifice question without both fleets is refused', badSac.status === 400);
            const capped = await post(server, '/defence/plan', { key: richKey,
                landings: Array.from({ length: 30 }, (_, k) => ({ name: `A${k}`, ships: [1, 0, 0], when: 'after' })) });
            ok('at most 12 landings are simulated', capped.status === 200 && capped.body.chain.likely.length <= 13, capped.body.chain.likely.length);
            const nope = await post(server, '/defence/plan', { key: 'nope', landings: [] });
            ok('planning an unknown attack is a 404', nope.status === 404);
        }

        // Live panel (2026-10-04): who is looking, and choices pushed to everyone at once.
        {
            const openStream = (name) => new Promise((resolve, reject) => {
                const events = [];
                const req = http.get({ hostname: '127.0.0.1', port: server.address().port,
                    path: `/hub-api/defence/stream?key=${encodeURIComponent(richKey)}`, headers: { 'x-test-name': name } }, res => {
                    let buf = '';
                    res.on('data', chunk => {
                        buf += chunk;
                        let i;
                        while ((i = buf.indexOf('\n\n')) >= 0) {
                            const block = buf.slice(0, i); buf = buf.slice(i + 2);
                            const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
                            if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
                        }
                    });
                    resolve({ req, res, events, headers: res.headers });
                }).on('error', reject);
            });
            const settle = () => new Promise(r => setTimeout(r, 80));
            const lastOf = (s, event) => [...s.events].reverse().find(e => e.event === event);

            const a = await openStream('SyntheticCoverOne');
            await settle();
            ok('a stream is an unbuffered event stream (nginx passes it through)',
                a.headers['content-type'] === 'text/event-stream' && a.headers['x-accel-buffering'] === 'no', a.headers);
            ok('a new panel gets the current plan straight away', !!lastOf(a, 'plan'), a.events);
            const b = await openStream('SyntheticViewerTwo');
            await settle();
            ok('everyone watching sees who else is looking',
                JSON.stringify(lastOf(a, 'viewers').data.viewers) === '["SyntheticCoverOne","SyntheticViewerTwo"]', lastOf(a, 'viewers'));

            replies.length = 0;
            const chose = await post(server, '/defence/choose', { key: richKey, role: 'before',
                option: { source: 'build', cv: 318, eta: 0, note: 'build 78D 1C 1B at the planet itself', winText: '100%' } });
            await settle();
            const planB = lastOf(b, 'plan');
            ok('a choice reaches the other viewer without a refresh',
                chose.status === 200 && planB && planB.data.choices.some(c => c.name === 'SyntheticCoverOne' && c.role === 'before' && c.option.cv === 318), planB);
            ok('a choice is a cover claim too', planB.data.covering.includes('SyntheticCoverOne'), planB.data);
            ok('and is said under the Discord alert', replies.some(r => /🛡️ \*\*SyntheticCoverOne\*\* will land \*\*before\*\* them with 318 CV/.test(r.text)), replies);

            await post(server, '/defence/choose', { key: richKey, role: 'after', option: { source: 'orbit', cv: 50 } });
            await settle();
            ok('changing your mind replaces the choice, it does not add one',
                lastOf(b, 'plan').data.choices.filter(c => c.name === 'SyntheticCoverOne').length === 1
                && lastOf(b, 'plan').data.choices[0].role === 'after', lastOf(b, 'plan').data);

            const bad = await post(server, '/defence/choose', { key: richKey, role: 'sideways' });
            ok('only before / after / none are accepted', bad.status === 400);

            await post(server, '/defence/choose', { key: richKey, role: 'none' });
            await settle();
            ok('withdrawing clears the choice and the cover claim',
                lastOf(b, 'plan').data.choices.length === 0 && !lastOf(b, 'plan').data.covering.includes('SyntheticCoverOne'), lastOf(b, 'plan').data);

            await post(server, '/defence/choose', { key: richKey, role: 'before', option: { cv: 10 } });
            await post(server, 'cover', { attacker: { name: 'SyntheticRaider' }, target: { systemId: 4321, planetIndex: 7 },
                arrivalUnix: T1, ships: { destroyers: 9 } });
            await settle();
            ok('withdrawing cover from the News page withdraws the choice too, live',
                lastOf(b, 'plan').data.choices.length === 0 && !lastOf(b, 'plan').data.covering.includes('SyntheticCoverOne'), lastOf(b, 'plan').data);

            a.req.destroy();
            await settle();
            ok('closing a panel tells the others', JSON.stringify(lastOf(b, 'viewers').data.viewers) === '["SyntheticViewerTwo"]', lastOf(b, 'viewers'));
            b.req.destroy();
            await settle();
            const unknownStream = await get(server, 'defence/stream?key=nope');
            ok('no stream for an unknown attack', unknownStream.status === 404);
        }
        ok('and says it counts PP saved until launch, with what is there now', /at the planet itself if PP saved till launch \(now: \d+D/.test(richMsg), richMsg);

        reset();
        const unowned = await post(server, 'announce', report(T1));
        ok('a target whose owner we have never scanned still gets its alert, without a target line',
            unowned.status === 200 && !/🎯/.test(messages.get(key1) || ''), messages.get(key1));
    } finally {
        Date.now = savedNow;
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
