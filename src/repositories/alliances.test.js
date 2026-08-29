const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const alliances = require('./alliances');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('alliances.test.js');

ok('countAlliances starts at 0', alliances.countAlliances() === 0);

alliances.upsertAllianceBasic(1, 'RAID', 'Raiders');
ok('countAlliances is 1 after upsert', alliances.countAlliances() === 1);
ok('upsertAllianceBasic set the tag', db.prepare('SELECT tag FROM alliances WHERE id = ?').get(1).tag === 'RAID');

// upsertAllianceBasic touches updated_at on conflict; upsertAllianceTagOnly does not.
const afterBasic = db.prepare('SELECT updated_at FROM alliances WHERE id = ?').get(1).updated_at;
alliances.upsertAllianceTagOnly(1, 'RAID2', 'Raiders');
const afterTagOnly = db.prepare('SELECT tag, updated_at FROM alliances WHERE id = ?').get(1);
ok('upsertAllianceTagOnly updates the tag', afterTagOnly.tag === 'RAID2');
ok('upsertAllianceTagOnly does not touch updated_at, unlike upsertAllianceBasic', afterTagOnly.updated_at === afterBasic);

alliances.upsertAllianceFull({ id: 2, name: 'Allied Ops', tag: 'AO', leader_id: null, ranking: 5, points: 1000 });
ok('upsertAllianceFull created the alliance', alliances.countAlliances() === 2);
ok('upsertAllianceFull set points_current', db.prepare('SELECT points_current FROM alliances WHERE id = ?').get(2).points_current === 1000);

db.prepare(`INSERT INTO players (id, name, alliance_id, has_intel, race_trader) VALUES (1, 'caveman', 1, 1, 0)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, has_intel, race_trader) VALUES (2, 'trader1', 2, 1, 3)`).run();

const intelTags = alliances.getWarRoomAllianceIntelTags();
ok('getWarRoomAllianceIntelTags finds both intel alliances', intelTags.length === 2);

const warRoom = alliances.getWarRoomAlliances();
ok('getWarRoomAlliances counts active members per alliance', warRoom.find(a => a.id === 1).active_members_count === 1);

alliances.upsertHoardedAu(2, 5000);
const traders = alliances.getTraders();
ok('getTraders finds the race_trader player', traders.length === 1 && traders[0].name === 'trader1');

const members = alliances.getMembersWithStats();
ok('getMembersWithStats joins hoarded_au from alliance_member_stats', members.find(m => m.name === 'trader1').hoarded_au === 5000);

const canonical = alliances.getCanonicalNameFromStats('TRADER1');
ok('getCanonicalNameFromStats is case-insensitive', canonical && canonical.name === 'trader1');

alliances.upsertAllianceMemberStats(1, '[]', null, '10', '5', '20', '1000', '500', 'None', 'Lvl 5', '100K', 1, 2, 3, 4, 50);
const statIds = alliances.getAllianceMemberStatIds();
ok('getAllianceMemberStatIds now includes both players', statIds.length === 2);

const tradeRows = alliances.getTradeAnalysisRows();
ok('getTradeAnalysisRows returns the stats-joined-to-player rows', tradeRows.length === 2);

const archiveStats = alliances.getAllianceStatsForArchive();
ok('getAllianceStatsForArchive returns full stats rows with player_name', archiveStats.find(s => s.player_id === 1).player_name === 'caveman');

const staleResult = alliances.deleteStaleAllianceMembers([1]);
ok('deleteStaleAllianceMembers removes player 2\'s stats row', staleResult.changes === 1);
ok('deleteStaleAllianceMembers returns {changes: 0} for an empty id list', alliances.deleteStaleAllianceMembers([]).changes === 0);

alliances.insertBroadcast('Attention!!!', 'Test message', 'admin', '2026-01-01 00:00:00');
const broadcasts = alliances.getBroadcasts();
ok('insertBroadcast/getBroadcasts round-trip', broadcasts.length === 1 && broadcasts[0].message === 'Test message');

alliances.updateBroadcast('Updated', 'Changed message', 'admin', '2026-01-02 00:00:00', broadcasts[0].id);
ok('updateBroadcast changes the message', alliances.getBroadcasts()[0].message === 'Changed message');

alliances.deleteBroadcast(broadcasts[0].id);
ok('deleteBroadcast empties the table', alliances.getBroadcasts().length === 0);

alliances.upsertAllianceFromApiSearch(501, 'Star Raiders', 'SR', 'The Star Raiders Collective', 24);
const found = alliances.searchAlliancesByTagOrName('%Star%', '501');
ok('search by name substring finds the alliance', found.length === 1 && found[0].id === 501);
ok('full_name is returned', found[0].full_name === 'The Star Raiders Collective');
ok('member_count is returned', found[0].member_count === 24);

const byTag = alliances.searchAlliancesByTagOrName('%SR%', '999999');
ok('search by tag substring also finds it', byTag.some(a => a.id === 501));

const byExactId = alliances.searchAlliancesByTagOrName('%nomatch%', '501');
ok('an exact id match works even when the LIKE term matches nothing', byExactId.some(a => a.id === 501));

alliances.upsertAllianceFromApiSearch(501, 'Star Raiders', 'SR', 'Updated Full Name', 30);
const updated = alliances.searchAlliancesByTagOrName('%Star%', '501');
ok('calling it again on the same id updates in place, not a duplicate row', updated.length === 1 && updated[0].full_name === 'Updated Full Name' && updated[0].member_count === 30);

alliances.deleteAllAlliances();
ok('deleteAllAlliances empties the table', alliances.countAlliances() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
