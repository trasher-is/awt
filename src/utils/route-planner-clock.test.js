// The Route Planner shows one kind of clock: the viewer's local time, 24-hour (issue #159).
//
// Run with:  node src/utils/route-planner-clock.test.js
//
// Before the fix, fmtLocal() used the browser's default hour cycle, so an en-US browser
// printed "Sep 9, 03:45 PM" right next to the UTC stamp "09-09 13:45Z" — an AM/PM clock
// and a 24-hour clock in the same line, and two zones in the same line. This is a
// source-scan suite (the planner is browser ESM with DOM access, so it is not importable
// here): it checks that every locale-formatted time in the file pins a 24-hour dial, and
// that the UTC stamp is no longer part of the visible text. Comments are stripped first so
// a comment describing the old behaviour cannot trip an assertion about the new one.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const file = path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'route-planner.js');
const raw = fs.readFileSync(file, 'utf8');
// Strip block comments, then whole-line and trailing `//` comments. Trailing comments are
// only stripped when preceded by whitespace so a `//` inside a URL string survives.
const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');

console.log('route-planner-clock.test.js');

console.log('\n── Every locale-formatted clock is a 24-hour one ' + '─'.repeat(28));
const localeCalls = code.match(/toLocale(?:Time|Date)?String\([^)]*\)/g) || [];
ok('the planner formats at least one clock through toLocale*String', localeCalls.length > 0, localeCalls);
const notH23 = localeCalls.filter(c => !/hourCycle:\s*'h23'/.test(c));
ok('every toLocale*String call pins hourCycle: \'h23\' (no AM/PM leaking from the browser locale)', notH23.length === 0, notH23);
ok('no call relies on hour12: false (maps to a 24:xx midnight in some engines)', !/hour12/.test(code));

console.log('\n── The visible text carries one zone only ' + '─'.repeat(34));
// The UTC stamp is allowed as a hover tooltip (title="...") — never as visible text.
const utcOutsideTitle = [];
const re = /fmtUtc\(/g;
let m;
while ((m = re.exec(code)) !== null) {
    const before = code.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before)) continue;                 // the definition itself
    if (!/title="\$\{esc\($/.test(before)) utcOutsideTitle.push(code.slice(Math.max(0, m.index - 40), m.index + 30));
}
ok('fmtUtc is only ever rendered inside a title="…" tooltip', utcOutsideTitle.length === 0, utcOutsideTitle);
ok('the old "local · <utc>" pairing is gone from the templates', !/local · /.test(code));
ok('fmtLocal still renders the arrival, the per-leg times and the saved-route start', (code.match(/fmtLocal\(/g) || []).length >= 5);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
