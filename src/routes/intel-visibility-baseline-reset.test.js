// The one-shot migration that clears the blind-sweep intel visibility baseline.
//
// WHY IT EXISTS (2026-09-15): every intel_visible/intel_seen_raw value in production was
// written by the API sweep, which cannot see intel at all — so all 160 rows read "confirmed
// not visible" on no evidence. Moving the announcements onto the profile scrape without
// clearing those values would have been worse than the bug it fixes: the first scrape of a
// player we really can see reads 0 -> 1 as a changed observation and the second confirms it,
// so the channel would get an "Intel regained" line for every one of them, none of which was
// ever lost. NULL is the one value meaning "no baseline yet", which records silently.
//
// Driven through real process restarts because that is the only way to exercise it — the
// reset runs inside initDatabase() at require time, so a single process sees it exactly once
// and could never show either the clearing or the one-shot guard.
//
// Run with: node src/routes/intel-visibility-baseline-reset.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-baseline-reset-test-'));
const tmpDb = path.join(tmpDir, 'test.db');
const dbModule = path.join(__dirname, '..', 'database.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

// Each step is a fresh process, so initDatabase() — and the reset inside it — runs again.
function run(script) {
    const out = execFileSync(process.execPath, ['-e', `
        process.env.AWT_DB_PATH = ${JSON.stringify(tmpDb)};
        const db = require(${JSON.stringify(dbModule)});
        ${script}
    `], { encoding: 'utf8', env: { ...process.env, AWT_DB_PATH: tmpDb } });
    const marked = out.trim().split('\n').filter(l => l.startsWith('RESULT:'));
    return marked.length ? JSON.parse(marked[marked.length - 1].slice('RESULT:'.length)) : null;
}

const MARKER = 'intel_visibility_baseline_reset_at';
const seedPoisoned = `
    db.prepare("INSERT OR REPLACE INTO players (id, name, has_intel, intel_visible, intel_seen_raw) VALUES (900, 'Seen', 1, 0, 0)").run();
    db.prepare("INSERT OR REPLACE INTO players (id, name, has_intel, intel_visible, intel_seen_raw) VALUES (901, 'Unseen', 0, 0, 0)").run();
`;
const readBack = `
    const rows = db.prepare('SELECT id, has_intel, intel_visible, intel_seen_raw FROM players WHERE id IN (900, 901) ORDER BY id').all();
    const marker = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(${JSON.stringify(MARKER)});
    console.log('RESULT:' + JSON.stringify({ rows, marked: !!marker }));
`;

console.log('intel-visibility-baseline-reset.test.js');

// Step 1: a database that predates the fix — poisoned values present, marker not yet set.
// Deleting the marker is what makes this an upgrade rather than a fresh install; a brand-new
// database has nothing to clear and would prove nothing.
run(`${seedPoisoned}
     db.prepare('DELETE FROM app_settings WHERE key = ?').run(${JSON.stringify(MARKER)});
     ${readBack}`);

console.log('\n-- The upgrade clears the values the blind sweep wrote ' + '-'.repeat(15));
const afterReset = run(readBack);
ok('both players have their confirmed state cleared to NULL',
    afterReset.rows.every(r => r.intel_visible === null && r.intel_seen_raw === null), afterReset.rows);
ok('has_intel is NOT touched — it is the latch that keeps a first-ever capture\n     distinguishable from a regain, and re-announcing 17 old captures is the other\n     way to spam the channel',
    afterReset.rows.find(r => r.id === 900).has_intel === 1
    && afterReset.rows.find(r => r.id === 901).has_intel === 0, afterReset.rows);
ok('and the run records that it happened', afterReset.marked === true, afterReset);

console.log('\n-- And it never runs twice ' + '-'.repeat(43));
// Real baselines established after the reset must survive every later restart, or the hub
// would forget the confirmed state on each deploy and go quiet for two scrapes every time.
const afterSecondBoot = run(`${seedPoisoned}${readBack}`);
ok('a later restart leaves freshly-recorded values exactly where they are',
    afterSecondBoot.rows.every(r => r.intel_visible === 0 && r.intel_seen_raw === 0), afterSecondBoot.rows);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
