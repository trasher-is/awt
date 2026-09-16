// Coverage for the non-linear "dynamic points" system in battlePoints.js — the successor
// to the flat getCvRatio()/getPopRatio() leaderboards, where a bigger single kill is worth
// disproportionately more per unit. Split out of battlePoints.test.js (which already
// covers the flat system's exclusion/scope logic thoroughly) to keep each file focused.
//
// 2026-09-16d: rewritten for the tiered redesign. The original version tested a marginal
// pop staircase and a smooth k*cv^exponent CV curve; both are gone. See the module's own
// header comment in battlePoints.js for why (a live incident found the CV curve's small
// kills rounding to near-zero, and the fix wasn't another scale tweak — it was replacing
// the shape of both curves against exact numbers the user worked out by hand).
//
// Run with: node src/repositories/battlePoints-dynamic.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const settingsRepo = require('./settings');
const battlePoints = require('./battlePoints');
const bonusGoals = require('./bonusGoals');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}
function close(a, b, tolerance = 0.05) {
    return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b), 1);
}

console.log('battlePoints-dynamic.test.js');

console.log('\n── popDynamicPoints: FLAT rate per tier, not marginal ' + '─'.repeat(19));
// The exact worked examples from the live conversation that specified this curve. Flat, not
// marginal/staircase: the WHOLE kill is charged at the rate of the tier it falls in, unlike
// the old system.
ok('defaults: tier 0 is width 4, later tiers are width 5, step 0.25/tier',
    battlePoints.getPopTier0Width() === 4 && battlePoints.getPopTierWidth() === 5
    && battlePoints.getPopTierStep() === 0.25);
ok('0 or negative pop scores 0', battlePoints.popDynamicPoints(0) === 0 && battlePoints.popDynamicPoints(-5) === 0);
ok('pop=1 (tier 0, rate 1.0): 1 point', battlePoints.popDynamicPoints(1) === 1);
ok('pop=4 (tier 0 top, rate 1.0): 4*1.0 = 4 points — the user\'s own example',
    battlePoints.popDynamicPoints(4) === 4);
ok('pop=5 (tier 1 starts, rate 1.25): 5*1.25 = 6.25 — FLAT, not 4 + 1*1.25',
    battlePoints.popDynamicPoints(5) === 6.25);
ok('pop=8 (tier 1, rate 1.25): 8*1.25 = 10 — the user\'s own example',
    battlePoints.popDynamicPoints(8) === 10);
ok('pop=9 (tier 1 top, rate 1.25): 9*1.25 = 11.25', battlePoints.popDynamicPoints(9) === 11.25);
ok('pop=13 (tier 2, rate 1.5): 13*1.5 = 19.5 — the user\'s own example',
    battlePoints.popDynamicPoints(13) === 19.5);
ok('pop=19 (tier 3, rate 1.75): 19*1.75 = 33.25 — the user\'s own example, and the exact\n' +
    '     value a round-to-1-decimal bug would have misreported as 33.3',
    battlePoints.popDynamicPoints(19) === 33.25);
ok('pop=20 (tier 4 starts, rate 2.0): 20*2.0 = 40', battlePoints.popDynamicPoints(20) === 40);
ok('a tier boundary crossing a FLAT system is a real jump, not a smooth transition\n' +
    '     (pop=24 at rate 2.0 vs pop=25 at rate 2.25 — this is the accepted shape, not a bug)',
    battlePoints.popDynamicPoints(24) === 48 && battlePoints.popDynamicPoints(25) === 56.25);

settingsRepo.setSetting('battle_points_pop_tier0_width', '2');
ok('tier 0 width is admin-tunable (narrower tier 0 changes where the first jump lands)',
    battlePoints.getPopTier0Width() === 2 && battlePoints.popDynamicPoints(2) === 2 && battlePoints.popDynamicPoints(3) === 3.75);
settingsRepo.setSetting('battle_points_pop_tier0_width', '4'); // restore default

console.log('\n── cvDynamicPoints: FLAT rate per tier, reverse-engineered from 8 examples ' + '─'.repeat(2));
// Every one of these is the user's own number, not an invented target. A single smooth
// power curve (the previous design) could NOT fit these — checked by log-log regression,
// which missed the 200,000 CV example by ~40%. The tiered table hits 6 of 8 exactly and
// the other 2 within a point.
ok('cv=100 -> 1 (exact)', battlePoints.cvDynamicPoints(100) === 1);
ok('cv=1000 -> 15 (exact)', battlePoints.cvDynamicPoints(1000) === 15);
ok('cv=5000 -> 100 (exact)', battlePoints.cvDynamicPoints(5000) === 100);
ok('cv=10000 -> 300 (exact)', battlePoints.cvDynamicPoints(10000) === 300);
ok('cv=50000 -> 2000 (exact)', battlePoints.cvDynamicPoints(50000) === 2000);
ok('cv=100000 -> within 1 of 5555', close(battlePoints.cvDynamicPoints(100000), 5555, 0.001), battlePoints.cvDynamicPoints(100000));
ok('cv=150000 -> within 1 of 13333', close(battlePoints.cvDynamicPoints(150000), 13333, 0.001), battlePoints.cvDynamicPoints(150000));
ok('cv=200000 -> 30000 (exact)', battlePoints.cvDynamicPoints(200000) === 30000);
ok('0 or negative CV scores 0', battlePoints.cvDynamicPoints(0) === 0 && battlePoints.cvDynamicPoints(-100) === 0);

