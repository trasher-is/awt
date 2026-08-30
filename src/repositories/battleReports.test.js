const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const battleReports = require('./battleReports');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('battleReports.test.js');

// Test getPendingAnnouncements returns [] when no rows exist
const emptyPending = battleReports.getPendingAnnouncements();
ok('getPendingAnnouncements returns [] when no rows exist', Array.isArray(emptyPending) && emptyPending.length === 0);

// Test getNewestStartedAt returns null when table is empty
const emptyNewest = battleReports.getNewestStartedAt();
ok('getNewestStartedAt returns null when table is empty', emptyNewest === null);

// Insert several rows with announced = 0 and varying started_at (out-of-order ids to test ORDER BY)
const insertStmt = db.prepare(`INSERT INTO battle_reports (id, started_at, announced) VALUES (?, ?, ?)`);
insertStmt.run(103, '2026-08-28T10:00:00Z', 0);
insertStmt.run(101, '2026-08-28T09:00:00Z', 0);
insertStmt.run(102, '2026-08-28T11:00:00Z', 0);

// Test getPendingAnnouncements returns rows ordered by started_at ASC, id ASC
const pending = battleReports.getPendingAnnouncements();
ok('getPendingAnnouncements returns 3 rows', pending && pending.length === 3);
ok('getPendingAnnouncements orders by started_at ASC (first row is earliest)',
    pending[0] && pending[0].started_at === '2026-08-28T09:00:00Z' && pending[0].id === 101);
ok('getPendingAnnouncements orders by started_at ASC (second row)',
    pending[1] && pending[1].started_at === '2026-08-28T10:00:00Z' && pending[1].id === 103);
ok('getPendingAnnouncements orders by started_at ASC (third row is latest)',
    pending[2] && pending[2].started_at === '2026-08-28T11:00:00Z' && pending[2].id === 102);

// Test markAnnounced flips exactly that row's announced to 1
battleReports.markAnnounced(101);
const afterMark = battleReports.getPendingAnnouncements();
ok('markAnnounced removes only the marked row from pending', afterMark && afterMark.length === 2);
ok('markAnnounced keeps the right rows pending',
    afterMark.some(r => r.id === 103) && afterMark.some(r => r.id === 102) && !afterMark.some(r => r.id === 101));

// Test getNewestStartedAt returns the latest one (string comparison order, matching MAX(started_at))
const newest = battleReports.getNewestStartedAt();
ok('getNewestStartedAt returns the latest started_at value', newest === '2026-08-28T11:00:00Z');

// Test deleteAllBattleReports removes every row regardless of announced state
// First mark another row as announced so we have mixed state
battleReports.markAnnounced(103);
const beforeDelete = battleReports.getPendingAnnouncements();
ok('before delete: confirmed 1 row still pending', beforeDelete && beforeDelete.length === 1);

const deleted = battleReports.deleteAllBattleReports();
ok('deleteAllBattleReports returns the count deleted', deleted === 3);

const afterDelete = battleReports.getPendingAnnouncements();
ok('deleteAllBattleReports removes every row (pending is now empty)', afterDelete && afterDelete.length === 0);

const afterDeleteNewest = battleReports.getNewestStartedAt();
ok('getNewestStartedAt returns null after delete', afterDeleteNewest === null);

// Test getReportsNeedingShipDetail returns [] when there are no reports
ok('getReportsNeedingShipDetail returns [] when there are no reports', battleReports.getReportsNeedingShipDetail(10).length === 0);

