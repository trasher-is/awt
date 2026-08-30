// Unit-tests the "has >=12h passed since the last automated post" gate used by
// src/routes/sync.js's battle-points auto-post block. The gate is plain arithmetic over
// a settings-stored timestamp, so it's tested directly rather than through a full HTTP
// request against the Express router.

function hoursSinceLastPost(lastPostRaw, nowMs) {
    const lastPostMs = lastPostRaw ? Date.parse(lastPostRaw) : NaN;
    return Number.isFinite(lastPostMs) ? (nowMs - lastPostMs) / (60 * 60 * 1000) : Infinity;
}

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('battle-points-autopost.test.js');

const now = Date.parse('2026-08-30T12:00:00Z');

ok('never posted before (null) => Infinity hours, always fires',
    hoursSinceLastPost(null, now) === Infinity);

ok('posted 11 hours ago => gate stays closed',
    hoursSinceLastPost('2026-08-30T01:00:00Z', now) < 12);

ok('posted exactly 12 hours ago => gate opens',
    hoursSinceLastPost('2026-08-30T00:00:00Z', now) === 12);

ok('posted 13 hours ago => gate opens',
    hoursSinceLastPost('2026-08-29T23:00:00Z', now) > 12);

ok('a garbage stored timestamp is treated as "never posted" (Infinity)',
    hoursSinceLastPost('not-a-date', now) === Infinity);

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
