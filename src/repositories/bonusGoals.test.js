// Coverage for the generic bonus-goals engine (Phase 1: the 'ranking_match' goal type) —
// see database.js's bonus_goals comment and bonusGoals.js's own header for the design.
//
// Run with: node src/repositories/bonusGoals.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const settingsRepo = require('./settings');
const bonusGoals = require('./bonusGoals');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('bonusGoals.test.js');

console.log('\n── access token: generated once, persisted ' + '─'.repeat(20));
const token1 = bonusGoals.getOrCreateAccessToken();
ok('a token is generated on first use', typeof token1 === 'string' && token1.length === 64, token1);
const token2 = bonusGoals.getOrCreateAccessToken();
ok('the SAME token is returned on a second call (persisted, not regenerated)', token1 === token2);
ok('the token is actually stored in settings, not just held in memory',
    settingsRepo.getSetting('bonus_goals_access_token').value === token1);

console.log('\n── goal CRUD ' + '─'.repeat(50));
ok('listGoals starts empty', bonusGoals.listGoals().length === 0);

const created = bonusGoals.createGoal({
    type: 'ranking_match', name: 'test goal',
    config: { ranking_path: '/Ranking/Fake', tier_size: 5, tier_start_points: 100, tier_step: -5, max_rank: 50 },
    enabled: false,
});
ok('createGoal returns the new row with its id', Number.isInteger(created.id), created);
ok('createGoal parses config back out as an object, not a JSON string', created.config.tier_size === 5, created);
ok('enabled defaults/coerces to a real boolean', created.enabled === false, created);

const fetched = bonusGoals.getGoal(created.id);
ok('getGoal round-trips the same row', fetched.name === 'test goal' && fetched.config.max_rank === 50, fetched);

const updated = bonusGoals.updateGoal(created.id, { enabled: true });
ok('updateGoal can flip just `enabled` without touching name/config', updated.enabled === true
    && updated.name === 'test goal' && updated.config.tier_size === 5, updated);

ok('updateGoal on a nonexistent id returns null, not a crash', bonusGoals.updateGoal(999999, { enabled: true }) === null);

const deleteResult = bonusGoals.deleteGoal(created.id);
ok('deleteGoal reports success', deleteResult === true);
ok('the deleted goal is really gone', bonusGoals.getGoal(created.id) === null);
ok('deleteGoal on an already-gone id reports false, not a crash', bonusGoals.deleteGoal(created.id) === false);

console.log('\n── computeRankPoints: the tier table ' + '─'.repeat(28));
const tiers = { tier_size: 5, tier_start_points: 100, tier_step: -5, max_rank: 50 };
ok('rank 1 (top of tier 1) scores 100', bonusGoals.computeRankPoints(tiers, 1) === 100);
ok('rank 5 (bottom of tier 1) still scores 100', bonusGoals.computeRankPoints(tiers, 5) === 100);
ok('rank 6 (top of tier 2) scores 95', bonusGoals.computeRankPoints(tiers, 6) === 95);
ok('rank 10 (bottom of tier 2) still scores 95', bonusGoals.computeRankPoints(tiers, 10) === 95);
ok('rank 11 (tier 3) scores 90', bonusGoals.computeRankPoints(tiers, 11) === 90);
ok('rank 46 (tier 10, the bottom band) scores 55', bonusGoals.computeRankPoints(tiers, 46) === 55);
ok('rank 50 (bottom of tier 10) still scores 55', bonusGoals.computeRankPoints(tiers, 50) === 55);
ok('rank 51 (past max_rank) scores 0', bonusGoals.computeRankPoints(tiers, 51) === 0);
ok('rank 0 or negative scores 0', bonusGoals.computeRankPoints(tiers, 0) === 0 && bonusGoals.computeRankPoints(tiers, -3) === 0);

console.log('\n── ranking snapshot: replace + resolve via game_planet_id ' + '─'.repeat(10));
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (500, 'Bonus Test System', 1, 1)`).run();
db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, name)
    VALUES (77001, 500, 3, 'ResolvedPlanet')
`).run();

const goal = bonusGoals.createGoal({ type: 'ranking_match', name: 'snapshot goal', config: tiers, enabled: true });
bonusGoals.replaceRankingSnapshot(goal.id, [
    { rank: 1, game_planet_id: 77001, owner_name: 'SomeOwner', owner_alliance_tag: 'TAG' },
    { rank: 2, game_planet_id: 999999, owner_name: 'NeverScanned', owner_alliance_tag: null }, // no matching planets row
]);

const snap1 = db.prepare(`SELECT * FROM ranking_snapshot_rows WHERE goal_id = ? AND rank = 1`).get(goal.id);
ok('a game_planet_id that matches a scanned planet resolves system_id/planet_index',
    snap1.system_id === 500 && snap1.planet_index === 3, snap1);
const snap2 = db.prepare(`SELECT * FROM ranking_snapshot_rows WHERE goal_id = ? AND rank = 2`).get(goal.id);
ok('a game_planet_id with no matching planets row stays unresolved (NULL), not an error',
    snap2.system_id === null && snap2.planet_index === null, snap2);

