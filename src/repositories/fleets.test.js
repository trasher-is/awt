const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const fleets = require('./fleets');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('fleets.test.js');

db.prepare(`INSERT INTO players (id, name) VALUES (1, 'caveman')`).run();

ok('countFleets starts at 0', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
ok('countFleets is 1 after insert', fleets.countFleets() === 1);

const forSystem = fleets.getFleetsForSystem(10);
ok('getFleetsForSystem returns the fleet', forSystem.length === 1 && forSystem[0].owner_name === 'caveman');
db.prepare('UPDATE fleets SET arrival_at = ?, arrival_time = ? WHERE owner_id = 1')
    .run('2026-09-12T18:30:00Z', 'Sep 12 8:30 PM');
const arriving = fleets.getFleetsForSystem(10)[0];
ok('system intel exposes the canonical instant for viewer-local arrival display',
    arriving.arrival_at === '2026-09-12T18:30:00Z');
ok('legacy arrival text remains available without guessing its timezone', arriving.arrival_time === 'Sep 12 8:30 PM');

const upd = fleets.updateFleetGameId(999, 1, 10, 1);
ok('updateFleetGameId updates one row', upd.changes === 1);

fleets.deleteFleetsByOwner(1);
ok('deleteFleetsByOwner removes the fleet', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
fleets.deleteAllFleets();
ok('deleteAllFleets empties the table', fleets.countFleets() === 0);

// --- getFleetLocationMatches: the planet the ranking printed, with its owner ---
console.log('\n── getFleetLocationMatches ' + '─'.repeat(40));

db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (10, 'RAID', 'Raiders'), (20, 'FOE', 'Enemies')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (201, 'Hypnos', 20), (202, 'Acquario', 20), (203, 'Legacy', 20)`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (300, 'Beshgar Noctis', 0, 0), (301, 'Praepes', 1, 1)`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES
    (30004, 300, 4, 201), -- Hypnos's own planet
    (30109, 301, 9, 202)  -- Acquario's planet
`).run();

const at = (system_id, planet_index, planet_label) => ({ system_id, planet_index, planet_label });
fleets.replaceStrongestFleetsForPlayer(201, [
    { rank: 10, destroyers: 300, cruisers: 0, battleships: 0, cv: 900, ...at(300, 4, 'Beshgar Noctis #4') },  // home
    { rank: 40, destroyers: 93, cruisers: 0, battleships: 0, cv: 279, ...at(301, 9, 'Praepes #9') },          // on Acquario's planet
    { rank: 45, destroyers: 70, cruisers: 0, battleships: 0, cv: 210, ...at(301, 2, 'Praepes #2') },          // unowned planet
    { rank: 48, destroyers: 60, cruisers: 0, battleships: 0, cv: 180, ...at(null, 3, 'Nowhere #3') },         // system never scanned
], '2026-10-08T23:00:00.000Z');
fleets.replaceStrongestFleetsForPlayer(203, [{ rank: 20, destroyers: 100, cruisers: 0, battleships: 0, cv: 300 }], '2026-10-07T23:00:00.000Z'); // pre-Planet-column row

const matches = fleets.getFleetLocationMatches();
const byRank = Object.fromEntries(matches.map(m => [m.rank, m]));
ok('every fleet comes back, a player\'s several fleets each on their own', matches.length === 5);
ok('a fleet on its owner\'s own planet is home',
    byRank[10].location_status === 'home' && byRank[10].location.system_name === 'Beshgar Noctis' && byRank[10].location.planet_index === 4);
ok('a fleet on another player\'s planet is parked, naming that owner',
    byRank[40].location_status === 'parked' && byRank[40].location.owner_name === 'Acquario' && byRank[40].location.game_planet_id === 30109);
ok('a fleet on an unowned planet is parked with no owner',
    byRank[45].location_status === 'parked' && byRank[45].location.owner_id === null && byRank[45].location.system_name === 'Praepes');
ok('a fleet in an unscanned system is unknown, but keeps the printed planet text',
    byRank[48].location_status === 'unknown' && byRank[48].location === null && byRank[48].planet_label === 'Nowhere #3');
ok('a row from before the Planet column is unknown', byRank[20].location_status === 'unknown' && byRank[20].planet_label === null);
ok('getFleetLocationMatchesForPlayer returns only that player\'s fleets',
    fleets.getFleetLocationMatchesForPlayer(201).length === 4 && fleets.getFleetLocationMatchesForPlayer(203).length === 1);

fleets.replaceStrongestFleetsForPlayer(201, [{ rank: 3, destroyers: 400, cruisers: 0, battleships: 0, cv: 1200, ...at(300, 4, 'Beshgar Noctis #4') }], '2026-10-09T23:00:00.000Z');
ok('replacing a player\'s fleets drops the ones no longer listed and leaves other players alone',
    fleets.getFleetLocationMatchesForPlayer(201).length === 1 && fleets.getFleetLocationMatchesForPlayer(203).length === 1);

fleets.deleteAllStrongestFleet();
ok('deleteAllStrongestFleet empties the table', db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet`).get().n === 0);
db.prepare(`DELETE FROM best_guarded`).run();
db.prepare(`DELETE FROM planets`).run();
db.prepare(`DELETE FROM systems`).run();
db.prepare(`DELETE FROM players`).run();
db.prepare(`DELETE FROM alliances`).run();

