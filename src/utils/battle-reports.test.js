// Battle-report ingest: mapping, idempotent upsert, and the announced flag.
//
// Run with:  node src/utils/battle-reports.test.js
//
// These tests run against a TEMPORARY database with a hand-copied real schema, never the
// development one. Every fixture below is SYNTHETIC — the repository is public, and a
// captured battle report carries other players' names and activity patterns.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const { mapApiReport, mapApiDetail, upsertReports, formatBattleEmbed } = require('./battle-reports');
const battleModel = require('../../public/js/utils/battle-model');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// The real battle_reports schema, so a column added in database.js and missed here
// fails loudly rather than being silently absent.
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-battles-'));
    const db = new Database(path.join(dir, 'test.db'));
    db.exec(`
        CREATE TABLE battle_reports (
            id INTEGER PRIMARY KEY,
            started_at TEXT, is_public INTEGER, winner TEXT,
            conquered_planet INTEGER, killed_population INTEGER, random_number REAL,
            att_alliance_id INTEGER, att_alliance_tag TEXT, att_player_id INTEGER,
            att_player_name TEXT, att_has_won INTEGER, att_luckiness REAL,
            att_combat_value INTEGER, att_survived_cv INTEGER, att_lost_cv INTEGER,
            att_pct_cv_lost REAL, att_xp_gained INTEGER, att_level_gained INTEGER,
            def_alliance_id INTEGER, def_alliance_tag TEXT, def_player_id INTEGER,
            def_player_name TEXT, def_has_won INTEGER, def_luckiness REAL,
            def_combat_value INTEGER, def_survived_cv INTEGER, def_lost_cv INTEGER,
            def_pct_cv_lost REAL, def_xp_gained INTEGER, def_level_gained INTEGER,
            announced INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return { db, dir };
}

// A synthetic report in the real production API shape (confirmed 2026-08-30 against
// GET https://astrowars.games/api/v1/BattleReport/search — attacker/defender, boolean
// conqueredPlanet, experiencePointsGained/playerLevelGained).
function apiReport(overrides = {}) {
    return {
        id: 101,
        startedAt: '2026-08-15T18:30:00.000Z',
        isPublic: true,
        winner: 'Attacker',
        conqueredPlanet: true,
        killedPopulation: 7,
        randomNumber: 0.4321,
        attacker: {
            allianceId: 11, allianceTag: 'ATK', playerId: 5001, playerName: 'Synth Attacker',
            hasWon: true, luckiness: 1.05, combatValue: 12000, survivedCombatValue: 9000,
            lostCombatValue: 3000, percentageCombatValueLost: 25, experiencePointsGained: 340, playerLevelGained: 1,
        },
        defender: {
            allianceId: 22, allianceTag: 'DEF', playerId: 5002, playerName: 'Synth Defender',
            hasWon: false, luckiness: 0.97, combatValue: 8000, survivedCombatValue: 0,
            lostCombatValue: 8000, percentageCombatValueLost: 100, experiencePointsGained: 120, playerLevelGained: 0,
        },
        ...overrides,
    };
}

const cleanup = [];

(async () => {
    console.log('── mapApiReport flattens the spec shape ' + '─'.repeat(36));
    {
        const row = mapApiReport(apiReport());
        ok('the game report id becomes the row id', row.id === 101, row);
        ok('started_at is kept as a string', row.started_at === '2026-08-15T18:30:00.000Z', row.started_at);
        ok('booleans become 0/1 integers', row.is_public === 1 && row.att_has_won === 1 && row.def_has_won === 0, row);
        ok('top-level battle facts survive',
            row.winner === 'Attacker' && row.conquered_planet === 1
            && row.killed_population === 7 && row.random_number === 0.4321, row);
        ok('attacker lands under att_',
            row.att_alliance_id === 11 && row.att_alliance_tag === 'ATK'
            && row.att_player_id === 5001 && row.att_player_name === 'Synth Attacker', row);
        ok('defender lands under def_',
            row.def_alliance_id === 22 && row.def_player_name === 'Synth Defender', row);
        ok('the CV arithmetic columns come through',
            row.att_combat_value === 12000 && row.att_survived_cv === 9000 && row.att_lost_cv === 3000
            && row.att_pct_cv_lost === 25 && row.att_xp_gained === 340 && row.att_level_gained === 1, row);
        ok('luckiness stays a real', row.att_luckiness === 1.05 && row.def_luckiness === 0.97, row);
    }

    console.log('\n── The live BattleReport shape with planet + ship detail ' + '─'.repeat(19));
    // Same structure as the first real response of the game's BattleReport change (2026-10-02):
    // every key, the five shipType spellings in the game's order with zero rows included, a
    // null starbaseStats for the attacker, planetId/planetName beside solarSystemId/planetIndex,
    // two-decimal percentage. Names, ids and the planet are invented (public repository);
    // the combat numbers are chosen so the CV arithmetic is the game's own — see below.
    {
        const shipRows = (destroyers, lost) => [
            ['Destroyer', destroyers, lost], ['Cruiser', 0, 0], ['Battleship', 0, 0], ['Transport', 0, 0], ['Colony Ship', 0, 0],
        ].map(([shipType, amount, l]) => ({ amount, lost: l, shipType, survived: amount - l }));
        const live = {
            id: 8101, startedAt: '2026-10-03T14:20:00+02:00', isPublic: false, winner: 'Defender',
            conqueredPlanet: false, killedPopulation: 0,
            planetId: 9001, planetIndex: 12, planetName: 'Synth Star #12', solarSystemId: 7,
            randomNumber: 4.2100,
            attacker: {
                allianceId: 11, allianceTag: 'ATK', combatValue: 72, experiencePointsGained: 0, hasWon: false,
                lostCombatValue: 72, luckiness: 0.00, percentageCombatValueLost: 100.0, playerId: 5001,
                playerLevelGained: 0, playerName: 'Synth Attacker', survivedCombatValue: 0,
                shipTypeStats: shipRows(24, 24), starbaseStats: null,
            },
            defender: {
                allianceId: 22, allianceTag: 'DEF', combatValue: 227, experiencePointsGained: 72, hasWon: true,
                lostCombatValue: 77, luckiness: 0.00, percentageCombatValueLost: 33.9200, playerId: 5002,
                playerLevelGained: 0, playerName: 'Synth Defender', survivedCombatValue: 150,
                shipTypeStats: shipRows(0, 0), starbaseStats: { amount: 10, lost: 1, survived: 9 },
            },
        };
        const row = mapApiReport(live);
        const detail = mapApiDetail(live);

        ok('the live shape still maps its report columns',
            row.id === 8101 && row.winner === 'Defender' && row.random_number === 4.21
            && row.att_has_won === 0 && row.def_has_won === 1 && row.def_pct_cv_lost === 33.92, row);
        ok('location comes from solarSystemId/planetIndex', detail && detail.location
            && detail.location.system_id === 7 && detail.location.planet_index === 12, detail);
        ok('all five real shipType spellings are recognised, so the detail is complete (ships not null)',
            detail && detail.ships !== null, detail);
        ok('attacker ship counts and losses', detail.ships.att_destroyers === 24 && detail.ships.att_destroyers_lost === 24
            && detail.ships.att_cruisers === 0 && detail.ships.att_battleships === 0
            && detail.ships.att_transports === 0 && detail.ships.att_colony_ships === 0
            && detail.ships.att_colony_ships_lost === 0, detail.ships);
        ok('defender ship rows of zero stay zero', detail.ships.def_destroyers === 0 && detail.ships.def_colony_ships === 0, detail.ships);
        ok('the defender starbase is stored as amount/lost',
            detail.ships.def_starbases === 10 && detail.ships.def_starbases_lost === 1, detail.ships);
        ok('an attacker cannot bring a starbase, so null starbaseStats leaves its columns NULL',
            detail.ships.att_starbases === null && detail.ships.att_starbases_lost === null, detail.ships);
        ok('each side\'s survived + lost CV equals its combat value',
            [live.attacker, live.defender].every(s => s.survivedCombatValue + s.lostCombatValue === s.combatValue));
        // starbaseStats.amount is the starbase LEVEL, not a count: level 10 is CV 227, the
        // level it dropped to (9) is CV 150, and the 77 CV it lost is the difference.
        ok('starbaseStats.amount is a level: the game\'s starbase CV table reproduces the defender\'s CV',
            battleModel.sbCV(10) === live.defender.combatValue && battleModel.sbCV(9) === live.defender.survivedCombatValue
            && battleModel.sbCV(10) - battleModel.sbCV(9) === live.defender.lostCombatValue,
            [battleModel.sbCV(9), battleModel.sbCV(10)]);
        // NOT asserted: what a defender WITHOUT a starbase sends (null, or amount 0). The
        // page sweep stores 0 for it; mapApiDetail would store NULL for null. Add a case
        // here once a real response of that kind has been seen.
    }

    console.log('\n── Regression: attacker/defender keys, not the guessed firstParty/secondParty ' + '─'.repeat(3));
    // Before 2026-08-30, mapApiReport read api.firstParty/api.secondParty (an OpenAPI-spec
    // guess never checked against production) — every real report has attacker/defender
    // instead, so every att_/def_ field silently mapped to NULL in every stored row for
    // as long as this bug existed. Assert the OLD shape now maps to all-null sides, so a
    // future regression back to the guessed names fails loudly instead of silently.
    {
        const oldShapeRow = mapApiReport({
            id: 999, startedAt: '2026-08-15T18:30:00.000Z', winner: 'Attacker',
            firstParty: { playerId: 1, playerName: 'Should Not Map' },
            secondParty: { playerId: 2, playerName: 'Should Not Map Either' },
        });
        ok('the old spec-guessed firstParty/secondParty shape no longer maps to anything (regression guard)',
            oldShapeRow.att_player_id === null && oldShapeRow.att_player_name === null
            && oldShapeRow.def_player_id === null && oldShapeRow.def_player_name === null, oldShapeRow);
    }

    console.log('\n── conqueredPlanet is a real boolean, not a planet id ' + '─'.repeat(22));
    // Regression test for the 2026-08-30 production-shape fix: the search endpoint has
    // no planet-id field at all, only this boolean. false/absent must map to a clean 0/
    // null, never to something formatBattleEmbed would mistake for "conquered".
    {
        ok('conqueredPlanet: true maps to 1', mapApiReport(apiReport({ conqueredPlanet: true })).conquered_planet === 1);
        ok('conqueredPlanet: false maps to 0, not null/truthy',
            mapApiReport(apiReport({ conqueredPlanet: false })).conquered_planet === 0);
        const noPlanetLine = formatBattleEmbed(mapApiReport(apiReport({ conqueredPlanet: false })));
        ok('a false conqueredPlanet never adds a "Planet conquered" line',
            !noPlanetLine.description.includes('Planet conquered'), noPlanetLine.description);
        const planetLine = formatBattleEmbed(mapApiReport(apiReport({ conqueredPlanet: true })));
        ok('a true conqueredPlanet adds a plain "Planet conquered." line (no fabricated planet id)',
            planetLine.description.includes('Planet conquered.'), planetLine.description);
    }

    console.log('\n── ...and shrugs at what it cannot use ' + '─'.repeat(37));
    {
        ok('null is skipped, not thrown at', mapApiReport(null) === null);
        ok('an array is skipped', mapApiReport([apiReport()]) === null);
        ok('a report without an id is skipped', mapApiReport(apiReport({ id: undefined })) === null);
        ok('a fractional id is skipped', mapApiReport(apiReport({ id: 1.5 })) === null);
        ok('a zero id is skipped', mapApiReport(apiReport({ id: 0 })) === null);
        ok('a numeric-string id is tolerated — it travelled through a browser',
            mapApiReport(apiReport({ id: '17' })).id === 17);

        const bare = mapApiReport({ id: 9 });
        ok('a report with no parties still maps, with null sides',
            bare !== null && bare.att_player_name === null && bare.def_alliance_id === null, bare);
        ok('junk in a numeric field becomes null, not NaN',
            mapApiReport(apiReport({ randomNumber: 'lucky' })).random_number === null);
        ok('dateTime is accepted when startedAt is absent — the search endpoint sorts by it',
            mapApiReport({ id: 3, dateTime: '2026-08-14T10:00:00Z' }).started_at === '2026-08-14T10:00:00Z');
    }

    console.log('\n── upsertReports is idempotent: the game id is the truth ' + '─'.repeat(19));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        const rows = [mapApiReport(apiReport({ id: 101 })), mapApiReport(apiReport({ id: 102 }))];

        const first = upsertReports(db, rows);
        ok('two new reports are inserted', first.inserted.length === 2 && first.skipped === 0, first);
        ok('and stored', db.prepare(`SELECT COUNT(*) n FROM battle_reports`).get().n === 2);
        ok('a fresh row starts unannounced',
            db.prepare(`SELECT announced FROM battle_reports WHERE id = 101`).get().announced === 0);

        const again = upsertReports(db, rows);
        ok('the same batch again inserts nothing', again.inserted.length === 0, again);
        ok('and reports every row as skipped', again.skipped === 2, again);

        const mixed = upsertReports(db, [mapApiReport(apiReport({ id: 102 })), mapApiReport(apiReport({ id: 103 }))]);
        ok('a mixed batch inserts only the new one',
            mixed.inserted.length === 1 && mixed.inserted[0].id === 103 && mixed.skipped === 1, mixed);

        const dup = upsertReports(db, [mapApiReport(apiReport({ id: 104 })), mapApiReport(apiReport({ id: 104 }))]);
        ok('a duplicate inside one batch counts once', dup.inserted.length === 1 && dup.skipped === 1, dup);
        db.close();
    }

    console.log('\n── The announced flag survives a re-sync ' + '─'.repeat(35));
    // This is the property the Discord path leans on: a report is announced when it is
    // first seen, and syncing the same window again tomorrow must not re-announce it.
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        upsertReports(db, [mapApiReport(apiReport({ id: 201 }))]);
        db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = 201`).run();

        const resync = upsertReports(db, [mapApiReport(apiReport({ id: 201 }))]);
        ok('the re-synced report is not treated as new', resync.inserted.length === 0, resync);
        ok('and its announced flag is untouched',
            db.prepare(`SELECT announced FROM battle_reports WHERE id = 201`).get().announced === 1);
        ok('INSERT OR IGNORE did not overwrite the stored data either',
            db.prepare(`SELECT att_player_name FROM battle_reports WHERE id = 201`).get().att_player_name === 'Synth Attacker');
        db.close();
    }

    console.log('\n── The embed is plain data with live timestamps ' + '─'.repeat(29));
    {
        const embed = formatBattleEmbed(mapApiReport(apiReport()));
        ok('it is a plain {title, description, color} object',
            typeof embed.title === 'string' && typeof embed.description === 'string' && typeof embed.color === 'number', embed);
        ok('the title carries the report id', /#101\b/.test(embed.title), embed.title);
        ok('both sides are named, tag first',
            embed.description.includes('[ATK] Synth Attacker') && embed.description.includes('[DEF] Synth Defender'),
            embed.description);
        const unix = Math.floor(Date.parse('2026-08-15T18:30:00.000Z') / 1000);
        ok('the battle time is Discord relative-timestamp markdown',
            embed.description.includes(`<t:${unix}:R>`), embed.description);
        ok('and it is NOT inside a code block, which would print it literally',
            !embed.description.includes('```') && !embed.description.includes('`<t:'), embed.description);
        ok('an attacker win is the red embed', embed.color === 0xed4245, embed.color);

        const held = formatBattleEmbed(mapApiReport(apiReport({
            attacker: { ...apiReport().attacker, hasWon: false },
            defender: { ...apiReport().defender, hasWon: true },
        })));
        ok('a held defence is the green one', held.color === 0x57f287, held.color);

        const sparse = formatBattleEmbed(mapApiReport({ id: 7 }));
        ok('a report with nothing but an id still formats', typeof sparse.description === 'string', sparse);
        ok('with no NaN timestamp leaking into the markdown', !sparse.description.includes('<t:NaN'), sparse.description);
        ok('and unknown sides named as such', /Unknown/.test(sparse.description), sparse.description);
    }

    console.log('\n── The wipe and the audit trail disagree on purpose ' + '─'.repeat(24));
    // battle_reports describes the round's map, so the round wipe takes it.
    // starbase_order_audit records who sent what through the hub — that outlives rounds.
    const admin = readCode('src/routes/admin.js');
    ok('the round wipe clears battle reports', /battleReportsRepo\.deleteAllBattleReports\(\)/.test(admin));
    ok('inside the same transaction as the other deletes',
        admin.indexOf('battleReportsRepo.deleteAllBattleReports()') > admin.indexOf('archiveRound(db')
        && admin.indexOf('battleReportsRepo.deleteAllBattleReports()') < admin.indexOf('nukeTx()'),
        [admin.indexOf('archiveRound(db'), admin.indexOf('battleReportsRepo.deleteAllBattleReports()'), admin.indexOf('nukeTx()')]);
    ok('but never touches the starbase order audit', !/DELETE FROM starbase_order_audit/.test(admin));

    const schema = readCode('src/database.js');
    ok('both tables are part of the idempotent schema',
        /CREATE TABLE IF NOT EXISTS battle_reports/.test(schema)
        && /CREATE TABLE IF NOT EXISTS starbase_order_audit/.test(schema));
    ok('battle_reports is indexed on started_at — every sync asks for the newest',
        /idx_battle_reports_started ON battle_reports\(started_at\)/.test(schema));
    ok('the audit actor follows the SET NULL attribution model, never losing the row',
        /starbase_order_audit[\s\S]{0,600}ON DELETE SET NULL/.test(schema));

    const sync = readCode('src/routes/sync.js');
    ok('the ingest route maps through battle-reports.js, not its own parser',
        /\/sync\/battle-reports/.test(sync) && /mapApiReport/.test(sync) && /upsertReports/.test(sync));
    ok('announcements go through the REST helper to the configured channel',
        /postEmbed\('discord_battlereport_channel'/.test(sync));
    ok('player names are defused before they reach Discord', /defuseMentions\(/.test(sync));
    ok('the audit row takes its actor from the session, not the payload',
        /starbase-audit[\s\S]{0,1200}req\.session\.userId/.test(sync));

    for (const dir of cleanup) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* best effort */ }
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
