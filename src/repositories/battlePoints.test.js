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
const emptyBoards = battlePoints.getLeaderboards(null, 10, 'all');
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

// scope='all' throughout this section — these tests exercise the leaderboard math/
// exclusion logic itself, not the new member/alliance scoping (covered separately below),
// and none of these synthetic players are linked to an app_users row.
const boards = battlePoints.getLeaderboards(null, 10, 'all');
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
const windowed = battlePoints.getLeaderboards('2026-01-01T00:00:00Z', 10, 'all');
const aliceWindowed = windowed.cv.find(r => r.player_name === 'Alice');
ok('with a recent "since", Alice only gets battle 1\'s cv (2000)', aliceWindowed && aliceWindowed.raw === 2000, aliceWindowed);

// limit is honored
const limited = battlePoints.getCvLeaderboard(null, 1, 'all');
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
// An uncredited conquest (no matching POP_DROP found — see sync.js) contributes nothing,
// same as any other row with a NULL population_delta.
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (10, 'battle-conquer', '2026-08-06T00:00:00Z', 10, NULL, NULL)
`).run();
// A credited conquest News row is NOT summed any more: non-battle conquests come from the
// scan's log (planet_events) instead, so counting the News row too would double it.
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (10, 'battle-conquer', '2026-08-06T01:00:00Z', 10, 51, NULL)
`).run();
// ...the same conquest as the scan logged it: OWNER_CHANGE (free planet -> Gina) + POP_DROP.
// A free planet's leftover population is a colonization, not a kill: it earns nothing.
db.prepare(`INSERT INTO systems (id, name) VALUES (70, 'S70'), (80, 'S80')`).run();
db.prepare(`
    INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp)
    VALUES (70, 3, 1, NULL, 10, '2026-08-06 01:02:00'), (70, 3, 2, 51, 0, '2026-08-06 01:02:00')
`).run();

const boardsWithNews = battlePoints.getLeaderboards(null, 10, 'all');
const gina = boardsWithNews.pop.find(r => r.player_name === 'Gina');
ok('Gina gets population points from her unmatched bombardment (400) only — her conquest was a free planet (colonization) and the News row is not summed',
    gina && gina.raw === 400, gina);
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

const boardsWithLostDirection = battlePoints.getLeaderboards(null, 10, 'all');
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

const boardsWithUnknownOpponent = battlePoints.getLeaderboards(null, 10, 'all');
const kate = boardsWithUnknownOpponent.pop.find(r => r.player_name === 'Kate');
ok('Kate is credited for a self-bombing row with no known opponent (other_player_id NULL)',
    kate && kate.raw === 5, boardsWithUnknownOpponent.pop);

