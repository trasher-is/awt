// Coverage for the non-linear "dynamic points" system in battlePoints.js — the successor
// to the flat getCvRatio()/getPopRatio() leaderboards, where a bigger single kill is worth
// disproportionately more per unit. Split out of battlePoints.test.js (which already
// covers the flat system's exclusion/scope logic thoroughly) to keep each file focused.
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

console.log('\n── popDynamicPoints: fixed-width band staircase (default width 9) ' + '─'.repeat(6));
ok('defaults: pop band width is 9', battlePoints.getPopBandWidth() === 9);
ok('0 or negative pop scores 0', battlePoints.popDynamicPoints(0) === 0 && battlePoints.popDynamicPoints(-5) === 0);
ok('pop=1 is band 1 (rate 1): 1 point', battlePoints.popDynamicPoints(1) === 1);
ok('pop=9 stays fully in band 1 (rate 1): 9 points', battlePoints.popDynamicPoints(9) === 9);
ok('pop=10 spills 1 unit into band 2 (rate 2): 9 + 1*2 = 11', battlePoints.popDynamicPoints(10) === 11);
ok('pop=13: 9*1 + 4*2 = 17', battlePoints.popDynamicPoints(13) === 17);
ok('pop=18 fills band 2 exactly: 9*1 + 9*2 = 27', battlePoints.popDynamicPoints(18) === 27);
ok('pop=20: 9*1 + 9*2 + 2*3 = 33 (the CV/pop calibration anchor value)', battlePoints.popDynamicPoints(20) === 33);
ok('pop=24: 9*1 + 9*2 + 6*3 = 45', battlePoints.popDynamicPoints(24) === 45);

settingsRepo.setSetting('battle_points_pop_band_width', '5');
ok('band width is admin-tunable via settings (width=5 changes the curve)',
    battlePoints.getPopBandWidth() === 5 && battlePoints.popDynamicPoints(6) === 5 + 2);
settingsRepo.setSetting('battle_points_pop_band_width', '9'); // restore default for the rest of this file

console.log('\n── cvDynamicPoints: k*cv^exponent, calibrated off the pop curve ' + '─'.repeat(6));
ok('defaults: exponent 1.5, anchor 20 pop <-> 5000 CV', battlePoints.getCvExponent() === 1.5
    && battlePoints.getCvAnchorCv() === 5000 && battlePoints.getCvAnchorPop() === 20);
ok('0 or negative CV scores 0', battlePoints.cvDynamicPoints(0) === 0 && battlePoints.cvDynamicPoints(-100) === 0);

const anchorPopPoints = battlePoints.popDynamicPoints(20);
ok('the calibration anchor holds exactly: cvDynamicPoints(5000) === popDynamicPoints(20)',
    close(battlePoints.cvDynamicPoints(5000), anchorPopPoints, 0.001), battlePoints.cvDynamicPoints(5000));

ok('a routine early-game kill (300 CV) scores well under 1 raw point (pre-display-scale)',
    battlePoints.cvDynamicPoints(300) < 1 && battlePoints.cvDynamicPoints(300) > 0, battlePoints.cvDynamicPoints(300));
ok('a rare late-game kill (100,000 CV) scores roughly 6,000x a 300 CV skirmish (aggressive curve)',
    close(battlePoints.cvDynamicPoints(100000) / battlePoints.cvDynamicPoints(300), 6080, 0.1),
    battlePoints.cvDynamicPoints(100000) / battlePoints.cvDynamicPoints(300));
ok('per-CV rate genuinely grows with kill size (superlinear, not flat)',
    (battlePoints.cvDynamicPoints(50000) / 50000) > (battlePoints.cvDynamicPoints(300) / 300) * 5);

console.log('\n── getDynamicLeaderboard: per-event curve, summed per player, display-scaled ' + '─'.repeat(2));

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
    killed_population: 9,
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
const expectedPopPointsRaw = battlePoints.popDynamicPoints(9) + battlePoints.popDynamicPoints(20);
const scale = battlePoints.getDisplayScale();
ok('cv_points is the SUM of each event\'s OWN curve applied separately, not curve(sum) — proves per-event evaluation',
    close(wren.cv_points, Math.round(expectedCvPointsRaw * scale * 10) / 10, 0.02), wren);
ok('pop_points likewise sums each event\'s own curve', close(wren.pop_points, Math.round(expectedPopPointsRaw * scale * 10) / 10, 0.02), wren);
ok('points is cv_points + pop_points, both already display-scaled',
    close(wren.points, wren.cv_points + wren.pop_points, 0.01), wren);
ok('the 50,000 CV kill alone dwarfs the two population kills combined — reflects the curve\'s design intent',
    wren.cv_points > wren.pop_points * 10, wren);

ok('Xoc (the loser both times, never credited) does not appear on the combined leaderboard',
    !board.some(r => r.player_name === 'Xoc'), board);

console.log('\n── display scale is a pure multiplier, not a shape change ' + '─'.repeat(10));
settingsRepo.setSetting('battle_points_display_scale', '1');
const unscaledBoard = battlePoints.getDynamicLeaderboard(null, 10, 'all');
const wrenUnscaled = unscaledBoard.find(r => r.player_name === 'Wren');
ok('display scale 1 vs 20 changes the absolute number by exactly that factor, not the ratio between cv/pop',
    close(wren.points / wrenUnscaled.points, scale, 0.02)
    && close(wren.cv_points / wren.pop_points, wrenUnscaled.cv_points / wrenUnscaled.pop_points, 0.02),
    { scaled: wren, unscaled: wrenUnscaled });
settingsRepo.setSetting('battle_points_display_scale', '20'); // restore default

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

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
