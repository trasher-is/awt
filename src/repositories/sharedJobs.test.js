// The hub-wide background job rotation (sharedJobs.js): one member's browser at a time,
// one then another, and never the same member twice in a row unless their last run was
// 6 h ago. Battle reports, their details and the rankings once per game day, after the
// reset. The galaxy seed is a button only since 2026-10-17.
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

console.log('── battle reports: once per game day, for the whole hub, rotating ──');
const evening = Date.UTC(2026, 9, 16, 19, 0, 0); // 21:00 Berlin, 16 Oct
const nextReset = Date.UTC(2026, 9, 16, 22, 5, 0); // 00:05 Berlin, 17 Oct (CEST)
ok('never ran: the first member gets it', jobs.claim('battle-sync', A, evening).granted === true);
jobs.finish('battle-sync', evening + MIN); // A's pull landed (POST /sync/battle-reports)
ok('a second member asking at once does not (no double run)', jobs.claim('battle-sync', B, evening + 1000).granted === false);
ok('nobody else the same game day', jobs.claim('battle-sync', C, evening + 2 * HOUR).granted === false);
const again = jobs.claim('battle-sync', A, nextReset + 5 * MIN);
ok('after the reset, A (who ran last, 3 h ago) waits until 6 h after their run', again.granted === false && again.next_at_ms === evening + 6 * HOUR, again);
ok('...while another member gets it right after the reset', jobs.claim('battle-sync', B, nextReset + 5 * MIN).granted === true);

console.log('── battle reports: a claim that never delivers lapses after 15 min ──');
// NSA hub, 30 Oct 2026: a tab claimed the day's pull and never POSTed, so no other tab
// retried and the whole day's battles were missing until the next reset.
const claimB = nextReset + 5 * MIN; // B's claim above, not finished
ok('within 15 min another member still waits (B may be mid-pull)', jobs.claim('battle-sync', A, claimB + 10 * MIN).granted === false);
const bAgain = jobs.claim('battle-sync', B, claimB + 20 * MIN);
ok('B themself does not retry right away: 6 h after their claim', bAgain.granted === false && bAgain.next_at_ms === claimB + 6 * HOUR, bAgain);
ok('after 15 min another member may claim it again the same day', jobs.claim('battle-sync', C, claimB + 20 * MIN).granted === true);
jobs.finish('battle-sync', claimB + 22 * MIN);
const done = jobs.claim('battle-sync', A, claimB + 3 * HOUR);
ok('once that pull lands, the day is done: next after the next reset', done.granted === false && done.next_at_ms === Date.UTC(2026, 9, 17, 22, 5, 0), done);
let finishThrew = false;
try { jobs.finish('galaxy-seed'); } catch (e) { finishThrew = true; }
ok('finish() refuses jobs that are never claimed', finishThrew);

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
threw = false;
try { jobs.claim('galaxy-seed', A, t0); } catch (e) { threw = true; }
ok('the galaxy seed is a button now: a stale tab cannot claim it as a background job', threw && !jobs.isClaimable('galaxy-seed'));
jobs.record('galaxy-seed', C, t0 + 12 * MIN);
ok('a Galaxy button press is recorded for the "last scan" line', jobs.status()['galaxy-seed'].last_by === 'lbahen');
threw = false;
try { jobs.record('nonsense', A); } catch (e) { threw = true; }
ok('unknown jobs are refused', threw && !jobs.isJob('nonsense'));

db.close();
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All sharedJobs checks passed');
