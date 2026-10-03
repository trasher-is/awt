// A population drop is applied, logged and announced only once a later read confirms it.
//
// The failure this prevents (seen live in two separate hubs, 2026-10-03): a member's read lands just
// after a growth tick carrying the PRE-growth figure, so the hub logged a drop and posted a Population
// Drop alert; every other member's read then (correctly) claimed the old figure again, and the regrowth
// guard refused all of them for four hours, leaving the wrong number in place. Real losses stay low for
// every reader, so they are simply confirmed a read later.
//
// Drives the REAL /sync/system transaction against a scratch database, with synthetic ids and names (the
// repository is public) and a controllable clock. No game or Discord requests are made. The older suites
// that are about what a drop DOES run with the delay switched off; this one runs with the default.
//
// Run with: node src/routes/sync-population-provisional-drop.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-provisional-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.POP_DROP_CONFIRM_MS; // the real default
const announcements = [];
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: {
    announceSystemChanges: async (system, events) => announcements.push({ system, events }),
    announceSystemMilestones: async () => {},
} };
const express = require('express');
const db = require('../database');

// A clock the test can move: the route's "later read" timing uses Date.now().
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = ms => { skew += ms; };
const S = 1000, MIN = 60 * S;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    req.session = { userId: Number(req.headers['x-test-user'] || 1), gameName: req.headers['x-test-name'] || 'Tester' };
    next();
});
app.use('/hub-api', require('./sync'));

let failed = 0;
function ok(name, condition, detail) {
    console.log(`  ${condition ? 'ok' : 'NOT OK'} - ${name}${!condition && detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`);
    if (!condition) failed++;
}

const addUser = db.prepare("INSERT INTO app_users (game_name, password_hash, role) VALUES (?, 'not-a-real-hash', 'user')");
const memberA = 1;
const memberB = Number(addUser.run('MemberB').lastInsertRowid);
const memberC = Number(addUser.run('MemberC').lastInsertRowid);
const owner = { id: 6001, name: 'PendingOwner' }, other = { id: 6002, name: 'OtherOwner' };
const planet = (index, population, extra = {}) => ({ planet_index: index, starbase: 0, owner, population, ...extra });

