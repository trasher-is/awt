const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const settingsRepo = require('./settings');
const battlePoints = require('./battlePoints');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('battlePoints.test.js');

// Defaults with no settings rows at all
ok('getCvRatio defaults to 1000', battlePoints.getCvRatio() === 1000);
ok('getPopRatio defaults to 100', battlePoints.getPopRatio() === 100);
ok('getExcludedAllianceTags defaults to []', Array.isArray(battlePoints.getExcludedAllianceTags()) && battlePoints.getExcludedAllianceTags().length === 0);

// Empty leaderboards when there are no battle_reports rows
const emptyBoards = battlePoints.getLeaderboards(null, 10);
ok('cv leaderboard empty with no data', Array.isArray(emptyBoards.cv) && emptyBoards.cv.length === 0);
ok('pop leaderboard empty with no data', Array.isArray(emptyBoards.pop) && emptyBoards.pop.length === 0);

settingsRepo.setSetting('battle_points_cv_ratio', '1000');
settingsRepo.setSetting('battle_points_pop_ratio', '100');
settingsRepo.setSetting('battle_points_excluded_alliance_tags', 'ally, Ally2');

ok('getExcludedAllianceTags parses, trims, and uppercases', (() => {
    const tags = battlePoints.getExcludedAllianceTags();
    return tags.length === 2 && tags.includes('ALLY') && tags.includes('ALLY2');
})());

const insert = db.prepare(`
    INSERT INTO battle_reports (
        id, started_at, att_player_id, att_player_name, att_alliance_tag, att_lost_cv,
        def_player_id, def_player_name, def_alliance_tag, def_lost_cv, killed_population
    ) VALUES (
        @id, @started_at, @att_player_id, @att_player_name, @att_alliance_tag, @att_lost_cv,
        @def_player_id, @def_player_name, @def_alliance_tag, @def_lost_cv, @killed_population
    )
`);

// Battle 1: real fight, Alice (RAID) beats Bob (ENEMY). Counts fully.
insert.run({
    id: 1, started_at: '2026-08-01T00:00:00Z',
    att_player_id: 1, att_player_name: 'Alice', att_alliance_tag: 'RAID', att_lost_cv: 500,
    def_player_id: 2, def_player_name: 'Bob', def_alliance_tag: 'ENEMY', def_lost_cv: 2000,
    killed_population: 300,
});

// Battle 2: friendly fire, Alice (RAID) vs Carol (RAID). Excluded entirely.
insert.run({
    id: 2, started_at: '2026-08-02T00:00:00Z',
    att_player_id: 1, att_player_name: 'Alice', att_alliance_tag: 'RAID', att_lost_cv: 100,
    def_player_id: 3, def_player_name: 'Carol', def_alliance_tag: 'RAID', def_lost_cv: 100,
    killed_population: 50,
});

// Battle 3: Dave (RAID) vs Eve (ALLY, an excluded tag). Excluded entirely.
insert.run({
    id: 3, started_at: '2026-08-03T00:00:00Z',
    att_player_id: 4, att_player_name: 'Dave', att_alliance_tag: 'RAID', att_lost_cv: 900,
    def_player_id: 5, def_player_name: 'Eve', def_alliance_tag: 'ALLY', def_lost_cv: 900,
    killed_population: 900,
});

// Battle 4: old fight for Alice, well before the "since" window used below.
insert.run({
    id: 4, started_at: '2020-01-01T00:00:00Z',
    att_player_id: 1, att_player_name: 'Alice', att_alliance_tag: 'RAID', att_lost_cv: 9999,
    def_player_id: 6, def_player_name: 'Frank', def_alliance_tag: 'ENEMY', def_lost_cv: 9999,
    killed_population: 9999,
});

const boards = battlePoints.getLeaderboards(null, 10);
ok('cv leaderboard has exactly Alice, Bob, and Frank (battles 1 and 4; battle 2/3 excluded)',
    boards.cv.length === 3, boards.cv); // Alice attacked in both battle 1 (vs Bob) and battle 4 (vs Frank)

const alice = boards.cv.find(r => r.player_name === 'Alice');
ok('Alice is credited with def_lost_cv from battle 1 plus battle 4 (2000 + 9999)',
    alice && alice.raw === 11999, alice);
ok('Alice points = raw / 1000, rounded to 1 decimal', alice && alice.points === 12, alice);

const bob = boards.cv.find(r => r.player_name === 'Bob');
ok('Bob is credited with att_lost_cv from battle 1 (500)', bob && bob.raw === 500 && bob.points === 0.5, bob);

ok('Carol never appears (friendly fire excluded)', !boards.cv.some(r => r.player_name === 'Carol'), boards.cv);
ok('Dave/Eve never appear (excluded alliance tag)', !boards.cv.some(r => r.player_name === 'Dave' || r.player_name === 'Eve'), boards.cv);