bonusGoals.replaceRankingSnapshot(goal.id, [{ rank: 1, game_planet_id: 77001 }]);
const afterReplace = db.prepare(`SELECT COUNT(*) AS n FROM ranking_snapshot_rows WHERE goal_id = ?`).get(goal.id);
ok('a re-scrape REPLACES the old snapshot wholesale, not merges (2 rows -> 1 row)', afterReplace.n === 1, afterReplace);

console.log('\n── getStaleRankingGoals: who needs a re-scrape ' + '─'.repeat(18));
const stale = bonusGoals.getStaleRankingGoals(20);
ok('a goal with a snapshot from moments ago is NOT stale', !stale.some(g => g.goal_id === goal.id), stale);

const neverScraped = bonusGoals.createGoal({ type: 'ranking_match', name: 'never scraped', config: tiers, enabled: true });
const staleAfterNew = bonusGoals.getStaleRankingGoals(20);
ok('a goal with NO snapshot at all IS stale', staleAfterNew.some(g => g.goal_id === neverScraped.id), staleAfterNew);

const disabled = bonusGoals.createGoal({ type: 'ranking_match', name: 'disabled goal', config: tiers, enabled: false });
const staleAfterDisabled = bonusGoals.getStaleRankingGoals(20);
ok('a DISABLED goal never counts as stale, even with no snapshot', !staleAfterDisabled.some(g => g.goal_id === disabled.id), staleAfterDisabled);

console.log('\n── evaluateBattleReportForGoals: crediting a hit on a ranked planet ' + '─'.repeat(4));
db.prepare(`INSERT INTO players (id, name) VALUES (700, 'Raider700')`).run();
db.prepare(`
    INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_id, att_player_name, def_lost_cv, killed_population)
    VALUES (88001, '2026-09-11T10:00:00Z', 500, 3, 700, 'Raider700', 250, 5)
`).run();

const awarded = bonusGoals.evaluateBattleReportForGoals(88001);
ok('a real hit on the #1-ranked planet awards the tier-1 points (100)',
    awarded.length === 1 && awarded[0].points === 100, awarded);

const awardRow = db.prepare(`SELECT * FROM bonus_goal_awards WHERE goal_id = ? AND source_key = ?`).get(goal.id, 'br:88001');
ok('the award row is credited to the attacker', awardRow && awardRow.player_id === 700 && awardRow.points === 100, awardRow);

const secondEval = bonusGoals.evaluateBattleReportForGoals(88001);
ok('re-evaluating the SAME report a second time awards nothing new (deduped by source_key)', secondEval.length === 0, secondEval);

db.prepare(`
    INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_id, att_player_name, def_lost_cv, killed_population)
    VALUES (88002, '2026-09-11T11:00:00Z', 500, 3, 700, 'Raider700', 0, 0)
`).run();
const noOpEval = bonusGoals.evaluateBattleReportForGoals(88002);
ok('a report with no CV lost and no population killed (a probe/no-op) awards nothing',
    noOpEval.length === 0, noOpEval);

db.prepare(`
    INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_id, att_player_name, def_lost_cv, killed_population)
    VALUES (88003, '2026-09-11T12:00:00Z', 600, 9, 700, 'Raider700', 500, 10)
`).run();
const unrankedEval = bonusGoals.evaluateBattleReportForGoals(88003);
ok('a real hit on a planet NOT in any active ranking snapshot awards nothing', unrankedEval.length === 0, unrankedEval);

const noLocationEval = bonusGoals.evaluateBattleReportForGoals(999999);
ok('evaluating a nonexistent report id is a no-op, not a crash', Array.isArray(noLocationEval) && noLocationEval.length === 0);

console.log('\n── getAwardedPointsByPlayer: scoped the same way as the rest of the leaderboard ' + '─'.repeat(2));
const byPlayerAll = bonusGoals.getAwardedPointsByPlayer(null, 'all');
ok('scope=all sees Raider700\'s bonus points with no membership filter', byPlayerAll.get(700)?.bonus_points === 100, byPlayerAll);

const byPlayerMembers = bonusGoals.getAwardedPointsByPlayer(null, 'members');
ok('default scope (members) excludes Raider700 — never linked to an app_users account',
    !byPlayerMembers.has(700), byPlayerMembers);

db.prepare(`INSERT INTO app_users (id, game_name, password_hash) VALUES (950, 'Raider700', 'x')`).run();
const byPlayerMembersLinked = bonusGoals.getAwardedPointsByPlayer(null, 'members');
ok('once linked to a hub account, Raider700 IS included under scope=members',
    byPlayerMembersLinked.get(700)?.bonus_points === 100, byPlayerMembersLinked);

const byPlayerSinceFuture = bonusGoals.getAwardedPointsByPlayer('2099-01-01T00:00:00Z', 'all');
ok('a future "since" window excludes an award that already happened', !byPlayerSinceFuture.has(700), byPlayerSinceFuture);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
