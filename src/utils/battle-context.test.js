const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-battle-context-'));
process.env.AWT_DB_PATH = path.join(dir, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-context-password';
const db = require('../database');
const context = require('./battle-context');
let failed = 0;
function ok(name, condition, detail) {
    console.log(`${condition ? 'ok' : 'NOT OK'} - ${name}`);
    if (!condition) { failed++; if (detail !== undefined) console.error(JSON.stringify(detail)); }
}
try {
    const won = { random_number: 50, att_win_chance: 50, att_has_won: 1 };
    ok('50/50 is consistent under the provisional inclusive comparator', context.diceCheck(won).dice_consistent === 1);
    ok('equality remains marked provisional until verified against stored observations',
        context.diceCheck(won).dice_reason === 'consistent_equality_provisional');
    ok('85/87 correctly records an attacker loss', context.diceCheck({ random_number: 87, att_win_chance: 85, att_has_won: 0 }).dice_consistent === 1);
    ok('a contradictory winner is flagged', context.diceCheck({ ...won, random_number: 87 }).dice_consistent === 0);
    ok('fractional percentage dice are not heuristically rescaled', context.diceCheck({ ...won, random_number: 0.5 }).dice_roll === 0.5);
    ok('legacy win_chance is never read as real probability', context.diceCheck({ random_number: 10, win_chance: 90, att_has_won: 1 }).dice_consistent === null);
    ok('null and false are missing, never percentage zero', context.percent(null) === null && context.percent(false) === null);
    ok('an actual probability zero stays zero', context.percent(0) === 0);
    ok('out-of-range probability is rejected', context.percent(101) === null && context.percent(-1) === null);
    const joined = { joined: '2026-09-02', battle_race_not_before: '2026-09-03 01:00:00' };
    ok('latest resign boundary wins', context.evidenceStart(joined) === '2026-09-03T01:00:00.000Z');
    ok('ambiguous localized dates are not guessed', context.evidenceStart({ joined: '03/09/2026' }) === null);
    ok('invalid day and hour are rejected', context.time('2026-02-30') === null && context.time('2026-09-03 24:00:00') === null);

    const subject = { id: 7001, level: 30, science_level: 30, joined: '2026-09-01' };
    context.recordPublicContext(db, { ...subject, level: 8, science_level: 7 }, '2026-09-05T11:00:00Z');
    context.recordPublicContext(db, { ...subject, level: 12, science_level: 11 }, '2026-09-05T13:00:00Z');
    context.recordPublicContext(db, { ...subject, level: 16, science_level: 15 }, '2026-09-05T15:00:00Z');
    const report = { id: 8001, att_player_id: 7001, def_player_id: 7002, started_at: '2026-09-05T12:00:00Z', att_level_gained: 2 };
    const bounds = context.contextCeilings(db, subject, [report])[8001];
    ok('nearest later observation caps sciences; earlier lower bound is not used', bounds.science_level === 11, bounds);
    ok('known levels gained are removed from the post-battle ceiling', bounds.level === 10, bounds);
    ok('the context keeps observation age and upper-bound provenance', bounds.age_hours === 1 && bounds.source === 'dated_public_upper_bound');
    const restart = { ...subject, joined: '2026-09-06' };
    ok('before-resign report receives no historical context', !context.contextCeilings(db, restart, [report])[8001]);
    const noHistory = { ...subject, id: 7999 };
    ok('unknown historical context stays absent', Object.keys(context.contextCeilings(db, noHistory, [report])).length === 0);
    const tooOld = { ...report, started_at: '2026-09-02T12:00:00Z' };
    ok('a public observation more than48hours after battle is not used', !context.contextCeilings(db, subject, [tooOld])[8001]);
    context.recordPublicContext(db, { id: 7998, level: null, science_level: null });
    ok('missing public values produce no fabricated zero observation', db.prepare('SELECT COUNT(*) n FROM player_public_history WHERE player_id=7998').get().n === 0);
    context.recordStarbaseContext(db, 701, 1, 0, '2026-09-05T12:00:00Z');
    ok('observed empty starbase is preserved as real zero', db.prepare('SELECT level FROM planet_starbase_history').get().level === 0);

    db.prepare(`INSERT INTO battle_reports(id,started_at,random_number,att_win_chance,att_has_won)
        VALUES(8001,'2026-09-05T12:00:00Z',87,85,0)`).run();
    context.refreshDiceChecks(db, [8001, 8001, 8888]);
    const stored = db.prepare('SELECT dice_roll,dice_consistent,dice_reason FROM battle_reports WHERE id=8001').get();
    ok('dice validation is persisted once and tolerates unknown report ids', stored.dice_roll === 87 && stored.dice_consistent === 1);
    const summary = context.measureContext(db);
    ok('read-only diagnostics produce aggregate counts only', summary.consistent === 1 && !/7001|8001|2026/.test(JSON.stringify(summary)), summary);

    const known = { id: 7101, has_intel: 1, race_attack: 0, race_defense: 0, physics: 0, mathematics: 0, level: 0 };
    db.prepare("INSERT INTO players(id,name,has_intel,joined,physics,mathematics,level,intel_updated_at) VALUES(7101,'Synthetic Ally',1,'2026-09-01',9,9,9,'2026-09-05 13:00:00')").run();
    context.recordCombatContext(db, known, '2026-09-05T10:00:00Z');
    context.recordCombatContext(db, { ...known, physics: 8, mathematics: 7, level: 6 }, '2026-09-05T13:00:00Z');
    context.recordCombatContext(db, { id: 7102, has_intel: 1 }, '2026-09-05T10:00:00Z');
    const before = context.nearestCombatContext(db, known.id, '2026-09-05T12:00:00Z');
    ok('nearest combat snapshot comes from before the battle, preserving actual zero values', before.physics === 0 && before.level === 0 && before.intel_updated_at === '2026-09-05T10:00:00.000Z');
    ok('partial intel never creates an invented all-zero history', !db.prepare('SELECT 1 FROM player_combat_history WHERE player_id=7102').get());
    ok('combat observations older than48hours are not substituted', context.nearestCombatContext(db, known.id, '2026-09-08T12:00:00Z') === null);
    db.prepare("INSERT INTO battle_reports(id,started_at,att_player_id,def_player_id) VALUES(8101,'2026-09-05T12:00:00Z',7101,NULL)").run();
    const reports = require('../repositories/battleReports');
    reports.snapshotStatsForReports([8101]);
    ok('the real report repository persists historical combat values instead of the later current scan', db.prepare('SELECT att_physics,att_player_level FROM battle_reports WHERE id=8101').get().att_physics === 0);
    db.prepare("UPDATE players SET joined='2026-09-05T11:00:00Z',battle_race_not_before='2026-09-05T11:00:00Z' WHERE id=7101").run();
    db.prepare("INSERT INTO battle_reports(id,started_at,att_player_id,def_player_id) VALUES(8102,'2026-09-05T10:30:00Z',7101,NULL)").run();
    reports.snapshotStatsForReports([8102]);
    const preRestart = db.prepare('SELECT stats_snapshot_at,att_physics,att_race_attack FROM battle_reports WHERE id=8102').get();
    ok('a report from before the known side restart cannot receive the new race through current fallback', preRestart.stats_snapshot_at && preRestart.att_physics === null && preRestart.att_race_attack === null);
    db.exec('DROP TABLE player_public_history');
    ok('a readonly measurement of a pre-rollout schema remains usable without public history', Object.keys(context.contextCeilings(db, subject, [report])).length === 0);
} finally {
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
