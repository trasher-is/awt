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

players.resetPlayerOnRestart(1);
const afterReset = db.prepare(`SELECT points, biology FROM players WHERE id = ?`).get(1);
ok('resetPlayerOnRestart zeroes stats', afterReset.points === 0 && afterReset.biology === 0);

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

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