const alicePop = boards.pop.find(r => r.player_name === 'Alice');
ok('Alice pop points from battle 1 + battle 4 (300 + 9999), attacker-credited only',
    alicePop && alicePop.raw === 10299 && alicePop.points === 103, alicePop);
ok('Bob never appears on pop leaderboard (only attacker is credited)', !boards.pop.some(r => r.player_name === 'Bob'), boards.pop);

// "since" windowing excludes battle 4 but keeps battle 1
const windowed = battlePoints.getLeaderboards('2026-01-01T00:00:00Z', 10);
const aliceWindowed = windowed.cv.find(r => r.player_name === 'Alice');
ok('with a recent "since", Alice only gets battle 1\'s cv (2000)', aliceWindowed && aliceWindowed.raw === 2000, aliceWindowed);

// limit is honored
const limited = battlePoints.getCvLeaderboard(null, 1);
ok('limit=1 returns exactly one row (the top scorer)', limited.length === 1 && limited[0].player_name === 'Alice', limited);

// --- News-page bombardment credit (unmatched only — see the "no battle_reports link"
// case vs. the "already covered by a real battle report" case) ---
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (10, 'Gina', NULL), (11, 'Hank', NULL)`).run();

db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (10, 'battle-bombarded', '2026-08-05T00:00:00Z', 10, 400, NULL)
`).run();
// This one IS matched to a real battle report — must be excluded from the sum (that
// battle report's own killed_population already counts it, via the existing battle_reports path).
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (11, 'battle-bombarded', '2026-08-05T00:00:00Z', 11, 999, 1)
`).run();
// A conquest event never contributes points regardless of credited_player_id.
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (10, 'battle-conquer', '2026-08-06T00:00:00Z', 10, NULL, NULL)
`).run();

const boardsWithNews = battlePoints.getLeaderboards(null, 10);
const gina = boardsWithNews.pop.find(r => r.player_name === 'Gina');
ok('Gina gets population points from her unmatched bombardment (400)', gina && gina.raw === 400, gina);
ok('Hank never appears — his bombardment is already covered by a real battle report',
    !boardsWithNews.pop.some(r => r.player_name === 'Hank'), boardsWithNews.pop);

ok('cv leaderboard is unaffected by news_events (still only Alice/Bob/Frank from battle_reports)',
    boardsWithNews.cv.length === 3, boardsWithNews.cv);

// --- Regression test for finding I1 of the "battle challenge tracker news" final-review
// fix wave (2026-08-30): a defender-recorded bombardment (direction 'lost' on the scraping
// member's own News row) sets credited_player_id = other_player_id (the attacker gets pop
// credit). The old SQL joined "op" via other_player_id unconditionally, which for these
// rows made op resolve to the SAME player as credited_player_id (cp) — so ca.tag = oa.tag
// was trivially true and the friendly-fire exclusion wrongly fired whenever the attacker
// had ANY alliance tag, silently dropping the row. This test uses players with real,
// DIFFERENT, non-excluded alliance tags on both sides specifically because the prior test
// coverage above only used alliance_id = NULL players (exactly why this bug went uncaught).
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (100, 'Raiders', 'RAID2'), (101, 'Victims', 'VICT')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (20, 'Ivan', 100), (21, 'Jill', 101)`).run();
// Jill (id 21, tag VICT) was bombarded by Ivan (id 20, tag RAID2) — her own News row
// records direction 'lost', so credited_player_id (20) was set to what was originally
// other_player_id, and player_id (21, Jill, the victim) stays as-is.
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, other_player_id, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (21, 'battle-bombarded', '2026-08-07T00:00:00Z', 20, 20, 750, NULL)
`).run();

const boardsWithLostDirection = battlePoints.getLeaderboards(null, 10);
const ivan = boardsWithLostDirection.pop.find(r => r.player_name === 'Ivan');
ok('Ivan (attacker, credited via a direction:lost-style row) is INCLUDED — tags legitimately differ and are not excluded',
    ivan && ivan.raw === 750, boardsWithLostDirection.pop);

// --- Regression test: self-bombing with no known opponent at all (other_player_id NULL
// from the start, not just unresolvable). A real News-page "You killed N population" row
// carries no player-profile link (see the 2026-08-30 sync.js/news-battle-matching fix), so
// credited_player_id gets set to the scraping player while other_player_id stays NULL. The
// pop leaderboard's "op" join (used only to check the opponent's alliance tag for
// exclusion) must tolerate that NULL rather than wrongly excluding or crashing.
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (30, 'Kate', 100)`).run();
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, other_player_id, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (30, 'battle-bombarded', '2026-08-08T00:00:00Z', NULL, 30, 5, NULL)
`).run();

const boardsWithUnknownOpponent = battlePoints.getLeaderboards(null, 10);
const kate = boardsWithUnknownOpponent.pop.find(r => r.player_name === 'Kate');
ok('Kate is credited for a self-bombing row with no known opponent (other_player_id NULL)',
    kate && kate.raw === 5, boardsWithUnknownOpponent.pop);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
