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

// --- getReportsNeedingLocationBackfill / markLocationBackfillAttempted ---
// Regression coverage for the legacy-gap fix: a report already ship_detail_scraped_at but
// with no system_id (scraped before planet capture existed, or by a stale browser tab).
ok('a fully-detailed report (9002, has system_id) never needs a location backfill',
    !battleReports.getReportsNeedingLocationBackfill(10).includes(9002));

db.prepare(`
    INSERT INTO battle_reports (id, started_at, ship_detail_scraped_at, system_id, planet_index)
    VALUES (9004, '2026-08-22T10:00:00Z', '2026-08-22T10:05:00Z', NULL, NULL)
`).run();
// A never-scraped report (ship_detail_scraped_at NULL) — getReportsNeedingShipDetail's
// job, not this one's — to prove the two queries stay disjoint.
db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (9005, '2026-08-23T10:00:00Z')`).run();
const needingBackfill = battleReports.getReportsNeedingLocationBackfill(10);
ok('a report scraped (ship_detail_scraped_at set) but with no system_id needs a location backfill',
    needingBackfill.includes(9004), needingBackfill);
ok('an unscraped report (ship_detail_scraped_at NULL) is NOT a backfill candidate — that is getReportsNeedingShipDetail\'s job',
    !needingBackfill.includes(9005), needingBackfill);

battleReports.markLocationBackfillAttempted([9004]);
const rowAfterAttempt = db.prepare(`SELECT location_backfill_attempted_at FROM battle_reports WHERE id = ?`).get(9004);
ok('markLocationBackfillAttempted sets the timestamp', rowAfterAttempt.location_backfill_attempted_at != null, rowAfterAttempt);

const noLongerNeedingBackfill = battleReports.getReportsNeedingLocationBackfill(10);
ok('once attempted, the report is never re-selected — even though system_id is STILL null (one attempt, not retried forever)',
    !noLongerNeedingBackfill.includes(9004), noLongerNeedingBackfill);

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

// --- getRecentPlanets / hasAnyBattleHistory ---
ok('no recent planets for a player with no history', battleReports.getRecentPlanets(500).length === 0);
ok('hasAnyBattleHistory is false for a player with no history at all', battleReports.hasAnyBattleHistory(500) === false);

// Player 500 shows up as att_player_id in an OLDER battle report...
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
    VALUES (9201, '2026-08-20T10:00:00Z', 500, 501, 10, 3)
`).run();
const afterBr = battleReports.getRecentPlanets(500);
ok('battle_reports-only: resolves system_id/planet_index and source', afterBr.length === 1 &&
    afterBr[0].system_id === 10 && afterBr[0].planet_index === 3 && afterBr[0].source === 'battle_report' && afterBr[0].source_id === 9201, afterBr);

// ...and as def_player_id in a NEWER one (also proves att/def are both checked).
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
    VALUES (9202, '2026-08-25T10:00:00Z', 502, 500, 20, 7)
`).run();
const afterNewerBr = battleReports.getRecentPlanets(500);
ok('both battle_reports rows come back, newest first, and def_player_id matches too', afterNewerBr.length === 2 &&
    afterNewerBr[0].source_id === 9202 && afterNewerBr[0].system_id === 20 && afterNewerBr[0].planet_index === 7
    && afterNewerBr[1].source_id === 9201, afterNewerBr);

// A News-page bombardment even newer than both battle_reports rows must lead the list, and
// must match by other_player_id too (not just player_id) — matches how
// news-battle-matching.js stores the counterpart. Also carries credited_player_id/
// population_delta, which battle_report rows never do.
db.prepare(`INSERT INTO players (id, name) VALUES (500, 'Target'), (503, 'Scout')`).run();
db.prepare(`
    INSERT INTO news_events (id, player_id, message_type, occurred_at, game_planet_id, system_id, other_player_id, credited_player_id, population_delta)
    VALUES (9301, 503, 'battle-bombarded', '2026-08-28T10:00:00Z', 77777, 30, 500, 503, 12)
