// The hub-wide background job rotation (sharedJobs.js): one member's browser at a time,
// one then another, and never the same member twice in a row unless their last run was
// 6 h ago. Rankings and battle-report details once per game day, after the reset.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
const db = require('../database');
const jobs = require('./sharedJobs');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) console.log(`  ok - ${desc}`);
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

const MIN = 60 * 1000, HOUR = 60 * MIN;
const member = name => ({
    userId: Number(db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES (?, 'x')`).run(name).lastInsertRowid),
    gameName: name,
});
const A = member('caveman'), B = member('Harpyie'), C = member('lbahen');
const t0 = Date.UTC(2026, 9, 16, 12, 0, 0); // 14:00 Berlin

console.log('sharedJobs.test.js');

console.log('── galaxy seed: every 10 min, rotating ──');
ok('never ran: the first member gets it', jobs.claim('galaxy-seed', A, t0).granted === true);
ok('a second member asking at once does not (no double run)', jobs.claim('galaxy-seed', B, t0 + 1000).granted === false);
ok('nobody before 10 minutes', jobs.claim('galaxy-seed', B, t0 + 9 * MIN).granted === false);
ok('after 10 minutes, another member', jobs.claim('galaxy-seed', B, t0 + 10 * MIN).granted === true);
ok('then a third', jobs.claim('galaxy-seed', C, t0 + 20 * MIN).granted === true);
ok('A again — B did not run last', jobs.claim('galaxy-seed', A, t0 + 30 * MIN).granted === true);
ok('A cannot take the next turn too', jobs.claim('galaxy-seed', A, t0 + 40 * MIN).granted === false);
const refused = jobs.claim('galaxy-seed', A, t0 + 3 * HOUR);
ok('alone, A still waits until 6 h after their last run', refused.granted === false && refused.next_at_ms === t0 + 30 * MIN + 6 * HOUR, refused);
ok('...and gets it then', jobs.claim('galaxy-seed', A, t0 + 30 * MIN + 6 * HOUR).granted === true);
ok('another member is not held to A\'s 6 h', jobs.claim('galaxy-seed', B, t0 + 30 * MIN + 6 * HOUR + 10 * MIN).granted === true);

console.log('── rankings: once per game day ──');
ok('first ask of the day', jobs.claim('ranking-best-planets', A, t0).granted === true);
ok('another member later the same day: no', jobs.claim('ranking-best-planets', B, t0 + 8 * HOUR).granted === false);
const reset = Date.UTC(2026, 9, 16, 22, 5, 0); // 00:05 Berlin, 17 Oct (CEST)
ok('just before the reset window: no', jobs.claim('ranking-best-planets', B, reset - MIN).granted === false);
ok('after the reset: another member', jobs.claim('ranking-best-planets', B, reset + MIN).granted === true);
ok('rankings are separate jobs', jobs.claim('ranking-highest-population', B, reset + 2 * MIN).granted === true);

console.log('── battle-report details: once per game day, 30 min after the reset ──');
ok('ran in the afternoon', jobs.claim('battle-report-detail', A, t0).granted === true);
ok('not at 00:05 — the reports may not be stored yet', jobs.claim('battle-report-detail', B, reset).granted === false);
ok('at 00:30 Berlin', jobs.claim('battle-report-detail', B, Date.UTC(2026, 9, 16, 22, 30, 0)).granted === true);

console.log('── manual buttons ──');
let threw = false;
try { jobs.claim('player-api-scan', A, t0); } catch (e) { threw = true; }
ok('a manual-only job cannot be claimed', threw);
jobs.record('player-api-scan', B, t0 + 5 * MIN);
const st = jobs.status();
ok('a recorded button press shows who and when', st['player-api-scan'].last_by === 'Harpyie' && st['player-api-scan'].last_at_ms === t0 + 5 * MIN, st['player-api-scan']);
jobs.record('galaxy-seed', C, t0 + 30 * MIN + 6 * HOUR + 12 * MIN);
ok('a manual galaxy seed counts as the latest seed', jobs.claim('galaxy-seed', A, t0 + 30 * MIN + 6 * HOUR + 15 * MIN).granted === false);
threw = false;
try { jobs.record('nonsense', A); } catch (e) { threw = true; }
ok('unknown jobs are refused', threw && !jobs.isJob('nonsense'));

db.close();
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All sharedJobs checks passed');
