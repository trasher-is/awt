const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const players = require('./players');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('players.test.js');

db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders')`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (10, 'Rana', 5, 5)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, discord_name) VALUES (2, 'caveman', 'x', 'caveman')`).run();

ok('countPlayers starts at 0', players.countPlayers() === 0);

players.upsertPlayerBasic(1, 'caveman', 1);
ok('countPlayers is 1 after upsert', players.countPlayers() === 1);
ok('upsertPlayerBasic set the name', players.getPlayerNameWithTag(1).name === 'caveman');
ok('upsertPlayerBasic joined the alliance tag', players.getPlayerNameWithTag(1).alliance_tag === 'RAID');

// upsertPlayerBasic preserves alliance_id when the new value is null (unlike upsertAllianceMemberBasic).
players.upsertPlayerBasic(1, 'caveman', null);
ok('upsertPlayerBasic keeps the existing alliance_id on a null update', players.getPlayerNameWithTag(1).alliance_tag === 'RAID');

// upsertAllianceMemberBasic unconditionally overwrites alliance_id.
db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (2, 'AO', 'Allied Ops')`).run();
players.upsertAllianceMemberBasic(1, 'caveman', 2);
ok('upsertAllianceMemberBasic overwrites alliance_id unconditionally', players.getPlayerNameWithTag(1).alliance_tag === 'AO');

players.upsertPlayerNameOnly(2, 'stahlburg');
ok('upsertPlayerNameOnly creates a bare-name row', players.getPlayerBiologyByName('stahlburg').id === 2);

db.prepare(`UPDATE players SET points = 500, biology = 7, has_intel = 1 WHERE id = ?`).run(1);
players.resetPlayerOnRestart(1);
const afterReset = db.prepare(`SELECT points, biology, has_intel FROM players WHERE id = ?`).get(1);
ok('resetPlayerOnRestart zeroes public stats like points', afterReset.points === 0);
ok('resetPlayerOnRestart does not touch intel-derived columns like biology/has_intel', afterReset.biology === 7 && afterReset.has_intel === 1);

const check = players.getPlayerRestartCheck(2);
ok('getPlayerRestartCheck returns logins/points/origin_system', 'logins' in check && 'points' in check && 'origin_system' in check);

players.insertPlayerLogin(1, 50);
const history = players.getPlayerLoginHistory(1);
ok('getPlayerLoginHistory returns the logged row', history.length === 1 && history[0].total_logins === 50);

const heatmap = players.getPlayerLoginHeatmap(1);
ok('getPlayerLoginHeatmap groups by hour', heatmap.length === 1 && heatmap[0].count === 1);

const withPlanets = players.getPlayerWithPlanetCount(1);
ok('getPlayerWithPlanetCount returns the player row', withPlanets.id === 1);
ok('getPlayerWithPlanetCount includes a planet_count field', 'planet_count' in withPlanets);

const tagLookup = players.getAllianceTagForMembers([1, 2]);
ok('getAllianceTagForMembers finds the majority alliance', tagLookup && tagLookup.tag === 'AO');
ok('getAllianceTagForMembers returns undefined for an empty id list', players.getAllianceTagForMembers([]) === undefined);

db.prepare(`UPDATE players SET origin_system = 10 WHERE id = 1`).run();
const observers = players.getVisionObservers([1, 2]);
ok('getVisionObservers only returns players with a mapped origin system', observers.length === 1 && observers[0].playerId === 1);

const combatDef = players.getPlayerCombatStats('caveman');
const combatAtk = players.getPlayerCombatStats('caveman');
ok('getPlayerCombatStats is reusable for both --def and --atk lookups', combatDef.name === combatAtk.name && combatDef.name === 'caveman');

const byName = players.getPlayerCombatStatsByName('CAVEMAN'.toLowerCase());
const byId = players.getPlayerCombatStatsById(1);
ok('getPlayerCombatStatsByName and getPlayerCombatStatsById agree on the same player', byName.level === byId.level);

const statsByIds = players.getPlayerStatsByIds([1, 2, 999]);
ok('getPlayerStatsByIds returns only existing ids', statsByIds.length === 2);
ok('getPlayerStatsByIds returns an empty array for an empty id list', players.getPlayerStatsByIds([]).length === 0);

const searchResults = players.searchPlayersByNameOrId('%cave%', '1');
ok('searchPlayersByNameOrId finds by partial name', searchResults.some(r => r.id === 1));

const idByName = players.getPlayerIdByName('CAVEMAN');
ok('getPlayerIdByName is case-insensitive', idByName && idByName.id === 1);

players.upsertPlayerFull({
    id: 3, name: 'newscout', alliance_id: null, country: null, local_time: null, idle_time: null,
    origin_system: null, level: 5, ranking: null, points: 100, science_level: 2, culture_level: 1,
    biology: 3, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
    trade_revenue: 0, artefact: null, eco_bonus: 0,
    race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0,
    race_trader: 0, race_sul: 0, joined: null, logins: 1, has_intel: 1,
    home_planet_id: null, home_system_id: null, home_planet_index: null, possible_homes: '[]',
    total_planets: 0, total_population: 0, total_farms: 0, total_factories: 0, total_labs: 0, total_cybernetics: 0, cv_used: 0, cv_limit: 0
});
ok('upsertPlayerFull created the player', players.countPlayers() === 3);
ok('upsertPlayerFull respected has_intel=1 for biology', players.getPlayerWithPlanetCount(3).biology === 3);
ok('upsertPlayerFull stamps stats_scraped_at — the profile page uses this for building-count staleness, not updated_at',
    players.getPlayerWithPlanetCount(3).stats_scraped_at != null);

players.resetPlayerOnRestart(3);
ok('resetPlayerOnRestart also clears stats_scraped_at — the buildings it timestamped were just zeroed',
    players.getPlayerWithPlanetCount(3).stats_scraped_at === null);

players.deleteAllPlayers();
ok('deleteAllPlayers empties the table', players.countPlayers() === 0);

ok('getPlayerName returns undefined for an unknown id', players.getPlayerName(999999) === undefined);

players.upsertPlayerBasic(701, 'Original Name', null);
const before = players.getPlayerName(701);
ok('getPlayerName finds an existing player', before && before.name === 'Original Name', before);

players.recordNameChange(701, before.name);
// (verify via a direct query since there's no getter for this yet — that's fine, the
// route layer in Task 4 is the real consumer; a raw check here just confirms the write)
const historyRow = db.prepare('SELECT old_name FROM player_name_history WHERE player_id = ?').get(701);
ok('recordNameChange writes the old name', historyRow.old_name === 'Original Name', historyRow);

// recordNameChangeIfDifferent: the reusable check-and-record helper now shared by all six
// players.name write paths (finding 2).
players.upsertPlayerBasic(720, 'NameGuardOne', null);
players.recordNameChangeIfDifferent(720, 'NameGuardOne'); // same name: no-op
ok('recordNameChangeIfDifferent is a no-op when the name is unchanged',
    db.prepare('SELECT COUNT(*) as c FROM player_name_history WHERE player_id = ?').get(720).c === 0);

players.recordNameChangeIfDifferent(999998, 'Anyone'); // no player/current name on record: no-op
ok('recordNameChangeIfDifferent is a no-op when there is no current name yet',
    db.prepare('SELECT COUNT(*) as c FROM player_name_history WHERE player_id = ?').get(999998).c === 0);

players.recordNameChangeIfDifferent(720, 'NameGuardTwo');
const nameGuardHistory = db.prepare('SELECT old_name FROM player_name_history WHERE player_id = ?').get(720);
ok('recordNameChangeIfDifferent logs the old name when it differs',
    nameGuardHistory && nameGuardHistory.old_name === 'NameGuardOne', nameGuardHistory);

players.upsertPlayerFromApiList(701, 'New From List', null, 42, 5000, 3, 'US', 1, '2026-08-01T00:00:00Z');
const afterList = players.getPlayerFullById(701);
ok('upsertPlayerFromApiList updates name/level/points/ranking/country/is_active_player/joined',
    afterList.name === 'New From List' && afterList.level === 42 && afterList.points === 5000
    && afterList.ranking === 3 && afterList.country === 'US' && afterList.is_active_player === 1
    && afterList.joined === '2026-08-01T00:00:00Z', afterList);
ok('upsertPlayerFromApiList does not touch home_planet_id (never in its column list)', afterList.home_planet_id === null, afterList);

// Finding 6: a later ListPlayer row that omits ranking/country/joined (e.g. now unranked,
// no join date recorded) must not null out the previously-known values.
players.upsertPlayerFromApiList(701, 'New From List', null, 42, 5000, null, null, 1, null);
const afterListOmitted = players.getPlayerFullById(701);
ok('upsertPlayerFromApiList preserves ranking/country/joined when the new payload omits them',
    afterListOmitted.ranking === 3 && afterListOmitted.country === 'US'
    && afterListOmitted.joined === '2026-08-01T00:00:00Z', afterListOmitted);

players.upsertPlayerFromApiDetail({
    id: 701, name: 'Detail Name', alliance_id: null, level: 50, points: 6000, ranking: 2,
    country: 'US', is_active_player: 1, joined: '2026-08-01T00:00:00Z', logins: 12,
    last_activity_at: '2026-08-29T10:00:00Z', last_login_at: '2026-08-29T09:00:00Z',
    resigned_at: null, number_of_battles: 4, battle_luckiness: 0.1, multi_status: 'clean',
    is_top_permanent_ranker: 0, has_supporter_badge: 1, supporter_type: 'gold',
    has_intel: 0, biology: 99, economy: 99, energy: 99, mathematics: 99, physics: 99, social: 99,
    trade_revenue: 99, artefact: 'fake',
    race_growth: 99, race_science: 99, race_culture: 99, race_production: 99, race_speed: 99,
    race_attack: 99, race_defense: 99, race_trader: 99, race_sul: 99,
});
const afterDetailNoIntel = players.getPlayerFullById(701);
ok('upsertPlayerFromApiDetail with has_intel=0 writes activity/status fields',
    afterDetailNoIntel.last_activity_at === '2026-08-29T10:00:00Z' && afterDetailNoIntel.number_of_battles === 4
    && afterDetailNoIntel.has_supporter_badge === 1 && afterDetailNoIntel.supporter_type === 'gold', afterDetailNoIntel);
ok('upsertPlayerFromApiDetail with has_intel=0 does NOT overwrite intel columns (still null/unset from before)',
    afterDetailNoIntel.biology !== 99, afterDetailNoIntel);

players.upsertPlayerFromApiDetail({
    id: 701, name: 'Detail Name 2', alliance_id: null, level: 51, points: 6100, ranking: 2,
    country: 'US', is_active_player: 1, joined: '2026-08-01T00:00:00Z', logins: 13,
    last_activity_at: '2026-08-29T11:00:00Z', last_login_at: '2026-08-29T10:00:00Z',
    resigned_at: null, number_of_battles: 5, battle_luckiness: 0.2, multi_status: 'clean',
    is_top_permanent_ranker: 0, has_supporter_badge: 1, supporter_type: 'gold',
    has_intel: 1, biology: 40, economy: 41, energy: 42, mathematics: 43, physics: 44, social: 45,
    trade_revenue: 46, artefact: 'real-artefact',
    race_growth: 1, race_science: 2, race_culture: 3, race_production: 4, race_speed: 5,
    race_attack: 6, race_defense: 7, race_trader: 8, race_sul: 9,
});
const afterDetailWithIntel = players.getPlayerFullById(701);
ok('upsertPlayerFromApiDetail with has_intel=1 DOES write intel columns',
    afterDetailWithIntel.biology === 40 && afterDetailWithIntel.race_attack === 6
    && afterDetailWithIntel.artefact === 'real-artefact', afterDetailWithIntel);

players.upsertPlayerBasic(702, 'Second Player', null);
players.upsertPlayerBasic(703, 'Third Player', null);
const stale = players.getStalePlayerIdsForApiScan(10);
ok('getStalePlayerIdsForApiScan returns players never scanned, in some order',
    stale.includes(701) && stale.includes(702) && stale.includes(703), stale);

players.markPlayersApiScanned([702, 703]);
// Finding 5b: the staleness floor means a player scanned within the last 6 hours is
// EXCLUDED from the queue entirely now, not merely ordered after — the sweep should go
// idle once everyone is fresh instead of burning budget re-scanning them forever.
const staleAfterMark = players.getStalePlayerIdsForApiScan(10);
ok('a player scanned less than 6 hours ago is excluded from the stale queue',
    !staleAfterMark.includes(702) && !staleAfterMark.includes(703), staleAfterMark);
ok('a never-scanned player is still included', staleAfterMark.includes(701), staleAfterMark);

db.prepare(`UPDATE players SET last_api_scan_at = datetime('now', '-7 hours') WHERE id = 702`).run();
const staleAfterBackdate = players.getStalePlayerIdsForApiScan(10);
ok('a player scanned more than 6 hours ago re-enters the stale queue',
    staleAfterBackdate.includes(702), staleAfterBackdate);
ok('a player scanned less than 6 hours ago still stays excluded',
    !staleAfterBackdate.includes(703), staleAfterBackdate);

// --- getPlayerApiScanStats: the Deep scan button's status line ---
// At this point: 701 has has_intel written but was never marked scanned (last_api_scan_at
// still NULL from upsertPlayerFromApiDetail, which never touches it — only
// markPlayersApiScanned does) -> stale. 702 was backdated to 7h ago -> stale again. 703 is
// still within the 6h fresh window -> not stale. Every OTHER player row created earlier in
// this suite also counts toward total, so this only asserts the stale count and the shape,
// not an exact total.
const scanStats = players.getPlayerApiScanStats();
ok('getPlayerApiScanStats returns a total at least as large as the rows just created',
    scanStats.total >= 3, scanStats);
ok('getPlayerApiScanStats stale count agrees with getStalePlayerIdsForApiScan for a large limit',
    scanStats.stale === players.getStalePlayerIdsForApiScan(100000).length, scanStats);
ok('getPlayerApiScanStats last_scan_at reflects the most recent markPlayersApiScanned call',
    scanStats.last_scan_at != null, scanStats);

// --- Finding 1: guarding upsertPlayerFromApiDetail against partial/malformed intel and
// enforcing race write-once. The route layer (sync.js) is what decides has_intel and
// normalizes race_* before calling the repo — these tests exercise the repo-level pieces
// (the CASE guard and the new getPlayerRaceValues helper) the same way that layer does.

// (a) A payload that arrives with has_intel already resolved to 0 — exactly what sync.js's
// hasCompleteIntel guard produces for an incomplete payload (e.g. missing race_growth) even
// though the raw API signal was truthy — must not overwrite ANY existing intel column.
players.upsertPlayerBasic(710, 'IntelGuard', null);
db.prepare(`UPDATE players SET biology = 55, race_growth = 3, has_intel = 1 WHERE id = 710`).run();
players.upsertPlayerFromApiDetail({
    id: 710, name: 'IntelGuard', alliance_id: null, level: 1, points: 0, ranking: null,
    country: null, is_active_player: 1, joined: null, logins: 0,
    last_activity_at: null, last_login_at: null, resigned_at: null,
    number_of_battles: 0, battle_luckiness: 0, multi_status: null,
    is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
    has_intel: 0, // forced 0 by the route guard for an incomplete payload
    biology: 999, economy: 999, energy: 999, mathematics: 999, physics: 999, social: 999,
    trade_revenue: 999, artefact: 'bogus',
    race_growth: null, race_science: 999, race_culture: 999, race_production: 999, race_speed: 999,
    race_attack: 999, race_defense: 999, race_trader: 999, race_sul: 999,
});
const afterGuarded = players.getPlayerFullById(710);
ok('has_intel:0 (as produced for an incomplete payload) preserves ALL existing intel columns, not just some',
    afterGuarded.biology === 55 && afterGuarded.race_growth === 3, afterGuarded);

// (b) A player who already has race values set keeps them even given a full, validly
// has_intel:1 payload with DIFFERENT race values — write-once enforced via
// getPlayerRaceValues, the way the route merges before calling the repo.
players.upsertPlayerBasic(711, 'RaceLock', null);
db.prepare(`
    UPDATE players SET race_growth=10, race_science=11, race_culture=12, race_production=13,
        race_speed=14, race_attack=15, race_defense=16, race_trader=17, race_sul=18, has_intel=1
    WHERE id = 711