// --- getFleetSightingHistory: merging rankings/battle-report/vision sightings ---
console.log('\n── getFleetSightingHistory ' + '─'.repeat(40));

// The history window is measured back from the real clock (datetime('now') in SQL), so
// every sighting here is placed relative to it. Fixed dates made this block fail once
// they were more than 5 days old.
const hoursAgo = hours => new Date(Date.now() - hours * 3600 * 1000).toISOString();

db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (30, 'FOE', 'Enemies')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (301, 'kralgar', 30), (302, 'Victim', 30)`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (400, 'Praepes', 0, 0), (401, 'Maasym', 1, 1), (402, 'OldSystem', 9, 9)`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id) VALUES (40001, 400, 6, 301)`).run();
// Rankings sighting: home, fresh.
fleets.replaceStrongestFleetsForPlayer(301, [
    { rank: 1, destroyers: 325, cruisers: 0, battleships: 0, cv: 975, system_id: 400, planet_index: 6, planet_label: 'Praepes #6' },
], hoursAgo(28));

// Battle-report sighting: kralgar is the ATTACKER, more recent than the rankings sighting.
// He fielded 300 destroyers and lost 50 of them, plus 10 transports (none lost) -- the
// history should show what SURVIVED (250 / 10), not what he brought (300 / 10).
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index,
        att_destroyers, att_destroyers_lost, att_cruisers, att_battleships, att_transports, att_colony_ships)
    VALUES (8001, ?, 301, 302, 401, 3, 300, 50, 0, 0, 10, 0)
`).run(hoursAgo(26));

// A second battle report where kralgar lost EVERYTHING -- this must not appear at all.
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index,
        att_destroyers, att_destroyers_lost)
    VALUES (8003, ?, 301, 302, 401, 3, 20, 20)
`).run(hoursAgo(25));

// Vision sighting: oldest of the three but still inside the 5-day window.
db.prepare(`INSERT INTO fleets (owner_id, system_id, planet_index, destroyers, cruisers, battleships, updated_at)
            VALUES (301, 400, 6, 300, 0, 0, ?)`).run(hoursAgo(56));

// A stale battle report from 6 days ago -- must NOT appear in a 5-day history.
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id, system_id, planet_index, att_destroyers)
    VALUES (8002, datetime('now', '-6 days'), 301, 302, 402, 1, 5)
`).run();

