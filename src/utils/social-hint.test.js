// The Social marker rule (issue #138): when the Science page should nudge towards Social.
//
// Run with:  node src/utils/social-hint.test.js

const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-tables.js'));
const S = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'social-hint.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const HOUR = 3600 * 1000;
const stamp = hoursAgo => new Date(NOW - hoursAgo * HOUR).toISOString().slice(0, 19).replace('T', ' ');
const planet = (population, hoursAgo = 1) => ({ population, updated_at: stamp(hoursAgo) });

console.log('── The next level that actually raises the cap ' + '─'.repeat(28));
ok('the table itself: cap rises at 2, 4, 6, 8, 10, then every level', T.SOCIAL_CAP.slice(0, 12).join(',') === '5,5,6,6,7,7,8,8,9,9,10,11');
ok('from Social 0 the next raise is level 2 (cap 6), not level 1', JSON.stringify(S.nextCapRaise(0)) === JSON.stringify({ level: 2, cap: 6 }), S.nextCapRaise(0));
ok('from Social 2 the next raise is 4 (cap 7)', JSON.stringify(S.nextCapRaise(2)) === JSON.stringify({ level: 4, cap: 7 }));
ok('from Social 10 every level raises it', JSON.stringify(S.nextCapRaise(10)) === JSON.stringify({ level: 11, cap: 11 }));
ok('at the top of the table there is nothing left to raise', S.nextCapRaise(25) === null && S.nextCapRaise(40) === null);

console.log('\n── evaluate ' + '─'.repeat(63));
let r = S.evaluate({ socialLevel: 4, planets: [planet(7), planet(5), planet(6)], now: NOW });
ok('one of three planets at cap 7 → low (grey)', r.state === 'low' && r.capped === 1 && r.total === 3 && r.cap === 7, r);
ok('the result names the next raising level', r.nextRaise && r.nextRaise.level === 6 && r.nextRaise.cap === 8, r.nextRaise);

r = S.evaluate({ socialLevel: 4, planets: [planet(7), planet(7), planet(5)], now: NOW });
ok('two of three (half or more) → high (amber)', r.state === 'high' && r.capped === 2, r);
r = S.evaluate({ socialLevel: 4, planets: [planet(7), planet(6)], now: NOW });
ok('exactly half counts as high', r.state === 'high', r);
r = S.evaluate({ socialLevel: 4, planets: [planet(8), planet(9)], now: NOW });
ok('population above the cap (a planet gained before Social dropped, or the table is behind) still counts as capped', r.capped === 2 && r.state === 'high', r);

r = S.evaluate({ socialLevel: 4, planets: [planet(6), planet(5)], now: NOW });
ok('no planet at cap → none', r.state === 'none' && r.capped === 0, r);
r = S.evaluate({ socialLevel: 4, planets: [], now: NOW });
ok('no planets on record → none (the hub does not know this player\'s planets yet)', r.state === 'none' && r.total === 0, r);
r = S.evaluate({ socialLevel: 4, planets: [planet(7), planet(7)], queued: true, now: NOW });
ok('Social already queued or researching → none, the player is on it', r.state === 'none' && r.capped === 2, r);
r = S.evaluate({ socialLevel: 25, planets: [planet(25), planet(25)], now: NOW });
ok('at the top of the table nothing can help → none even with every planet capped', r.state === 'none' && r.nextRaise === null, r);

console.log('\n── Stale planet data never gets past grey ' + '─'.repeat(33));
r = S.evaluate({ socialLevel: 4, planets: [planet(7, 60), planet(7, 70)], now: NOW });
ok('every planet older than 48h → stale, high demoted to low', r.stale === true && r.state === 'low', r);
r = S.evaluate({ socialLevel: 4, planets: [planet(7, 60), planet(7, 1)], now: NOW });
ok('one fresh planet makes the set current (the freshest scan is what counts)', r.stale === false && r.state === 'high', r);
r = S.evaluate({ socialLevel: 4, planets: [{ population: 7 }, { population: 7 }], now: NOW });
ok('no timestamps at all → stale', r.stale === true && r.state === 'low' && r.newestAt === null, r);
r = S.evaluate({ socialLevel: 4, planets: [planet(7, 60), planet(7, 70)], now: NOW, staleMs: 100 * HOUR });
ok('the staleness threshold is a parameter', r.stale === false && r.state === 'high', r);

console.log('\n── Degenerate inputs ' + '─'.repeat(54));
r = S.evaluate({ socialLevel: 'x', planets: [planet(5)], now: NOW });
ok('an unreadable Social level is treated as 0 (cap 5), and a level-5 planet is capped', r.socialLevel === 0 && r.cap === 5 && r.capped === 1 && r.state === 'high', r);
r = S.evaluate({ socialLevel: 4, planets: [planet(7), { population: null }, { population: 'n/a' }, null], now: NOW });
ok('planets without a readable population are ignored, not counted either way', r.total === 1 && r.capped === 1, r);
ok('undefined planets do not throw', S.evaluate({ socialLevel: 4, planets: undefined, now: NOW }).state === 'none');
r = S.evaluate({ socialLevel: 4, planets: [{ population: '7', updated_at: stamp(1) }], now: NOW });
ok('a population that arrives as a numeric string is read', r.capped === 1, r);

console.log('\n── message ' + '─'.repeat(64));
r = S.evaluate({ socialLevel: 4, planets: [planet(7, 2), planet(5, 5), planet(7, 3)], now: NOW });
let m = S.message(r, NOW);
ok('names count, cap and current level', /2 of 3 planets at the population cap \(Social 4 → max 7\)/.test(m), m);
ok('warns that the next level changes nothing and names the one that does', /Social 5 does not raise the cap; 6 does \(max 8\)/.test(m), m);
ok('says how old the planet data is', /2–5h old/.test(m), m);
r = S.evaluate({ socialLevel: 10, planets: [planet(10, 1)], now: NOW });
m = S.message(r, NOW);
ok('from a level where every step counts the message is the simple one', /Social 11 raises it to 11\./.test(m) && /1 of 1 planet at/.test(m), m);
r = S.evaluate({ socialLevel: 4, planets: [planet(7, 60)], now: NOW });
ok('stale data is called out', /stale/.test(S.message(r, NOW)), S.message(r, NOW));
ok('a none result has no message', S.message(S.evaluate({ socialLevel: 4, planets: [], now: NOW })) === '');

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