// The one example that does NOT fit, by construction, and why: the user's cv=3 -> 0.05
// example implies a rate (0.0167) HIGHER than the rate at cv=100 (0.01). A flat-per-tier
// system cannot have a lower tier score at a higher rate than a higher tier without
// creating a point where killing LESS scores MORE (cv=99 would outscore cv=100) — so this
// one anchor was treated as illustrative, not load-bearing, and the curve is monotonic
// instead. Documented as a test so a future "fix" doesn't reintroduce the inversion trying
// to chase that one number.
console.log('\n── The curve is monotonic, even where one of the original examples wasn\'t ' + '─'.repeat(2));
ok('cv=3 lands at 0.03, not the example\'s 0.05 — the honest, monotonic answer',
    battlePoints.cvDynamicPoints(3) === 0.03, battlePoints.cvDynamicPoints(3));
{
    let prevPoints = -1;
    let brokeAt = null;
    for (let cv = 1; cv <= 250000; cv += 137) { // odd step so it isn't only ever landing on tier boundaries
        const pts = battlePoints.cvDynamicPoints(cv);
        if (pts < prevPoints) { brokeAt = cv; break; }
        prevPoints = pts;
    }
    ok('points never decrease as CV increases, anywhere across the whole range', brokeAt === null, brokeAt);
}

console.log('\n── Admin-tunable CV tier table ' + '─'.repeat(43));
{
    const custom = JSON.stringify([{ max: 999, rate: 0.02 }, { max: null, rate: 0.1 }]);
    settingsRepo.setSetting('battle_points_cv_tiers', custom);
    ok('a valid custom tier table overrides the built-in one', battlePoints.cvDynamicPoints(500) === 10);
    ok('and the top (unbounded) tier still applies past its last explicit boundary',
        battlePoints.cvDynamicPoints(50000) === 5000);

    settingsRepo.setSetting('battle_points_cv_tiers', 'not json at all');
    ok('malformed JSON falls back to the built-in table rather than throwing',
        battlePoints.cvDynamicPoints(100) === 1);

    settingsRepo.setSetting('battle_points_cv_tiers', JSON.stringify([{ max: 100 }])); // missing rate
    ok('a structurally invalid table (missing rate) also falls back safely',
        battlePoints.cvDynamicPoints(100) === 1);

    settingsRepo.setSetting('battle_points_cv_tiers', JSON.stringify([]));
    ok('an empty table falls back too — an admin typo must not zero out every CV score',
        battlePoints.cvDynamicPoints(100) === 1);

    db.prepare(`DELETE FROM app_settings WHERE key = 'battle_points_cv_tiers'`).run(); // restore default
    ok('with the setting cleared entirely, the built-in table is back',
        battlePoints.cvDynamicPoints(100) === 1);
}

console.log('\n── getDynamicLeaderboard: per-event curve, summed per player, no display scale ' + '─'.repeat(1));

const insert = db.prepare(`
    INSERT INTO battle_reports (
        id, started_at, att_player_id, att_player_name, att_alliance_tag, att_lost_cv,
        def_player_id, def_player_name, def_alliance_tag, def_lost_cv, killed_population
    ) VALUES (
        @id, @started_at, @att_player_id, @att_player_name, @att_alliance_tag, @att_lost_cv,
        @def_player_id, @def_player_name, @def_alliance_tag, @def_lost_cv, @killed_population
    )
`);

// Wren (attacker) beats Xoc twice: one small skirmish, one huge kill, both clean (Xoc
// loses everything, Wren loses nothing — att_lost_cv: 0 — so Xoc earns no CV credit of
// its own and stays off the leaderboard entirely, same convention as getCvLeaderboard's
// own tests). Credited via def_lost_cv (the defender's loss is the attacker's CV credit).
// killed_population also credits the attacker (Wren) each time.
insert.run({
    id: 1, started_at: '2026-09-01T00:00:00Z',
    att_player_id: 1, att_player_name: 'Wren', att_alliance_tag: 'RAID', att_lost_cv: 0,
    def_player_id: 2, def_player_name: 'Xoc', def_alliance_tag: 'ENEMY', def_lost_cv: 300,
    killed_population: 8,
});
insert.run({
    id: 2, started_at: '2026-09-02T00:00:00Z',
    att_player_id: 1, att_player_name: 'Wren', att_alliance_tag: 'RAID', att_lost_cv: 0,
    def_player_id: 2, def_player_name: 'Xoc', def_alliance_tag: 'ENEMY', def_lost_cv: 50000,
    killed_population: 20,
});