const history = fleets.getFleetSightingHistory(301, 5);
ok('exactly 3 sightings within the window (the 6-day-old report and the wipeout are excluded)', history.length === 3, history);
ok('sorted newest first: battle report, then rankings, then vision',
    history[0].source === 'battle_report' && history[1].source === 'rankings' && history[2].source === 'vision',
    history.map(h => h.source));
ok('the rankings entry carries the CONFIRMED home location the ranking printed',
    history[1].system_name === 'Praepes' && history[1].location_status === 'home' && history[1].location_confirmed === true, history[1]);
ok('the battle-report entry shows SURVIVORS (300-50=250 destroyers), not what was fielded',
    history[0].destroyers === 250 && history[0].transports === 10, history[0]);
ok('the wiped-out report (8003, 20 destroyers all lost) does not appear anywhere in the history',
    !history.some(h => h.source_id === 8003), history);
ok('the battle-report and vision entries have their CV recomputed from surviving composition (250 destroyers = 750 CV), not left null',
    history[0].cv === 750 && history[2].cv === 900, [history[0].cv, history[2].cv]);
ok('the vision entry carries its own system/planet directly, no location_status',
    history[2].system_name === 'Praepes' && history[2].planet_index === 6 && history[2].location_status === null, history[2]);

// A rankings row from before the Planet column has no location of its own, and falls back
// to the player's registered home planet rather than a bare dash -- Last Seen already
// carries the "how sure are we" signal.
db.prepare(`INSERT INTO players (id, name, alliance_id, origin_system) VALUES (303, 'Loner', 30, 400)`).run();
fleets.replaceStrongestFleetsForPlayer(303, [{ rank: 2, destroyers: 1, cruisers: 0, battleships: 0, cv: 3 }], hoursAgo(28));
const legacyHistory = fleets.getFleetSightingHistory(303, 5);
ok('a rankings row with no location falls back to the player\'s registered home system, marked unconfirmed',
    legacyHistory.length === 1 && legacyHistory[0].source === 'rankings'
    && legacyHistory[0].system_id === 400 && legacyHistory[0].system_name === 'Praepes'
    && legacyHistory[0].planet_index === 1 // COALESCE(home_planet_index, 1): Loner has none on record
    && legacyHistory[0].location_status === 'unknown' && legacyHistory[0].location_confirmed === false, legacyHistory);

// Several ranked fleets are several sightings; one older than the window is left out.
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (304, 'Hypnos', 30)`).run();
fleets.replaceStrongestFleetsForPlayer(304, [
    { rank: 10, destroyers: 300, cruisers: 0, battleships: 0, cv: 900, system_id: 400, planet_index: 4, planet_label: 'Praepes #4' },
    { rank: 40, destroyers: 93, cruisers: 0, battleships: 0, cv: 279, system_id: 401, planet_index: 9, planet_label: 'Maasym #9' },
], hoursAgo(20));
const multiHistory = fleets.getFleetSightingHistory(304, 5);
ok('each of a player\'s ranked fleets is its own sighting at its own planet',
    multiHistory.length === 2 && multiHistory.every(h => h.source === 'rankings' && h.location_confirmed)
    && multiHistory.map(h => h.system_name).sort().join('|') === 'Maasym|Praepes', multiHistory);
db.prepare(`UPDATE strongest_fleet SET updated_at = ? WHERE player_id = 304`).run(new Date(Date.now() - 6 * 86400000).toISOString());
ok('ranked fleets older than the window are not sightings', fleets.getFleetSightingHistory(304, 5).length === 0);

db.prepare(`DELETE FROM battle_reports`).run();
db.prepare(`DELETE FROM fleets`).run();
fleets.deleteAllStrongestFleet();
db.prepare(`DELETE FROM best_guarded`).run();
db.prepare(`DELETE FROM planets`).run();
db.prepare(`DELETE FROM systems`).run();
db.prepare(`DELETE FROM players`).run();
db.prepare(`DELETE FROM alliances`).run();

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
