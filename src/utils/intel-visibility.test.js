// Regression coverage for the alliance-wide intel visibility announcements (2026-09-13).
//
// The game's Player detail carries an intelligenceReport whenever ANY member has vision,
// naming the capturer, and null when nobody does — so the sweep observes real alliance-wide
// visibility every pass. players.has_intel could never express this: it latches to 1 on the
// first capture, so it answers "have we ever seen them" and nothing else.
//
// The risk being managed here is noise, not correctness. Vision flickers as fleets drift in
// and out of range (confirmed live: a report captured at 14:10:33 was gone again minutes
// later), so a single changed observation is not yet news — it has to hold across two
// consecutive passes, and the same direction is not repeated within the window.
//
// Run with: node src/utils/intel-visibility.test.js

const { decideIntelVisibilityChange } = require('./intel-visibility');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const NOW = new Date('2026-09-13T14:00:00Z');
const row = (o = {}) => ({
    has_intel: 0, intel_visible: null, intel_seen_raw: null,
    intel_lost_announced_at: null, intel_regained_announced_at: null, ...o,
});
const decide = (prior, observedVisible, now = NOW) =>
    decideIntelVisibilityChange({ prior, observedVisible, now });

console.log('intel-visibility.test.js');

console.log('\n── Establishing a baseline says nothing ' + '─'.repeat(37));
{
    // Every player already in the database starts with no confirmed state. Announcing here
    // would post a line for the whole roster at once, describing nothing that changed.
    const fresh = decide(row({ has_intel: 1 }), false);
    ok('an existing player with no baseline is recorded silently', fresh.announce === null, fresh);
    ok('and the baseline is what we just observed', fresh.confirmedVisible === 0 && fresh.seenRaw === 0, fresh);

    const unknownPlayer = decide(null, true);
    ok('a player the hub has never stored is recorded silently too', unknownPlayer.announce === null, unknownPlayer);
}

console.log('\n── First capture ever ' + '─'.repeat(55));
{
    const first = decide(row({ has_intel: 0, intel_visible: 0, intel_seen_raw: 0 }), true);
    ok('announces immediately — it cannot flap, has_intel only goes 0->1 once',
        first.announce === 'first_ever', first);
    ok('and the confirmed state moves with it', first.confirmedVisible === 1, first);

    // Same observation again: has_intel is now 1, so this is no longer a first capture.
    const again = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 1 }), true);
    ok('does not repeat on the next pass', again.announce === null, again);
}

console.log('\n── A change must hold across two consecutive passes ' + '─'.repeat(25));
{
    // Visible and confirmed, then a single pass reports it gone.
    const firstMiss = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 1 }), false);
    ok('one missed sighting announces nothing — fleets drift out of range constantly',
        firstMiss.announce === null, firstMiss);
    ok('and the confirmed state does NOT move on a single observation',
        firstMiss.confirmedVisible === 1, firstMiss);
    ok('but the raw observation is remembered, or it could never be confirmed',
        firstMiss.seenRaw === 0, firstMiss);

    // Second pass agrees: now it is real.
    const secondMiss = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 0 }), false);
    ok('two in a row confirms the loss', secondMiss.announce === 'lost', secondMiss);
    ok('and the confirmed state follows', secondMiss.confirmedVisible === 0, secondMiss);

    // A wobble that corrects itself before the second pass must leave no trace.
    const recovered = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 0 }), true);
    ok('a single-pass wobble that recovers announces nothing', recovered.announce === null, recovered);
    ok('and leaves the confirmed state exactly where it was', recovered.confirmedVisible === 1, recovered);
}

console.log('\n── Regaining ' + '─'.repeat(63));
{
    const firstSight = decide(row({ has_intel: 1, intel_visible: 0, intel_seen_raw: 0 }), true);
    ok('one sighting after a loss is not yet a regain', firstSight.announce === null, firstSight);

    const confirmed = decide(row({ has_intel: 1, intel_visible: 0, intel_seen_raw: 1 }), true);
    ok('two in a row announces the regain', confirmed.announce === 'regained', confirmed);
    ok('and it is a REGAIN, not a first capture, because has_intel is already set',
        confirmed.announce !== 'first_ever', confirmed);
}

console.log('\n── The same direction is not repeated within the window ' + '─'.repeat(21));
{
    const justSaid = '2026-09-13 08:00:00'; // 6h before NOW, inside the 12h window
    const suppressed = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 0, intel_lost_announced_at: justSaid }), false);
    ok('a second loss 6h after the last one stays quiet', suppressed.announce === null, suppressed);
    ok('but the state still moves — suppressing the message must not corrupt the bookkeeping',
        suppressed.confirmedVisible === 0, suppressed);

    const longAgo = '2026-09-13 01:00:00'; // 13h before NOW
    const allowed = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 0, intel_lost_announced_at: longAgo }), false);
    ok('past the window it speaks again', allowed.announce === 'lost', allowed);

    // The window is per DIRECTION: having just reported a loss must not mute the regain.
    const otherWay = decide(row({ has_intel: 1, intel_visible: 0, intel_seen_raw: 1, intel_lost_announced_at: justSaid }), true);
    ok('a recent LOSS does not suppress a REGAIN — they are tracked separately',
        otherWay.announce === 'regained', otherWay);
}

console.log('\n── Steady state is silent ' + '─'.repeat(50));
{
    const stillVisible = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 1 }), true);
    ok('a player we can still see says nothing, pass after pass', stillVisible.announce === null, stillVisible);
    const stillGone = decide(row({ has_intel: 1, intel_visible: 0, intel_seen_raw: 0 }), false);
    ok('a player we still cannot see says nothing either', stillGone.announce === null, stillGone);
}

console.log('\n── Unusable announcement stamps do not suppress ' + '─'.repeat(29));
{
    // A missing or unreadable stamp means "never announced". Reading it as recent would
    // silence a real transition, which is the worse failure of the two.
    for (const stamp of [null, '', 'not-a-date']) {
        const r = decide(row({ has_intel: 1, intel_visible: 1, intel_seen_raw: 0, intel_lost_announced_at: stamp }), false);
        ok(`stamp ${JSON.stringify(stamp)} is treated as never announced`, r.announce === 'lost', r);
    }
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
