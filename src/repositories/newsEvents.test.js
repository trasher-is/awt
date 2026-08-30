const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const newsEvents = require('./newsEvents');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('newsEvents.test.js');

db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Alice'), (2, 'Bob')`).run();

ok('getWatermark returns null before any scrape', newsEvents.getWatermark(1) === null);

const entry1 = {
    player_id: 1, message_type: 'battle-conquer', occurred_at: '2026-08-24T20:54:00Z',
    game_planet_id: 13456, system_id: 5, other_player_id: null, population_delta: null,
    credited_player_id: null, matched_battle_report_id: null,
};
ok('first insert of a new event returns true', newsEvents.insertNewsEvent(entry1) === true);
ok('inserting the exact same event again is ignored (dedup) and returns false',
    newsEvents.insertNewsEvent(entry1) === false);

const row = db.prepare(`SELECT * FROM news_events WHERE player_id = 1`).get();
ok('the stored row has the right message_type', row.message_type === 'battle-conquer', row);
ok('the stored row has the right game_planet_id', row.game_planet_id === 13456, row);

// A different game_planet_id at the same timestamp is a DIFFERENT event (dedup key includes it)
const entry2 = { ...entry1, game_planet_id: 99999 };
ok('a different game_planet_id at the same timestamp is a distinct row', newsEvents.insertNewsEvent(entry2) === true);

newsEvents.advanceWatermark(1, '2026-08-24T20:54:00Z');
ok('watermark advances to the timestamp given', newsEvents.getWatermark(1) === '2026-08-24T20:54:00Z');

newsEvents.advanceWatermark(1, '2026-08-20T00:00:00Z'); // older — must NOT move it backward
ok('watermark never regresses to an earlier timestamp', newsEvents.getWatermark(1) === '2026-08-24T20:54:00Z');

newsEvents.advanceWatermark(1, '2026-08-25T00:00:00Z'); // newer — must advance
ok('watermark advances to a later timestamp', newsEvents.getWatermark(1) === '2026-08-25T00:00:00Z');

ok('a second player still has no watermark', newsEvents.getWatermark(2) === null);

const deletedCount = newsEvents.deleteAllNewsEvents();
ok('deleteAllNewsEvents returns the count deleted', deletedCount === 2, deletedCount);
ok('the table is empty afterward', db.prepare(`SELECT COUNT(*) AS n FROM news_events`).get().n === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