db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (?, ?)`).run(9001, '2026-08-20T10:00:00Z');
db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (?, ?)`).run(9002, '2026-08-25T10:00:00Z');
db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (?, ?)`).run(9003, '2026-08-15T10:00:00Z');

const needing = battleReports.getReportsNeedingShipDetail(10);
ok('all 3 fresh reports need ship detail', needing.length === 3 && needing.includes(9001) && needing.includes(9002) && needing.includes(9003), needing);
ok('newest report first (started_at DESC)', needing[0] === 9002, needing);

battleReports.markShipDetailScraped([9001, 9003]);
const stillNeeding = battleReports.getReportsNeedingShipDetail(10);
ok('scraped reports are excluded, unscraped one remains', stillNeeding.length === 1 && stillNeeding[0] === 9002, stillNeeding);

battleReports.updateShipDetail(9002, {
    att_destroyers: 100, att_destroyers_lost: 10, att_cruisers: 5, att_cruisers_lost: 1,
    att_battleships: 2, att_battleships_lost: 0, att_transports: 3, att_transports_lost: 3,
    att_colony_ships: 0, att_colony_ships_lost: 0, att_starbases: 0, att_starbases_lost: 0,
    def_destroyers: 50, def_destroyers_lost: 50, def_cruisers: 0, def_cruisers_lost: 0,
    def_battleships: 0, def_battleships_lost: 0, def_transports: 0, def_transports_lost: 0,
    def_colony_ships: 0, def_colony_ships_lost: 0, def_starbases: 1, def_starbases_lost: 1,
    win_chance: 62.5, system_id: 243, planet_index: 12,
});
const updated = db.prepare(`SELECT * FROM battle_reports WHERE id = ?`).get(9002);
ok('updateShipDetail writes the ship-type fields', updated.att_destroyers === 100 && updated.def_starbases_lost === 1 && updated.win_chance === 62.5, updated);
ok('updateShipDetail writes the planet location fields', updated.system_id === 243 && updated.planet_index === 12, updated);
ok('updateShipDetail also marks the report scraped', updated.ship_detail_scraped_at != null, updated);
const noLongerNeeding = battleReports.getReportsNeedingShipDetail(10);
ok('the updated report no longer appears in getReportsNeedingShipDetail', !noLongerNeeding.includes(9002), noLongerNeeding);

// --- findByPlayerPairNear ---
db.prepare(`INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id) VALUES (?, ?, ?, ?)`)
    .run(9101, '2026-08-24T10:00:00Z', 1, 2);

ok('finds a match with the pair in (att, def) order, within the window',
    battleReports.findByPlayerPairNear(1, 2, '2026-08-24T10:10:00Z', 15) === 9101);
ok('finds a match with the pair reversed (def, att) — direction does not matter',
    battleReports.findByPlayerPairNear(2, 1, '2026-08-24T10:10:00Z', 15) === 9101);
ok('no match when the timestamp is outside the window',
    battleReports.findByPlayerPairNear(1, 2, '2026-08-24T11:00:00Z', 15) === null);
ok('no match for a different player pair entirely',
    battleReports.findByPlayerPairNear(1, 3, '2026-08-24T10:10:00Z', 15) === null);

// --- getLastSeenPlanet ---
ok('no last-seen record for a player with no history', battleReports.getLastSeenPlanet(500) === null);

// Player 500 shows up as att_player_id in an OLDER battle report...
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
    VALUES (9201, '2026-08-20T10:00:00Z', 500, 501, 10, 3)
`).run();
const afterBr = battleReports.getLastSeenPlanet(500);
ok('battle_reports-only: resolves system_id/planet_index and source', afterBr &&
    afterBr.system_id === 10 && afterBr.planet_index === 3 && afterBr.source === 'battle_report' && afterBr.source_id === 9201, afterBr);

// ...and as def_player_id in a NEWER one (also proves att/def are both checked).
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
    VALUES (9202, '2026-08-25T10:00:00Z', 502, 500, 20, 7)
`).run();
const afterNewerBr = battleReports.getLastSeenPlanet(500);
ok('picks the MORE RECENT battle_reports row, and matches on def_player_id too', afterNewerBr &&
    afterNewerBr.system_id === 20 && afterNewerBr.planet_index === 7 && afterNewerBr.source_id === 9202, afterNewerBr);

// A News-page bombardment even newer than both battle_reports rows must win, and must
// match by other_player_id too (not just player_id) — matches how news-battle-matching.js
// stores the counterpart.
db.prepare(`INSERT INTO players (id, name) VALUES (500, 'Target'), (503, 'Scout')`).run();
db.prepare(`
    INSERT INTO news_events (id, player_id, message_type, occurred_at, game_planet_id, system_id, other_player_id)
    VALUES (9301, 503, 'battle-bombarded', '2026-08-28T10:00:00Z', 77777, 30, 500)
`).run();
const afterNews = battleReports.getLastSeenPlanet(500);
ok('a more recent news_events row (matched via other_player_id) wins over both battle_reports rows',
    afterNews && afterNews.system_id === 30 && afterNews.game_planet_id === 77777
    && afterNews.planet_index === null && afterNews.source === 'news_event' && afterNews.source_id === 9301, afterNews);

// A row with no system_id at all (e.g. an unresolved location) must never win by having a
// later timestamp — it carries no usable location, so it must be filtered out entirely.
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
    VALUES (9203, '2026-08-29T10:00:00Z', 500, 502, NULL, NULL)
`).run();
const afterNullLocation = battleReports.getLastSeenPlanet(500);
ok('a row with no system_id is ignored even though it is the newest by timestamp',
    afterNullLocation && afterNullLocation.source_id === 9301, afterNullLocation);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
