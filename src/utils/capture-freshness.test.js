// Regression coverage for a real production bug (2026-08-31): the Map/sectors API can
// report isInVision:true for a system while still handing back a snapshot frozen at the
// last periodic capture, not a live read — confirmed live against a real response:
// capturedAt was exactly "...T00:00:00+02:00" (the daily reset boundary), 20+ hours stale,
// for a system the requesting account had no personal vision on but an ally did. Trusting
// isInVision alone let a stale midnight population value get compared against as if it
// were fresh, logging a false population-drop history event.
//
// Run with: node src/utils/capture-freshness.test.js

const path = require('path');

const { isStaleCapture, constants } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'capture-freshness.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

console.log('isStaleCapture');

console.log('\n── The exact real-world case this exists to catch ' + '─'.repeat(28));
// Real values observed live: capturedAt at the daily reset boundary, "now" about 20 hours
// later (matching the actual gap between the midnight capture and the evening check).
const midnightCapture = '2026-08-31T00:00:00+02:00';
const twentyHoursLater = Date.parse('2026-08-31T20:16:06Z');
ok('a ~20-hour-old capture is flagged stale', isStaleCapture(midnightCapture, twentyHoursLater) === true);

console.log('\n── Boundary behavior around the 3-hour threshold ' + '─'.repeat(29));
ok('the threshold constant is 3 hours, as documented', constants.STALE_CAPTURE_MS === 3 * 60 * 60 * 1000);
const now = Date.parse('2026-08-31T12:00:00Z');
const justUnderThreshold = now - (constants.STALE_CAPTURE_MS - 1000);
const justOverThreshold = now - (constants.STALE_CAPTURE_MS + 1000);
ok('a capture just inside the threshold is NOT stale',
    isStaleCapture(new Date(justUnderThreshold).toISOString(), now) === false);
ok('a capture just past the threshold IS stale',
    isStaleCapture(new Date(justOverThreshold).toISOString(), now) === true);

console.log('\n── Degenerate inputs ' + '─'.repeat(56));
ok('null capturedAt is never treated as stale — nothing to distrust it by', isStaleCapture(null, now) === false);
ok('undefined capturedAt is never treated as stale', isStaleCapture(undefined, now) === false);
ok('empty string is never treated as stale', isStaleCapture('', now) === false);
ok('unparseable garbage does not throw and is not treated as stale',
    isStaleCapture('not a real date', now) === false);

console.log('\n── A genuinely fresh capture is trusted ' + '─'.repeat(37));
ok('a capture from 10 minutes ago is not stale',
    isStaleCapture(new Date(now - 10 * 60 * 1000).toISOString(), now) === false);

console.log('\n' + '─'.repeat(77));
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