`).run();
const afterNews = battleReports.getRecentPlanets(500);
ok('the news_events row leads the list (most recent), all three occurrences present, newest first',
    afterNews.length === 3 && afterNews[0].source_id === 9301 && afterNews[1].source_id === 9202 && afterNews[2].source_id === 9201, afterNews);
ok('the news_events row carries its own shape: system_id/game_planet_id, credited_player_id, population_delta, message_type',
    afterNews[0].system_id === 30 && afterNews[0].game_planet_id === 77777 && afterNews[0].planet_index === null
    && afterNews[0].credited_player_id === 503 && afterNews[0].population_delta === 12 && afterNews[0].source === 'news_event'
    && afterNews[0].message_type === 'battle-bombarded', afterNews[0]);
ok('a battle_report-sourced row has a null message_type (that field only applies to news_events)',
    afterNews[1].message_type === null, afterNews[1]);

// Regression test: a battle-conquer/battle-conquered News row never carries
// credited_player_id/population_delta at all (no opponent link exists on those rows —
// see news-battle-events.js's parseConquestRow), but the caller (discord_bot.js's
// !lastseen) still needs message_type to format it correctly instead of a nonsensical
// "Unknown popkilled ? population" line.
db.prepare(`
    INSERT INTO news_events (id, player_id, message_type, occurred_at, game_planet_id, system_id)
    VALUES (9302, 503, 'battle-conquer', '2026-08-29T10:00:00Z', 88888, 40)
`).run();
// Player 503 (Scout) now has TWO news_events rows: the earlier bombardment (9301) and
// this newer conquest (9302) — both must appear, newest (the conquest) first.
const afterConquer = battleReports.getRecentPlanets(503);
ok('the newer battle-conquer row leads, with its message_type and null credited_player_id/population_delta',
    afterConquer.length === 2 && afterConquer[0].source_id === 9302 && afterConquer[0].message_type === 'battle-conquer'
    && afterConquer[0].credited_player_id === null && afterConquer[0].population_delta === null, afterConquer);
ok('the older bombardment row still follows behind it', afterConquer[1].source_id === 9301, afterConquer);

ok('hasAnyBattleHistory is true once any row (located or not) names the player', battleReports.hasAnyBattleHistory(500) === true);

// A row with no system_id at all (e.g. an unresolved location — the ship-detail scrape
// hasn't reached it yet) must never appear in getRecentPlanets, but MUST still register in
// hasAnyBattleHistory — that's the whole point of the two-function split: distinguishing
// "never in a battle" from "in a battle, but location not scraped yet".
db.prepare(`INSERT INTO players (id, name) VALUES (504, 'NoLocationYet')`).run();
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index)
    VALUES (9203, '2026-08-29T10:00:00Z', 504, 502, NULL, NULL)
`).run();
ok('a row with no system_id contributes nothing to getRecentPlanets', battleReports.getRecentPlanets(504).length === 0);
ok('...but IS visible via hasAnyBattleHistory (distinguishes "no location yet" from "never seen")',
    battleReports.hasAnyBattleHistory(504) === true);

// limit is honored
const limited = battleReports.getRecentPlanets(500, 2);
ok('limit=2 returns exactly the 2 most recent occurrences', limited.length === 2 &&
    limited[0].source_id === 9301 && limited[1].source_id === 9202, limited);

// --- remaining_fleet ---
ok('a battle_report row with no ship-detail scraped has remaining_fleet: null',
    afterBr[0].remaining_fleet === null, afterBr[0]);

// Player 505 was the ATTACKER (destroyers 10/lost 4, cruisers 5/lost 5 — wiped out,
// battleships 0 — never had any, so excluded from byType) in a fully-scraped report.
db.prepare(`INSERT INTO players (id, name) VALUES (505, 'Remnant'), (506, 'Opponent')`).run();
db.prepare(`
    INSERT INTO battle_reports (
        id, started_at, att_player_id, def_player_id, system_id, planet_index,
        att_survived_cv, att_destroyers, att_destroyers_lost, att_cruisers, att_cruisers_lost,
        att_battleships, att_battleships_lost,
        def_survived_cv, def_destroyers, def_destroyers_lost
    ) VALUES (
        9401, '2026-08-30T10:00:00Z', 505, 506, 50, 2,
        3000, 10, 4, 5, 5,
        0, 0,
        0, 20, 20
    )
`).run();
const remainAtt = battleReports.getRecentPlanets(505)[0].remaining_fleet;
ok('attacker-side remaining_fleet: correct CV and per-type math (count - lost)',
    remainAtt && remainAtt.cv === 3000
    && remainAtt.byType.find(t => t.label === 'Destroyers').remaining === 6
    && remainAtt.byType.find(t => t.label === 'Cruisers').remaining === 0, remainAtt);
