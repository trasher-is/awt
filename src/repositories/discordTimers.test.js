const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const timers = require('./discordTimers');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('discordTimers.test.js');

const past = new Date(Date.now() - 60000).toISOString();
const future = new Date(Date.now() + 3600000).toISOString();

timers.insertTimer('user-1', 'chan-1', 'a past-due timer', past);
timers.insertTimer('user-1', 'chan-1', 'a future timer', future);

const dueNow = timers.getDueTimers(new Date().toISOString());
ok('getDueTimers finds only the past-due row', dueNow.length === 1 && dueNow[0].label === 'a past-due timer');

timers.markTimerFired(dueNow[0].id);
ok('markTimerFired sets fired_at', !!db.prepare('SELECT fired_at FROM discord_timers WHERE id = ?').get(dueNow[0].id).fired_at);

const dueAfterFiring = timers.getDueTimers(new Date().toISOString());
ok('getDueTimers no longer returns the fired row', dueAfterFiring.length === 0);

const stillFuture = db.prepare(`SELECT COUNT(*) c FROM discord_timers WHERE fired_at IS NULL`).get().c;
ok('the future timer is untouched and still unfired', stillFuture === 1);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
