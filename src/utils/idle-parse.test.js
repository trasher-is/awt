// Regression coverage for the idle-duration parser, extracted (2026-09-12) from
// stat-columns.js so player-parser.js can derive last_activity_at from the same string the
// display layer already parsed, instead of drifting logic.
//
// Run with: node src/utils/idle-parse.test.js

const path = require('path');

const { parseIdleStringToSeconds } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'idle-parse.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('parseIdleStringToSeconds');

console.log('\n── Degenerate inputs ' + '─'.repeat(56));
ok('empty string is unparseable (-1)', parseIdleStringToSeconds('') === -1);
ok('null is unparseable (-1)', parseIdleStringToSeconds(null) === -1);
ok('the literal "Unknown" is unparseable (-1)', parseIdleStringToSeconds('Unknown') === -1);
ok('garbage with no d/h/m/s tokens is unparseable (-1)', parseIdleStringToSeconds('whenever') === -1);

console.log('\n── "Active"/"Online" mean idle 0 ' + '─'.repeat(44));
ok('"Active" is 0 seconds idle', parseIdleStringToSeconds('Active') === 0);
ok('"Online" is 0 seconds idle', parseIdleStringToSeconds('Online') === 0);
ok('case-insensitive', parseIdleStringToSeconds('active') === 0);

console.log('\n── Duration tokens combine ' + '─'.repeat(50));
ok('minutes only', parseIdleStringToSeconds('10m') === 600);
ok('hours + minutes', parseIdleStringToSeconds('3h 10m') === 3 * 3600 + 10 * 60);
ok('days + hours', parseIdleStringToSeconds('2d 5h') === 2 * 86400 + 5 * 3600);
ok('all four tokens', parseIdleStringToSeconds('1d 2h 3m 4s') === 86400 + 2 * 3600 + 3 * 60 + 4);

console.log('\n' + '─'.repeat(77));
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
