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

players.upsertPlayerFromApiList(701, 'New From List', null, 42, 5000, 3, 'US', 1, '2026-08-01T00:00:00Z');
const afterList = players.getPlayerFullById(701);
ok('upsertPlayerFromApiList updates name/level/points/ranking/country/is_active_player/joined',
    afterList.name === 'New From List' && afterList.level === 42 && afterList.points === 5000
    && afterList.ranking === 3 && afterList.country === 'US' && afterList.is_active_player === 1
    && afterList.joined === '2026-08-01T00:00:00Z', afterList);
ok('upsertPlayerFromApiList does not touch home_planet_id (never in its column list)', afterList.home_planet_id === null, afterList);

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
const staleAfterMark = players.getStalePlayerIdsForApiScan(1);
ok('markPlayersApiScanned makes those ids less stale than 701 (never scanned)',
    staleAfterMark[0] === 701, staleAfterMark);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