`).run();
const existingRace = players.getPlayerRaceValues(711);
ok('getPlayerRaceValues reads back the stored race snapshot',
    existingRace && existingRace.race_growth === 10 && existingRace.race_sul === 18
    && existingRace.has_intel === 1, existingRace);

const raceLockDetail = {
    id: 711, name: 'RaceLock', alliance_id: null, level: 1, points: 0, ranking: null,
    country: null, is_active_player: 1, joined: null, logins: 0,
    last_activity_at: null, last_login_at: null, resigned_at: null,
    number_of_battles: 0, battle_luckiness: 0, multi_status: null,
    is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
    has_intel: 1,
    biology: 1, economy: 1, energy: 1, mathematics: 1, physics: 1, social: 1,
    trade_revenue: 1, artefact: null,
    race_growth: 99, race_science: 99, race_culture: 99, race_production: 99, race_speed: 99,
    race_attack: 99, race_defense: 99, race_trader: 99, race_sul: 99,
};
Object.assign(raceLockDetail, existingRace); // the route's write-once merge
players.upsertPlayerFromApiDetail(raceLockDetail);
const afterRaceLock = players.getPlayerFullById(711);
ok('write-once: a player with existing race values keeps the OLD ones given a new detail payload',
    afterRaceLock.race_growth === 10 && afterRaceLock.race_sul === 18 && afterRaceLock.biology === 1, afterRaceLock);

// (c) A player with NO race values yet gets the API's values written normally.
players.upsertPlayerBasic(712, 'FreshRace', null);
const noRace = players.getPlayerRaceValues(712);
// Race columns default to 0 (not NULL) for a fresh row — has_intel=0 is the real "no race
// on record yet" signal (see getPlayerRaceValues's comment).
ok('a player with no race on record yet has has_intel=0', noRace && noRace.has_intel === 0, noRace);
players.upsertPlayerFromApiDetail({
    id: 712, name: 'FreshRace', alliance_id: null, level: 1, points: 0, ranking: null,
    country: null, is_active_player: 1, joined: null, logins: 0,
    last_activity_at: null, last_login_at: null, resigned_at: null,
    number_of_battles: 0, battle_luckiness: 0, multi_status: null,
    is_top_permanent_ranker: 0, has_supporter_badge: 0, supporter_type: null,
    has_intel: 1,
    biology: 20, economy: 21, energy: 22, mathematics: 23, physics: 24, social: 25,
    trade_revenue: 26, artefact: null,
    race_growth: 1, race_science: 2, race_culture: 3, race_production: 4, race_speed: 5,
    race_attack: 6, race_defense: 7, race_trader: 8, race_sul: 9,
});
const afterFreshRace = players.getPlayerFullById(712);
ok('a player with no race on record gets the new race values written normally',
    afterFreshRace.race_growth === 1 && afterFreshRace.race_sul === 9 && afterFreshRace.biology === 20, afterFreshRace);

// ── getPendingNewPlayerAnnouncements / markNewPlayerAnnounced: new-player Discord queue ──
// announced_new_player defaults to 0 on INSERT and is never touched by upsertPlayerFromApiList's
// ON CONFLICT UPDATE, so a genuinely new row queues up while a re-synced existing row does not.
db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (3, 'NEW', 'Newcomers')`).run();

