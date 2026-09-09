// Same attacker, same planet, different arrival = a different incoming (issue #143).
//
// Run with:  node src/utils/incoming-identity.test.js
//
// Reported live: a second wave at the same coordinates from the same attacker never got
// its own alert — the bot edited the first wave's message instead, because the identity
// was "system:planet:attacker" with no time in it. These cases pin the resolver's rules:
// same fleet re-reported (within tolerance) edits, a later wave gets a new key, a report
// without a time keeps the old one-message behaviour, and a stale time-less orphan cannot
// swallow this week's attack.

const path = require('path');
const { ARRIVAL_TOLERANCE_SEC, baseKeyFor, arrivalOf, pickAlertKey } =
    require(path.join(__dirname, 'incoming-identity.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('incoming-identity.test.js');

const NOW = 1_800_000_000;                       // any fixed "now", in unix seconds
const T1 = NOW + 3 * 3600;                       // wave 1 lands in 3 h
const T2 = T1 + 25 * 60;                         // wave 2 lands 25 min later
const sqlite = sec => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
const fresh = sqlite(NOW - 60);                  // a row touched a minute ago
const stale = sqlite(NOW - 3 * 86400);           // a row from three days ago
const opts = { nowSec: NOW };

console.log('\n── Base identity and arrival parsing ' + '─'.repeat(40));
const report = { attacker: { name: '  Xerxes ' }, target: { systemId: 1234, planetIndex: 5 }, arrivalUnix: String(T1) };
ok('base key is system:planet:attacker, attacker lowercased and trimmed', baseKeyFor(report) === '1234:5:xerxes');
ok('arrival parses a numeric string to an integer second', arrivalOf(report) === T1);
ok('a missing / zero / garbage arrival reads as 0', arrivalOf({}) === 0 && arrivalOf({ arrivalUnix: 0 }) === 0 && arrivalOf({ arrivalUnix: 'soon' }) === 0);

console.log('\n── First report of a wave ' + '─'.repeat(51));
const first = pickAlertKey('1234:5:xerxes', T1, [], opts);
ok('with no stored rows, a timed report gets "<base>:<arrival>" and is new',
    first.alertKey === `1234:5:xerxes:${T1}` && first.isNew && first.stampArrival, first);
const untimed = pickAlertKey('1234:5:xerxes', 0, [], opts);
ok('with no time, the plain base key is used (pre-#143 behaviour) and nothing is stamped',
    untimed.alertKey === '1234:5:xerxes' && untimed.isNew && !untimed.stampArrival, untimed);

console.log('\n── Re-reporting the same fleet edits, a second wave does not ' + '─'.repeat(15));
const rows1 = [{ alert_key: `1234:5:xerxes:${T1}`, arrival_unix: T1, updated_at: fresh }];
const sameFleet = pickAlertKey('1234:5:xerxes', T1 + 45, rows1, opts);
ok('the News page reporting the same fleet 45 s off (minute-precision webhook) edits the same alert',
    sameFleet.alertKey === rows1[0].alert_key && !sameFleet.isNew && !sameFleet.stampArrival, sameFleet);
const edge = pickAlertKey('1234:5:xerxes', T1 + ARRIVAL_TOLERANCE_SEC, rows1, opts);
ok('exactly at the tolerance still counts as the same fleet', edge.alertKey === rows1[0].alert_key, edge);
const wave2 = pickAlertKey('1234:5:xerxes', T2, rows1, opts);
ok('a wave landing 25 min later is a NEW incoming with its own key (the reported bug)',
    wave2.alertKey === `1234:5:xerxes:${T2}` && wave2.isNew && wave2.stampArrival, wave2);
const justOver = pickAlertKey('1234:5:xerxes', T1 + ARRIVAL_TOLERANCE_SEC + 1, rows1, opts);
ok('one second past the tolerance is a new wave, not an edit', justOver.isNew, justOver);

console.log('\n── Two waves stored: the closest one wins ' + '─'.repeat(35));
const rows2 = [...rows1, { alert_key: `1234:5:xerxes:${T2}`, arrival_unix: T2, updated_at: fresh }];
const secondWaveUpdate = pickAlertKey('1234:5:xerxes', T2 - 30, rows2, opts);
ok('an update 30 s off wave 2 edits wave 2, not wave 1', secondWaveUpdate.alertKey === rows2[1].alert_key, secondWaveUpdate);
const firstWaveUpdate = pickAlertKey('1234:5:xerxes', T1 + 10, rows2, opts);
ok('an update 10 s off wave 1 edits wave 1', firstWaveUpdate.alertKey === rows2[0].alert_key, firstWaveUpdate);
const untimedWithRows = pickAlertKey('1234:5:xerxes', 0, rows2, opts);
ok('a time-less report with two live waves stored attaches to the wave landing soonest, never a third message',
    untimedWithRows.alertKey === rows2[0].alert_key && !untimedWithRows.isNew && !untimedWithRows.stampArrival, untimedWithRows);
const untimedOneLive = pickAlertKey('1234:5:xerxes', 0, rows1, opts);
ok('a time-less report with one live wave stored edits that wave (a reporter dropping the time cannot split the alert)',
    untimedOneLive.alertKey === rows1[0].alert_key && !untimedOneLive.isNew, untimedOneLive);
const landed = [{ alert_key: `1234:5:xerxes:${NOW - 600}`, arrival_unix: NOW - 600, updated_at: fresh }];
const untimedAfterLanding = pickAlertKey('1234:5:xerxes', 0, landed, opts);
ok('a time-less report with only a LANDED wave stored starts a base-key row (nothing live to attach to)',
    untimedAfterLanding.alertKey === '1234:5:xerxes' && untimedAfterLanding.isNew, untimedAfterLanding);

console.log('\n── Expired reports keep their own identity ' + '─'.repeat(32));
const pastArrival = pickAlertKey('1234:5:xerxes', NOW - 30, rows1, opts);
ok('an unmatched expired report cannot attach to a different live wave',
    pastArrival.alertKey === null && !pastArrival.isNew && !pastArrival.stampArrival, pastArrival);
const pastNoRows = pickAlertKey('1234:5:xerxes', NOW - 30, [], opts);
ok('an unmatched expired report cannot start a base-key alert',
    pastNoRows.alertKey === null && !pastNoRows.isNew && !pastNoRows.stampArrival, pastNoRows);
const nearLive = [{ alert_key: `1234:5:xerxes:${NOW + 60}`, arrival_unix: NOW + 60, updated_at: fresh }];
const pastNearLive = pickAlertKey('1234:5:xerxes', NOW - 30, nearLive, opts);
ok('arrival tolerance cannot attach an unmatched expired report to a nearby live wave',
    pastNearLive.alertKey === null && !pastNearLive.isNew && !pastNearLive.stampArrival, pastNearLive);
const afterFirstLanding = { nowSec: T1 + 1 };
const replayAlone = pickAlertKey('1234:5:xerxes', T1, rows1, afterFirstLanding);
ok('replaying a known expired wave without other waves retains its stored key',
    replayAlone.alertKey === rows1[0].alert_key && !replayAlone.isNew && !replayAlone.stampArrival, replayAlone);
const replayWithNextWave = pickAlertKey('1234:5:xerxes', T1, rows2, afterFirstLanding);
ok('replaying a known expired wave with another live wave retains the expired key',
    replayWithNextWave.alertKey === rows1[0].alert_key && !replayWithNextWave.isNew, replayWithNextWave);
const replayRounded = pickAlertKey('1234:5:xerxes', T1 - 45, rows2, afterFirstLanding);
ok('the two reporters still resolve a rounded expired arrival to the original wave',
    replayRounded.alertKey === rows1[0].alert_key && !replayRounded.isNew, replayRounded);
const atLanding = pickAlertKey('1234:5:xerxes', T1, rows2, { nowSec: T1 });
ok('the exact arrival second does not change a known identity', atLanding.alertKey === rows1[0].alert_key, atLanding);
const landedRow = pickAlertKey('1234:5:xerxes', T1, landed, opts);
ok('a new timed wave outside tolerance is distinct from a landed wave', landedRow.alertKey === `1234:5:xerxes:${T1}` && landedRow.isNew, landedRow);

console.log('\n── Legacy / time-less rows ' + '─'.repeat(50));
const legacyFresh = [{ alert_key: '1234:5:xerxes', arrival_unix: null, updated_at: fresh }];
const expiredWithLegacy = pickAlertKey('1234:5:xerxes', NOW - 30, legacyFresh, opts);
ok('an unmatched expired report cannot adopt and stamp a time-less legacy row',
    expiredWithLegacy.alertKey === null && !expiredWithLegacy.stampArrival, expiredWithLegacy);
const adopt = pickAlertKey('1234:5:xerxes', T1, legacyFresh, opts);
ok('a fresh legacy row (base key, no arrival) is adopted and gets the arrival stamped',
    adopt.alertKey === '1234:5:xerxes' && !adopt.isNew && adopt.stampArrival, adopt);
const legacyStale = [{ alert_key: '1234:5:xerxes', arrival_unix: null, updated_at: stale }];
const ignoreStale = pickAlertKey('1234:5:xerxes', T1, legacyStale, opts);
ok('a three-day-old time-less orphan does NOT swallow a new timed attack',
    ignoreStale.alertKey === `1234:5:xerxes:${T1}` && ignoreStale.isNew, ignoreStale);
const mixed = [...rows1, { alert_key: '1234:5:xerxes', arrival_unix: 0, updated_at: fresh }];
const preferTimed = pickAlertKey('1234:5:xerxes', T1 + 5, mixed, opts);
ok('a timed match beats a fresh time-less row', preferTimed.alertKey === rows1[0].alert_key, preferTimed);
const timelessOnly = pickAlertKey('1234:5:xerxes', T2, mixed, opts);
ok('a new wave with a fresh time-less row around adopts that row rather than opening a third message',
    timelessOnly.alertKey === '1234:5:xerxes' && timelessOnly.stampArrival, timelessOnly);

console.log('\n── Discord customId budget ' + '─'.repeat(50));
const longest = `cover:${99999}:${99}:${'x'.repeat(40)}:${T2}`;
ok('"cover:<base>:<arrival>" for a 40-char attacker name stays under Discord\'s 100-char customId cap', longest.length < 100, longest.length);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