// --- scope: 'members' (default) vs 'alliance' vs 'all' ---
// Alice (tool user, alliance 100) and Ivan (NOT a tool user, alliance 100) are both in
// alliance 100. Bob (enemy, never a tool user) only ever appears as a CV defender.
// Alice was only ever referenced via battle_reports.att_player_name so far (no FK to
// players) — a real players row is required for the membership/alliance JOINs to find her.
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (1, 'Alice', 100)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash) VALUES (900, 'Alice', 'x')`).run();

const defaultScope = battlePoints.getLeaderboards(null, 10);
ok("default scope ('members') includes Alice (a tool user)",
    defaultScope.cv.some(r => r.player_name === 'Alice'), defaultScope.cv);
ok("default scope ('members') excludes Ivan (same alliance as Alice, but not a tool user)",
    !defaultScope.pop.some(r => r.player_name === 'Ivan'), defaultScope.pop);
ok("default scope ('members') excludes Bob (never a tool user, only ever a CV defender)",
    !defaultScope.cv.some(r => r.player_name === 'Bob'), defaultScope.cv);

const allianceScope = battlePoints.getLeaderboards(null, 10, 'alliance', 100);
ok("scope 'alliance' includes Ivan (alliance 100, not a tool user, but in-scope by alliance)",
    allianceScope.pop.some(r => r.player_name === 'Ivan'), allianceScope.pop);
ok("scope 'alliance' still excludes Bob (a different alliance entirely)",
    !allianceScope.cv.some(r => r.player_name === 'Bob'), allianceScope.cv);

const allScope = battlePoints.getLeaderboards(null, 10, 'all');
ok("scope 'all' includes Bob (no membership/alliance filter at all)",
    allScope.cv.some(r => r.player_name === 'Bob'), allScope.cv);

// --- Conquests without a battle, from the scan log (2026-10-12: Moardin25 took TheOne's
// planet with no battle; the only credit path was his own News page, which he never opened
// through the hub, so his 5 population never counted). Only a planet taken from an ACTIVE,
// NON-FRIENDLY player counts. ---
db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (200, 'Raid', 'RD'), (201, 'Paid', 'PD'), (202, 'Napped', 'NAPX')`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, last_activity_at, resigned_at) VALUES
    (40, 'Moa', 200, '2026-10-12T03:00:00.000Z', NULL),
    (41, 'One', 201, '2026-10-12T01:47:39.6628922+02:00', NULL),     -- active (game's own +02:00 format)
    (42, 'Lba', 200, '2026-10-12T03:00:00.000Z', NULL),
    (43, 'Sil', 201, '2026-10-12T03:00:00.000Z', NULL),
    (44, 'Idle', 201, '2026-09-01T10:00:00.000Z', NULL),             -- last seen 5+ weeks before
    (45, 'Quit', 201, '2026-10-12T03:00:00.000Z', '2026-10-08T00:00:00.000Z'), -- resigned before
    (46, 'Napper', 202, '2026-10-12T03:00:00.000Z', NULL)            -- allied tag`).run();
db.prepare(`INSERT INTO app_settings (key, value) VALUES ('alliance_relations_allied', 'napx')`).run();
db.prepare(`
    INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp) VALUES
        (80, 12, 1, 41, 40, '2026-10-09 02:40:49'), (80, 12, 2, 5, 0, '2026-10-09 02:40:49'),  -- One -> Moa, no battle: 5
        (80, 5, 1, 43, 40, '2026-10-09 06:00:00'),  (80, 5, 2, 30, 0, '2026-10-09 06:00:00'),   -- Sil -> Moa, WITH a battle report
        (80, 6, 1, 40, 42, '2026-10-09 07:00:00'),  (80, 6, 2, 2, 0, '2026-10-09 07:00:00'),    -- Moa -> Lba: own-tag handover
        (80, 7, 1, 41, 40, '2026-10-01 07:00:00'),  (80, 7, 2, 7, 0, '2026-10-01 07:00:00'),    -- older, outside a since-window
        (80, 8, 1, 41, 40, '2026-10-09 08:00:00'),                                              -- owner change, no population
        (80, 9, 1, NULL, 40, '2026-10-09 09:00:00'), (80, 9, 2, 1, 0, '2026-10-09 09:00:00'),   -- free planet colonized: 1
        (80, 10, 1, 44, 40, '2026-10-09 10:00:00'), (80, 10, 2, 3, 0, '2026-10-09 10:00:00'),   -- inactive owner
        (80, 11, 1, 45, 40, '2026-10-09 11:00:00'), (80, 11, 2, 4, 0, '2026-10-09 11:00:00'),   -- resigned owner
        (80, 13, 1, 46, 40, '2026-10-09 12:00:00'), (80, 13, 2, 6, 0, '2026-10-09 12:00:00')    -- allied owner
`).run();
// The battle conquest of 80:5 (report time in +02:00, before the scan) — its report counts it.
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, att_player_name, att_alliance_tag, def_player_id, def_player_name, def_alliance_tag,
        conquered_planet, killed_population, system_id, planet_index)
    VALUES (9001, '2026-10-09T07:30:00+02:00', 40, 'Moa', 'RD', 43, 'Sil', 'PD', 1, 30, 80, 5)
`).run();
const popMoa = () => battlePoints.getLeaderboards(null, 50, 'all').pop.find(r => r.player_name === 'Moa');
ok('only conquests from active non-friendly players count: One (5) + battle report (30) + older One (7); free, inactive, resigned and allied owners add nothing',
    popMoa() && popMoa().raw === 42, popMoa());
ok('an own-tag handover earns nothing',
    !battlePoints.getLeaderboards(null, 50, 'all').pop.some(r => r.player_name === 'Lba'));