players.upsertPlayerFromApiList(801, 'Freshface', 3, 1, 0, null, 'US', 1, '2026-08-31T10:00:08.0083294+02:00');
players.upsertPlayerFromApiList(802, 'NoJoinDate', null, 1, 0, null, 'US', 1, null);

const pendingAfterFirstSync = players.getPendingNewPlayerAnnouncements();
ok('a freshly-inserted player with a joined date is queued for announcement',
    pendingAfterFirstSync.some(r => r.id === 801), pendingAfterFirstSync);
ok('a freshly-inserted player with no joined date is NOT queued (nothing to announce)',
    !pendingAfterFirstSync.some(r => r.id === 802), pendingAfterFirstSync);
ok('the queued row carries its alliance tag via the join', pendingAfterFirstSync.find(r => r.id === 801).alliance_tag === 'NEW');

players.markNewPlayerAnnounced(801);
ok('markNewPlayerAnnounced removes the player from the pending queue',
    !players.getPendingNewPlayerAnnouncements().some(r => r.id === 801), players.getPendingNewPlayerAnnouncements());

// A re-sync of the SAME player (e.g. next ListPlayer pull) must not re-queue them —
// announced_new_player is intentionally absent from the ON CONFLICT UPDATE SET clause.
players.upsertPlayerFromApiList(801, 'Freshface', 3, 2, 100, 5, 'US', 1, '2026-08-31T10:00:08.0083294+02:00');
ok('re-syncing an already-announced player does not re-queue them',
    !players.getPendingNewPlayerAnnouncements().some(r => r.id === 801), players.getPendingNewPlayerAnnouncements());

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