const board = battlePoints.getDynamicLeaderboard(null, 10, 'all');
const wren = board.find(r => r.player_name === 'Wren');
ok('Wren appears on the combined leaderboard', !!wren, board);

const expectedCvPointsRaw = battlePoints.cvDynamicPoints(300) + battlePoints.cvDynamicPoints(50000);
const expectedPopPointsRaw = battlePoints.popDynamicPoints(8) + battlePoints.popDynamicPoints(20);
ok('cv_points is the SUM of each event\'s OWN curve applied separately, not curve(sum) — proves per-event evaluation',
    close(wren.cv_points, expectedCvPointsRaw, 0.02), wren);
ok('pop_points likewise sums each event\'s own curve', close(wren.pop_points, expectedPopPointsRaw, 0.02), wren);
ok('points is cv_points + pop_points, with no hidden multiplier applied on top',
    close(wren.points, wren.cv_points + wren.pop_points, 0.01), wren);
ok('the 50,000 CV kill alone dwarfs the two population kills combined — reflects the curve\'s design intent',
    wren.cv_points > wren.pop_points * 10, wren);

ok('Xoc (the loser both times, never credited) does not appear on the combined leaderboard',
    !board.some(r => r.player_name === 'Xoc'), board);

console.log('\n── bonus-goal awards fold into the same leaderboard ' + '─'.repeat(19));
// Wren also earned a bonus-goal award (e.g. a ranking_match hit — see bonusGoals.test.js
// for that engine's own coverage; here it's just a plain row, the mechanism that produced
// it doesn't matter to getDynamicLeaderboard).
const bonusTestGoal = bonusGoals.createGoal({ type: 'ranking_match', name: 'bonus test', config: {}, enabled: true });
db.prepare(`
    INSERT INTO bonus_goal_awards (goal_id, player_id, player_name, points, source_key)
    VALUES (?, 1, 'Wren', 250, 'test:1')
`).run(bonusTestGoal.id);

const boardWithBonus = battlePoints.getDynamicLeaderboard(null, 10, 'all');
const wrenWithBonus = boardWithBonus.find(r => r.player_name === 'Wren');
ok('bonus_points reflects the awarded row (250)', wrenWithBonus.bonus_points === 250, wrenWithBonus);
ok('points is cv_points + pop_points + bonus_points, all three added together',
    close(wrenWithBonus.points, wrenWithBonus.cv_points + wrenWithBonus.pop_points + wrenWithBonus.bonus_points, 0.01),
    wrenWithBonus);
ok('the combined total actually grew relative to before the bonus award existed',
    wrenWithBonus.points > wren.points, { before: wren.points, after: wrenWithBonus.points });

db.prepare(`INSERT INTO players (id, name) VALUES (99, 'BonusOnly')`).run();
db.prepare(`
    INSERT INTO bonus_goal_awards (goal_id, player_id, player_name, points, source_key)
    VALUES (?, 99, 'BonusOnly', 42, 'test:2')
`).run(bonusTestGoal.id);
const boardWithBonusOnly = battlePoints.getDynamicLeaderboard(null, 10, 'all');
const bonusOnlyRow = boardWithBonusOnly.find(r => r.player_name === 'BonusOnly');
ok('a player with ONLY a bonus award (no CV/pop credit at all) still appears on the leaderboard',
    !!bonusOnlyRow && bonusOnlyRow.points === 42 && bonusOnlyRow.cv_points === 0 && bonusOnlyRow.pop_points === 0,
    bonusOnlyRow);

console.log('\n── The actual incident: Moardin killed 3 population, one clean event ' + '─'.repeat(6));
{
    db.prepare(`INSERT INTO players (id, name) VALUES (19, 'Moardin25')`).run();
    insert.run({
        id: 3, started_at: '2026-09-16T03:38:00Z',
        att_player_id: 19, att_player_name: 'Moardin25', att_alliance_tag: 'RAID', att_lost_cv: 64,
        def_player_id: 20, def_player_name: 'Starius', def_alliance_tag: 'FREE', def_lost_cv: 64,
        killed_population: 3,
    });
    const withMoardin = battlePoints.getDynamicLeaderboard(null, 10, 'all');
    const moardin = withMoardin.find(r => r.player_name === 'Moardin25');
    ok('3 population now scores exactly 3 points — the number that started this whole redesign',
        moardin.pop_points === 3, moardin);
}

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
