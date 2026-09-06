// Research time arithmetic shared by the calculator and the Economy countdown (issue #139).
//
// Run with:  node src/utils/research-time.test.js

const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-tables.js'));
const R = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'research-time.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const close = (a, b) => Math.abs(a - b) < 1e-6;

console.log('── Plain levels at a flat rate ' + '─'.repeat(44));
// Level 4 costs 221 points, level 5 costs 325 (docs/game-rules.md). At 100 pts/h: 5.46 h.
let r = R.secondsToLevel({ level: 3, rate: 100 }, T.SCIENCE, 5);
ok('3 → 5 at 100/h = (221 + 325) / 100 hours', close(r.seconds, (221 + 325) / 100 * 3600) && r.levels === 2 && r.missing.length === 0, r);
r = R.secondsToLevel({ level: 3, rate: 100 }, T.SCIENCE, 4);
ok('one level is just that level\'s points', close(r.seconds, 221 / 100 * 3600) && r.levels === 1, r);
r = R.secondsToLevel({ level: 3, rate: 100 }, T.SCIENCE, 3);
ok('target at the current level → 0 seconds, 0 levels', r.seconds === 0 && r.levels === 0);
ok('target below the current level → 0, not negative', R.secondsToLevel({ level: 8, rate: 100 }, T.SCIENCE, 5).seconds === 0);

console.log('\n── The level in progress counts its remaining timer, not its points ' + '─'.repeat(7));
r = R.secondsToLevel({ level: 3, rate: 100, researching: true, timerSecs: 600 }, T.SCIENCE, 5);
ok('researching: 600 s left on level 4, then level 5\'s points', close(r.seconds, 600 + 325 / 100 * 3600), r);
r = R.secondsToLevel({ level: 3, rate: 100, researching: true, timerSecs: 600 }, T.SCIENCE, 4);
ok('researching towards the target itself: only the timer remains', r.seconds === 600 && r.levels === 1, r);
r = R.secondsToLevel({ level: 3, rate: 100, researching: true, timerSecs: 600 }, T.SCIENCE, 5, 200);
ok('a what-if rate twice the live one halves the timer too (it was measured at the live rate)', close(r.seconds, 300 + 325 / 200 * 3600), r);
r = R.secondsToLevel({ level: 3, rate: 100, researching: false, timerSecs: 600 }, T.SCIENCE, 4);
ok('a stale timer value is ignored when nothing is being researched', close(r.seconds, 221 / 100 * 3600), r);

console.log('\n── Rates ' + '─'.repeat(66));
r = R.secondsToLevel({ level: 3, rate: 100 }, T.SCIENCE, 5, 50);
ok('effRate overrides the live rate', close(r.seconds, (221 + 325) / 50 * 3600), r);
r = R.secondsToLevel({ level: 3, rate: 100 }, T.SCIENCE, 5, 0);
ok('an effRate of 0 falls back to the live rate rather than dividing by zero', close(r.seconds, (221 + 325) / 100 * 3600), r);
r = R.secondsToLevel({ level: 3, rate: 0 }, T.SCIENCE, 5);
ok('no rate at all → NaN seconds with a reason, levels still counted', Number.isNaN(r.seconds) && r.reason === 'no-rate' && r.levels === 2, r);
r = R.secondsToLevel({ level: '3', rate: '100' }, T.SCIENCE, '5');
ok('numeric strings are tolerated', close(r.seconds, (221 + 325) / 100 * 3600), r);

console.log('\n── Missing table rows are reported, not guessed ' + '─'.repeat(27));
r = R.secondsToLevel({ level: 1, rate: 100 }, [0, 29, 74], 4);
ok('levels past the end of the table are listed in `missing` and add no time', close(r.seconds, 74 / 100 * 3600) && r.missing.join(',') === '3,4', r);
r = R.secondsToLevel({ level: 1, rate: 100 }, { 2: 74, 4: 221 }, 4);
ok('a sparse object table works the same way (level 3 missing)', close(r.seconds, (74 + 221) / 100 * 3600) && r.missing.join(',') === '3', r);
r = R.secondsToLevel({ level: 1, rate: 100 }, null, 3);
ok('no table at all → every level missing, zero time', r.seconds === 0 && r.missing.join(',') === '2,3', r);
ok('an unreadable target → 0', R.secondsToLevel({ level: 1, rate: 100 }, T.SCIENCE, 'soon').seconds === 0);

console.log('\n── Against the doc\'s worked reasoning for a long run ' + '─'.repeat(22));
// Levels 1..100 exist in the doc table; the whole run from 0 to 100 at 1000/h is the
// aggregated total over 1000 hours.
r = R.secondsToLevel({ level: 0, rate: 1000 }, T.SCIENCE, 100);
ok('0 → 100 equals aggregate(SCIENCE, 0, 100) / rate', close(r.seconds, T.aggregate(T.SCIENCE, 0, 100) / 1000 * 3600) && r.missing.length === 0, [r.seconds, r.missing]);
r = R.secondsToLevel({ level: 0, rate: 1000 }, T.SCIENCE, 101);
ok('level 101 is beyond the published table and is reported missing', r.missing.join(',') === '101', r.missing);

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