ok('a ship type the fleet never had (battleships: count 0) is excluded from byType entirely',
    !remainAtt.byType.some(t => t.label === 'Battleships'), remainAtt);

const remainDef = battleReports.getRecentPlanets(506)[0].remaining_fleet;
ok('defender-side remaining_fleet resolves the OTHER side\'s columns (def_*, not att_*)',
    remainDef && remainDef.cv === 0 && remainDef.byType.find(t => t.label === 'Destroyers').remaining === 0, remainDef);

// --- getBattleReportsFeed ---
console.log('\n── getBattleReportsFeed: the unified Battle Reports page feed ' + '─'.repeat(11));

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (700, 'Feed System', 1, 1)`).run();
db.prepare(`INSERT INTO players (id, name) VALUES (700, 'Attacker700'), (701, 'Defender700'), (702, 'Loner702')`).run();

// A real battle report — always linked, since the row IS the report.
db.prepare(`
    INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_name, att_alliance_tag, def_player_name, killed_population, winner)
    VALUES (9500, '2026-08-31T10:00:00Z', 700, 1, 'Attacker700', 'AT', 'Defender700', 40, 'Attacker700')
`).run();

// A POP_DROP with NO matching report nearby (different planet, no report at all) — must
// appear unlinked.
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (700, 2, 702)`).run();
db.prepare(`INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp) VALUES (700, 2, 2, 5, 3, '2026-08-31T09:00:00Z')`).run();

// A POP_DROP that DOES fall within the match window of the report above (same system/
// planet as the report, timestamp inside +/-3h) — must be excluded entirely, not shown as
// a second, unlinked entry for the same battle.
db.prepare(`INSERT INTO planets (system_id, planet_index, owner_id) VALUES (700, 1, 701)`).run();
db.prepare(`INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp) VALUES (700, 1, 2, 10, 6, '2026-08-31T10:05:00Z')`).run();

// An OWNER_CHANGE event (event_type_id 1, not 2) — must never appear in this feed at all,
// matched or not; this feed is specifically battles + population drops.
db.prepare(`INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp) VALUES (700, 2, 1, 701, 702, '2026-08-31T08:00:00Z')`).run();

// Scoped to system 700 — this file shares one DB across all its tests, and earlier
// getRecentPlanets fixtures above also inserted located battle_reports rows.
const feed = battleReports.getBattleReportsFeed(200).filter(r => r.system_id === 700);
ok('exactly 2 rows for system 700: the battle report and the one genuinely unmatched pop-drop (not 4)',
    feed.length === 2, JSON.stringify(feed));

const battleRow = feed.find(r => r.battle_report_id === 9500);
ok('the battle report row is present and linked to its own id', !!battleRow);
ok('the battle row carries attacker/defender/killed_population from battle_reports',
    battleRow.attacker_name === 'Attacker700' && battleRow.attacker_alliance_tag === 'AT'
    && battleRow.defender_name === 'Defender700' && battleRow.killed_population === 40, battleRow);
ok('the battle row resolves the system name via the join', battleRow.system_name === 'Feed System', battleRow);

const dropRow = feed.find(r => r.battle_report_id === null);
ok('the unmatched pop-drop row is present and unlinked (battle_report_id null)', !!dropRow);
ok('the unmatched row resolves the CURRENT planet owner as "defender" (best-effort, not a historical snapshot)',
    dropRow.defender_name === 'Loner702', dropRow);
ok('the unmatched row carries old/new population and a derived killed_population',
    dropRow.old_population === 5 && dropRow.new_population === 3 && dropRow.killed_population === 2, dropRow);

ok('the matched-away pop-drop (system 700/planet 1) does not appear as its own row',
    !feed.some(r => r.battle_report_id === null && r.planet_index === 1), feed);

ok('sorted newest first (the battle at 10:00 before the drop at 09:00)',
    feed[0].occurred_at > feed[1].occurred_at, feed.map(r => r.occurred_at));

const limitedFeed = battleReports.getBattleReportsFeed(1);
ok('limit caps the merged result, not just each half independently', limitedFeed.length === 1, limitedFeed);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