const since = battlePoints.getLeaderboards('2026-10-05T00:00:00.000Z', 50, 'all').pop.find(r => r.player_name === 'Moa');
ok('the since-window applies to logged conquests (2026-10-01 one left out: 5 + 30)', since && since.raw === 35, since);
const dyn = battlePoints.getDynamicLeaderboard(null, 50, 'all').find(r => r.player_name === 'Moa');
ok('!glory (dynamic leaderboard) gives Moa population points for them', dyn && dyn.pop_points > 0, dyn);

// --- A News bombardment the game also wrote a battle report for (2026-10-31) ---
// The game logs a won battle and its bombardment on the same planet in the same second, and
// only the battle row links the report ("We won the battle at Achird #5" + "Your fleet has
// bombed Achird #5", both 16:54:59). The report's killed_population IS that bombardment.
db.prepare(`INSERT INTO systems (id, name) VALUES (2, 'Achird')`).run();
db.prepare(`INSERT INTO planets (game_planet_id, system_id, planet_index) VALUES (12422, 2, 5), (12423, 2, 6)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (50, 'Rex', 101), (51, 'Vic', NULL)`).run();
const news = db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, game_planet_id, system_id, credited_player_id, population_delta)
    VALUES (50, 'battle-bombarded', ?, ?, 2, 50, ?)
`);
news.run('2026-10-31T15:54:59.000Z', 12422, 43); // 16:54:59 Warsaw, same second as the battle
news.run('2026-10-31T18:54:59.000Z', 12422, 10); // same planet 3 h later: an undefended bombardment
news.run('2026-10-31T15:54:59.000Z', 12423, 7);  // same second, a different planet
const rexPop = () => battlePoints.getLeaderboards(null, 50, 'all').pop.find(r => r.player_name === 'Rex');
ok('before its battle report arrives, the News bombardment counts (43 + 10 + 7)', rexPop() && rexPop().raw === 60, rexPop());
db.prepare(`
    INSERT INTO battle_reports (id, started_at, att_player_id, att_player_name, att_alliance_tag, def_player_id, def_player_name,
        att_lost_cv, def_lost_cv, killed_population, system_id, planet_index)
    VALUES (9100, '2026-10-31T16:54:00+01:00', 50, 'Rex', 'VICT', 51, 'Vic', 609, 1164, 43, 2, 5)
`).run();
ok('once the report arrives (after the reset), the same 43 is counted once, from the report: 43 + 10 + 7',
    rexPop() && rexPop().raw === 60, rexPop());
const rexDyn = battlePoints.getDynamicLeaderboard(null, 50, 'all').find(r => r.player_name === 'Rex');
const expectPop = battlePoints.popDynamicPoints(43) + battlePoints.popDynamicPoints(10) + battlePoints.popDynamicPoints(7);
ok('!glory counts it once too', rexDyn && Math.abs(rexDyn.pop_points - expectPop) < 0.01, { rexDyn, expectPop });

// --- Leaderboards show a renamed player's CURRENT name (2026-10-31) ---
// Reports keep the name at battle time; BaldWithABeard was listed as his old name "h87".
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (60, 'BaldWithABeard', 101)`).run();
insert.run({ id: 9200, started_at: '2026-09-01T01:10:00+02:00', att_player_id: 60, att_player_name: 'h87', att_alliance_tag: 'VICT',
    att_lost_cv: 0, def_player_id: 51, def_player_name: 'Vic', def_alliance_tag: null, def_lost_cv: 900000, killed_population: 0 });
insert.run({ id: 9201, started_at: '2026-10-20T00:24:00+02:00', att_player_id: 60, att_player_name: 'BaldWithABeard', att_alliance_tag: 'VICT',
    att_lost_cv: 0, def_player_id: 51, def_player_name: 'Vic', def_alliance_tag: null, def_lost_cv: 100000, killed_population: 0 });
const cvTop = battlePoints.getCvLeaderboard(null, 1, 'all')[0];
ok('!mortal / !cvkills list him under his current name, with both reports summed',
    cvTop && cvTop.player_id === 60 && cvTop.player_name === 'BaldWithABeard' && cvTop.raw === 1000000, cvTop);
ok('...and no row carries the old name', !battlePoints.getLeaderboards(null, 50, 'all').cv.some(r => r.player_name === 'h87'));
const gloryBald = battlePoints.getDynamicLeaderboard(null, 50, 'all').find(r => r.player_id === 60);
ok('!glory too', gloryBald && gloryBald.player_name === 'BaldWithABeard', gloryBald);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
