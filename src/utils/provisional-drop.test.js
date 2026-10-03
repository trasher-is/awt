// A population drop is provisional until a later read confirms it (src/utils/provisional-drop.js).
//
// Run with:  node src/utils/provisional-drop.test.js
//
// Pure state machine, driven with explicit clocks: no database, no route. The route-level behaviour
// (nothing stored, logged or announced while a claim is held) is in
// src/routes/sync-population-provisional-drop.test.js.

const { createProvisionalDrops, confirmGapFromEnv, CONFIRM_GAP_MS, SAME_MEMBER_GAP_MS, PENDING_TTL_MS } = require('./provisional-drop');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const S = 1000, MIN = 60 * S;
const read = (d, key, storedPop, claimedPop, actor, now, ownerId = 7) => d.observe(key, { storedPop, claimedPop, ownerId, actor, now });

console.log('provisional-drop.test.js');

console.log('\n── defaults ' + '─'.repeat(62));
ok('confirmation gap is 2 minutes for another member, 4 for the same member, 30 minutes to give up',
    CONFIRM_GAP_MS === 2 * MIN && SAME_MEMBER_GAP_MS === 4 * MIN && PENDING_TTL_MS === 30 * MIN);

console.log('\n── a lower claim is held, not applied ' + '─'.repeat(37));
{
    const d = createProvisionalDrops();
    const first = read(d, 'a', 12, 11, 1, 0);
    ok('the first lower claim is pending and says it was just created', first.kind === 'pending' && first.created === true, first);
    ok('a read that does not change anything with nothing pending is nothing', read(d, 'b', 12, 12, 1, 0).kind === 'none');
    ok('a pending claim is remembered', d.size() === 1, d.size());
}

console.log('\n── a read that restores the held figure discards it as a blip ' + '─'.repeat(11));
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    const v = read(d, 'a', 12, 12, 2, 4 * S);
    ok('4 seconds later, another read at the old figure: blip, with how long it stood and who made it',
        v.kind === 'blip' && v.ageMs === 4 * S && v.firstActor === 1 && v.lowClaim === 11, v);
    ok('...and nothing stays pending', d.size() === 0);
    ok('a later low read starts over rather than inheriting the discarded one', read(d, 'a', 12, 11, 2, 10 * S).created === true);
}
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    ok('a read ABOVE the held figure (growth in the meantime) also discards it', read(d, 'a', 12, 13, 2, 30 * S).kind === 'blip');
}

console.log('\n── confirmation ' + '─'.repeat(58));
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    ok('another member 119 seconds later is still too soon', read(d, 'a', 12, 11, 2, 119 * S).kind === 'pending');
    const c = read(d, 'a', 12, 11, 2, 120 * S);
    ok('another member at 2 minutes confirms it', c.kind === 'confirmed' && c.ageMs === 120 * S && c.firstActor === 1, c);
    ok('...and it is no longer pending', d.size() === 0);
}
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    ok('the SAME member cannot confirm within one run (3 minutes)', read(d, 'a', 12, 11, 1, 3 * MIN).kind === 'pending');
    ok('...but their next five-minute run can (4 minutes)', read(d, 'a', 12, 11, 1, 4 * MIN).kind === 'confirmed');
}
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    ok('a read that shows the planet even lower while pending keeps it pending', read(d, 'a', 12, 10, 2, 30 * S).kind === 'pending');
    ok('...and a read that is still lower once the gap has passed confirms', read(d, 'a', 12, 10, 3, 3 * MIN).kind === 'confirmed');
}

console.log('\n── things that invalidate a pending claim ' + '─'.repeat(33));
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    const later = read(d, 'a', 12, 11, 2, 31 * MIN);
    ok('after 30 minutes the old claim is forgotten: the same low read starts a fresh one instead of confirming',
        later.kind === 'pending' && later.created === true, later);
}
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0, 7);
    const v = read(d, 'a', 12, 11, 2, 3 * MIN, 8);
    ok('a change of owner in between forgets it (a conquest is its own event)', v.kind === 'pending' && v.created === true, v);
}
{
    const d = createProvisionalDrops();
    read(d, 'a', 12, 11, 1, 0);
    const v = read(d, 'a', 10, 9, 2, 3 * MIN);
    ok('so does the held figure moving underneath it (something else changed the planet)', v.kind === 'pending' && v.created === true, v);
}

console.log('\n── planets are independent ' + '─'.repeat(48));
{
    const d = createProvisionalDrops();
    read(d, 'p1', 12, 11, 1, 0);
    read(d, 'p2', 6, 5, 1, 0);
    read(d, 'p3', 6, 5, 1, 0);
    ok('three planets pending at once (one stale read hitting several planets, as seen live)', d.size() === 3, d.size());
    ok('restoring one does not touch the others', read(d, 'p2', 6, 6, 2, 10 * S).kind === 'blip' && d.size() === 2);
    ok('and another can still be confirmed on its own', read(d, 'p1', 12, 11, 2, 3 * MIN).kind === 'confirmed' && d.size() === 1);
}

console.log('\n── switched off ' + '─'.repeat(58));
{
    const d = createProvisionalDrops({ confirmGapMs: 0 });
    ok('with a gap of 0 every lower claim is applied at once', read(d, 'a', 12, 11, 1, 0).kind === 'immediate');
    ok('...and nothing else is ever held', read(d, 'a', 12, 12, 1, 0).kind === 'none' && d.size() === 0);
}

console.log('\n── memory stays bounded ' + '─'.repeat(51));
{
    const d = createProvisionalDrops();
    for (let i = 0; i < 40; i++) read(d, `k${i}`, 5, 4, 1, 0);
    ok('forty abandoned claims are held', d.size() === 40, d.size());
    d.sweep(31 * MIN);
    ok('a sweep after the give-up time removes them all', d.size() === 0, d.size());
    const e = createProvisionalDrops();
    for (let i = 0; i < 40; i++) read(e, `k${i}`, 5, 4, 1, 0);
    for (let i = 0; i < 500; i++) read(e, 'busy', 5, 5, 1, 31 * MIN);
    ok('and it happens by itself as reads keep arriving (no caller has to remember to)', e.size() === 0, e.size());
}

console.log('\n── POP_DROP_CONFIRM_MS ' + '─'.repeat(52));
ok('unset or blank means the default', confirmGapFromEnv({}) === undefined && confirmGapFromEnv({ POP_DROP_CONFIRM_MS: '' }) === undefined);
ok('0 turns it off', confirmGapFromEnv({ POP_DROP_CONFIRM_MS: '0' }) === 0);
ok('a number is taken as milliseconds', confirmGapFromEnv({ POP_DROP_CONFIRM_MS: '90000' }) === 90000);
ok('garbage and negatives fall back to the default rather than switching anything off',
    confirmGapFromEnv({ POP_DROP_CONFIRM_MS: 'soon' }) === undefined && confirmGapFromEnv({ POP_DROP_CONFIRM_MS: '-5' }) === undefined);
{
    const d = createProvisionalDrops({ confirmGapMs: 90 * S });
    ok('a custom gap sets the other-member wait, and the same-member wait never drops below the 4-minute default',
        d.config.confirmGapMs === 90 * S && d.config.sameMemberGapMs === 4 * MIN, d.config);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