const popDropsAnnounced = () => announcements.flatMap(a => a.events).filter(e => e.type === 'POP_DROP');
const eventsFor = systemId => db.prepare('SELECT old_value o, new_value n FROM planet_events WHERE system_id=? AND event_type_id=2').all(systemId);
const stored = (systemId, index = 1) => db.prepare('SELECT population p, population_observed_at at FROM planets WHERE system_id=? AND planet_index=?').get(systemId, index);
const traceOf = (systemId, index = 1) => db.prepare('SELECT * FROM population_trace WHERE system_id=? AND planet_index=? ORDER BY id').all(systemId, index);
const outcomes = (systemId, index = 1) => traceOf(systemId, index).map(r => r.outcome);

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const sync = async (systemId, planets, actor = memberA, extra = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/hub-api/sync/system`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-test-user': String(actor), 'x-test-name': actor === memberA ? 'Tester' : `Member${actor}` },
            body: JSON.stringify({ system_id: systemId, planets, source: 'api-seed', ...extra }),
        });
        if (!response.ok) throw new Error(`Sync failed: ${response.status} ${await response.text()}`);
        return response.json();
    };

    try {
        console.log('sync-population-provisional-drop.test.js');

        console.log('\n── a blip: one stale read, then the real figure comes back ' + '─'.repeat(15));
        // The exact sequence from the field: a planet at 12, one read says 11, four seconds later another says 12.
        await sync(6000, [planet(1, 12)]);
        const before = stored(6000);
        await sync(6000, [planet(1, 11)], memberA);
        ok('a lower read is held: the planet keeps its figure', stored(6000).p === 12, stored(6000));
        ok('...nothing is logged as a drop', eventsFor(6000).length === 0, eventsFor(6000));
        ok('...and nothing is announced', popDropsAnnounced().length === 0, popDropsAnnounced());
        ok('...it is recorded in the trace as pending, with the figure that was claimed',
            same(outcomes(6000), ['drop_pending']) && traceOf(6000)[0].claimed_pop === 11 && traceOf(6000)[0].stored_pop === 12, traceOf(6000));
        advance(4 * S);
        await sync(6000, [planet(1, 12)], memberB);
        ok('4 seconds later another member reads the old figure: the claim is discarded as a blip', same(outcomes(6000), ['drop_pending', 'drop_blip']), outcomes(6000));
        ok('...the blip row says how long it stood (about 4 seconds)', Math.abs(traceOf(6000)[1].hours_since_change * 3600 - 4) < 1, traceOf(6000)[1].hours_since_change);
        ok('...the correction is NOT refused as a rise (the regrowth guard never saw a lower figure)', !outcomes(6000).includes('rise_rejected'), outcomes(6000));
        ok('...still no drop, no alert, and the planet\'s change clock never moved',
            eventsFor(6000).length === 0 && popDropsAnnounced().length === 0 && stored(6000).at === before.at && stored(6000).p === 12, { ev: eventsFor(6000), at: stored(6000).at, was: before.at });

        console.log('\n── a real loss: it stays low, and is confirmed a read later ' + '─'.repeat(14));
        await sync(6001, [planet(1, 12)]);
        await sync(6001, [planet(1, 11)], memberA);
        advance(3 * MIN);
        const announcedBefore = popDropsAnnounced().length;
        await sync(6001, [planet(1, 11)], memberB);
        ok('another member still sees it low 3 minutes later: now it is a drop (12 → 11)', same(eventsFor(6001), [{ o: 12, n: 11 }]), eventsFor(6001));
        ok('...exactly one bombardment alert, with the original figure', popDropsAnnounced().length === announcedBefore + 1
            && popDropsAnnounced().at(-1).kind === 'bombardment' && popDropsAnnounced().at(-1).old_pop === 12 && popDropsAnnounced().at(-1).new_pop === 11, popDropsAnnounced().at(-1));
        ok('...the planet now holds 11', stored(6001).p === 11, stored(6001));
        ok('...the trace shows the held claim and then the confirmed drop, the drop credited to the confirming member',
            same(outcomes(6001), ['drop_pending', 'drop']) && traceOf(6001)[1].actor_user_id === memberB, traceOf(6001).map(r => [r.outcome, r.actor_user_id]));

        console.log('\n── the same member has to wait for their next run ' + '─'.repeat(24));
        await sync(6002, [planet(1, 12)]);
        await sync(6002, [planet(1, 11)], memberA);
        advance(3 * MIN);
        await sync(6002, [planet(1, 11)], memberA);
        ok('the same member reading it low again within one run (3 minutes) does not confirm it', eventsFor(6002).length === 0 && stored(6002).p === 12, eventsFor(6002));
        advance(90 * S);
        await sync(6002, [planet(1, 11)], memberA);
        ok('...their next run (4.5 minutes in) does', same(eventsFor(6002), [{ o: 12, n: 11 }]) && stored(6002).p === 11, eventsFor(6002));

        console.log('\n── one stale read hitting several planets at once ' + '─'.repeat(24));
        await sync(6003, [planet(1, 3), planet(2, 6), planet(3, 6)]);
        const announced3 = popDropsAnnounced().length;
        await sync(6003, [planet(1, 2), planet(2, 5), planet(3, 5)], memberA);
        ok('three planets read one level low are all held', [1, 2, 3].every(i => outcomes(6003, i)[0] === 'drop_pending') && [3, 6, 6].every((p, i) => stored(6003, i + 1).p === p), [1, 2, 3].map(i => stored(6003, i).p));
        advance(41 * S);
        await sync(6003, [planet(1, 3), planet(2, 6), planet(3, 6)], memberB);
        ok('another member\'s read restores all three: three blips, no drops, no alerts',
            [1, 2, 3].every(i => same(outcomes(6003, i), ['drop_pending', 'drop_blip'])) && eventsFor(6003).length === 0 && popDropsAnnounced().length === announced3, [1, 2, 3].map(i => outcomes(6003, i)));

        console.log('\n── an ownership change is never held ' + '─'.repeat(37));
        await sync(6004, [planet(1, 6)]);
        await sync(6004, [planet(1, 2, { owner: other })], memberA);
        ok('a conquest is an event of its own: the planet changes hands at once and the wipe is logged and announced',
            stored(6004).p === 2 && same(eventsFor(6004), [{ o: 6, n: 0 }])
            && popDropsAnnounced().some(e => e.kind === 'conquest' && e.old_pop === 6), { s: stored(6004), ev: eventsFor(6004) });

        console.log('\n── a held claim does not get in the way of real growth ' + '─'.repeat(19));
        await sync(6005, [planet(1, 12)]);
        db.prepare('UPDATE planets SET population_observed_at=? WHERE system_id=6005').run(new Date(realNow() + skew - 10 * 3600000).toISOString());
        await sync(6005, [planet(1, 11)], memberA);
        await sync(6005, [planet(1, 13)], memberB);
        ok('a later read showing growth is accepted as a rise, and the held claim is discarded',
            stored(6005).p === 13 && outcomes(6005).includes('rise') && outcomes(6005).includes('drop_blip') && eventsFor(6005).length === 0, { s: stored(6005), o: outcomes(6005) });

        console.log('\n── a held claim is forgotten after 30 minutes ' + '─'.repeat(28));
        await sync(6006, [planet(1, 12)]);
        await sync(6006, [planet(1, 11)], memberA);
        advance(31 * MIN);
        await sync(6006, [planet(1, 11)], memberB);
        ok('the same low read after that starts a fresh claim instead of confirming the stale one',
            eventsFor(6006).length === 0 && stored(6006).p === 12 && outcomes(6006).filter(o => o === 'drop_pending').length === 2, outcomes(6006));

        console.log('\n── a still-lower read while one is held ' + '─'.repeat(34));
        await sync(6007, [planet(1, 12)]);
        await sync(6007, [planet(1, 11)], memberA);
        advance(30 * S);
        await sync(6007, [planet(1, 10)], memberB);
        ok('does not confirm anything yet (it came too soon to count)', eventsFor(6007).length === 0 && stored(6007).p === 12, eventsFor(6007));
        advance(3 * MIN);
        await sync(6007, [planet(1, 10)], memberC);
        ok('...and a third read once the gap has passed confirms it at what that read shows (12 → 10)', same(eventsFor(6007), [{ o: 12, n: 10 }]) && stored(6007).p === 10, eventsFor(6007));

        console.log('\n── reads the hub does not trust never reach the gate ' + '─'.repeat(21));
        await sync(6008, [planet(1, 12)]);
        await sync(6008, [planet(1, 11, { vision_uncertain: true })], memberA);
        ok('an out-of-vision (frozen) read holds nothing and records nothing', stored(6008).p === 12 && traceOf(6008).length === 0, traceOf(6008));

        console.log('\n── wiring ' + '─'.repeat(64));
        const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const syncJs = strip(fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8'));
        ok('the gate is consulted exactly once, only when ownership did not change',
            (syncJs.match(/provisionalDrops\.observe\(/g) || []).length === 1 && /if \(!ownerChanged && Number\.isFinite\(oldPop\)/.test(syncJs));
        ok('the drop branch skips a held claim', /else if \(newPop < oldPop && dropGate\.kind !== 'pending'\)/.test(syncJs));
        ok('the delay is configured from POP_DROP_CONFIRM_MS and documented in .env.example',
            /confirmGapFromEnv\(\)/.test(syncJs) && /^POP_DROP_CONFIRM_MS=/m.test(fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8')));
    } finally {
        Date.now = realNow;
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failed) { console.error(`${failed} check(s) failed`); process.exitCode = 1; }
    else console.log('All checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
