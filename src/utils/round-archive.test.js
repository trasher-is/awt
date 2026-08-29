// Keeping who-is-who across a round wipe.
//
// Run with:  node src/utils/round-archive.test.js
//
// "Nuke data" deletes players so the next round starts clean. A player id is stable for
// the life of an account and people rename between rounds — Chewie played Beta 2-3 as
// Elfenlied, id 39 throughout — so the wipe was destroying the only link between the two.
//
// These tests run against a TEMPORARY database, not the development one. The subject is a
// function that copies every row in `players`, and pointing that at a shared database from
// a test would leave archived rounds behind on every run.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const { archiveRound, previousNames, findByFormerName, listRounds, roundDetail,
    searchFormerNamesWithCurrentPlayer } = require('./round-archive');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// The real schema, so a column added to database.js and missed here fails loudly rather
// than being silently absent.
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-rounds-'));
    const db = new Database(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    db.exec(`
        CREATE TABLE alliances (id INTEGER PRIMARY KEY, tag TEXT, name TEXT);
        CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, alliance_id INTEGER,
                              points INTEGER DEFAULT 0, level INTEGER DEFAULT 0);
        CREATE TABLE systems (id INTEGER PRIMARY KEY, name TEXT, x INTEGER, y INTEGER);
        CREATE TABLE planets (game_planet_id INTEGER PRIMARY KEY, system_id INTEGER,
                              planet_index INTEGER, owner_id INTEGER);
        CREATE TABLE rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, note TEXT,
            player_count INTEGER DEFAULT 0, system_count INTEGER DEFAULT 0,
            archived_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE round_players (
            round_id INTEGER NOT NULL, player_id INTEGER NOT NULL, name TEXT,
            alliance_tag TEXT, points INTEGER, level INTEGER, planet_count INTEGER DEFAULT 0,
            PRIMARY KEY (round_id, player_id),
            FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE);
        CREATE TABLE round_systems (
            round_id INTEGER NOT NULL, system_id INTEGER NOT NULL, name TEXT, x INTEGER, y INTEGER,
            PRIMARY KEY (round_id, system_id),
            FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE);
    `);
    return { db, dir };
}

// The wipe, exactly as src/routes/admin.js runs it.
function wipe(db) {
    db.prepare(`DELETE FROM planets`).run();
    db.prepare(`DELETE FROM players`).run();
    db.prepare(`DELETE FROM alliances`).run();
    db.prepare(`DELETE FROM systems`).run();
}

function seedRound(db, players, { systems = 3 } = {}) {
    db.prepare(`INSERT OR IGNORE INTO alliances (id, tag, name) VALUES (1, 'INDG', 'Indigo')`).run();
    db.prepare(`INSERT OR IGNORE INTO alliances (id, tag, name) VALUES (2, 'RED', 'Red')`).run();
    for (const p of players) {
        db.prepare(`INSERT INTO players (id, name, alliance_id, points, level) VALUES (?, ?, ?, ?, ?)`)
            .run(p.id, p.name, p.alliance ?? 1, p.points ?? 1000, p.level ?? 10);
    }
    for (let i = 1; i <= systems; i++) {
        db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)`)
            .run(i, i === 1 ? 'Rana' : `System ${i}`, i === 1 ? 0 : i, i === 1 ? 0 : -i);
    }
}

const cleanup = [];

(async () => {
    console.log('── A wipe no longer destroys who somebody was ' + '─'.repeat(30));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        // The example from the issue: id 39 played as Elfenlied, plays now as Chewie.
        seedRound(db, [
            { id: 39, name: 'Elfenlied', points: 52000 },
            { id: 77, name: 'Trasher', points: 90000, alliance: 2 },
        ]);
        db.prepare(`INSERT INTO planets VALUES (1, 1, 1, 39)`).run();
        db.prepare(`INSERT INTO planets VALUES (2, 1, 2, 39)`).run();

        const result = db.transaction(() => {
            const r = archiveRound(db, { label: 'Beta 3' });
            wipe(db);
            return r;
        })();

        ok('the snapshot reports what it took', result.players === 2 && result.systems === 3, result);
        ok('and the label it was given', result.label === 'Beta 3', result.label);
        ok('the wipe still emptied the live tables',
            db.prepare(`SELECT COUNT(*) n FROM players`).get().n === 0);
        ok('but the archive survived it',
            db.prepare(`SELECT COUNT(*) n FROM round_players`).get().n === 2);

        const archived = db.prepare(`SELECT * FROM round_players WHERE player_id = 39`).get();
        ok('the archived row keeps the name', archived.name === 'Elfenlied', archived);
        ok('and the alliance tag as it was then', archived.alliance_tag === 'INDG', archived);
        ok('and the points', archived.points === 52000, archived);
        ok('and how many planets they held', archived.planet_count === 2, archived);

        // Next round: the same account comes back renamed.
        seedRound(db, [{ id: 39, name: 'Chewie', points: 100 }], { systems: 2 });

        const history = previousNames(db, 39, { currentName: 'Chewie' });
        ok('the intel panel can now say what id 39 used to be called',
            history.length === 1 && history[0].name === 'Elfenlied', history);
        ok('with the round it was used in', history[0].label === 'Beta 3', history[0]);

        ok('someone who never renamed shows no history at all',
            previousNames(db, 77, { currentName: 'Trasher' }).length === 0);

        const found = findByFormerName(db, 'Elfen');
        ok('searching the old name finds the account', found.length === 1 && found[0].playerId === 39, found);
        ok('and answers with who they are NOW, which is the useful part',
            found[0].currentName === 'Chewie', found[0]);
        db.close();
    }

    console.log('\n── The snapshot and the wipe are one step, or neither ' + '─'.repeat(22));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        seedRound(db, [{ id: 5, name: 'Keeper' }]);

        // Force the archive to fail the way a real fault would: the table it writes to is
        // gone. The wipe must not run.
        db.exec(`DROP TABLE round_players`);
        let threw = false;
        try {
            db.transaction(() => { archiveRound(db, { label: 'doomed' }); wipe(db); })();
        } catch (err) { threw = true; }

        ok('a failing snapshot throws rather than continuing', threw);
        ok('and NOTHING is deleted — the players are still there',
            db.prepare(`SELECT COUNT(*) n FROM players`).get().n === 1);
        ok('nor is a half-written round left behind',
            db.prepare(`SELECT COUNT(*) n FROM rounds`).get().n === 0);
        db.close();
    }

    console.log('\n── Several rounds, several names ' + '─'.repeat(42));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);

        seedRound(db, [{ id: 39, name: 'Elfenlied' }]);
        db.transaction(() => { archiveRound(db, { label: 'Beta 2' }); wipe(db); })();

        seedRound(db, [{ id: 39, name: 'Elfenlied' }]);
        db.transaction(() => { archiveRound(db, { label: 'Beta 3' }); wipe(db); })();

        seedRound(db, [{ id: 39, name: 'Wookiee' }]);
        db.transaction(() => { archiveRound(db, { label: 'Beta 4' }); wipe(db); })();

        seedRound(db, [{ id: 39, name: 'Chewie' }]);

        const history = previousNames(db, 39, { currentName: 'Chewie' });
        ok('every distinct earlier name is listed', history.length === 2, history.map(h => h.name));
        ok('newest round first', history[0].name === 'Wookiee' && history[1].name === 'Elfenlied', history.map(h => h.name));
        ok('a name used in three rounds appears once, not three times',
            history.filter(h => h.name === 'Elfenlied').length === 1, history.map(h => h.name));
        ok('and it is attributed to the most recent round it was used in',
            history.find(h => h.name === 'Elfenlied').label === 'Beta 3', history);

        ok('the current name is never listed as a former one',
            !history.some(h => h.name.toLowerCase() === 'chewie'), history.map(h => h.name));
        // Renaming back to an old name is a real thing people do.
        ok('a name matching the current one case-insensitively is excluded too',
            !previousNames(db, 39, { currentName: 'WOOKIEE' }).some(h => h.name === 'Wookiee'));

        ok('three rounds are on the index', listRounds(db).length === 3);
        ok('the index is newest first', listRounds(db)[0].label === 'Beta 4', listRounds(db).map(r => r.label));
        ok('each round records how much it holds',
            listRounds(db).every(r => r.players === 1 && r.systems === 3), listRounds(db));
        db.close();
    }

    console.log('\n── Only what still means something a round later ' + '─'.repeat(26));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        seedRound(db, [{ id: 1, name: 'A' }]);
        db.transaction(() => archiveRound(db, {}))();

        const cols = db.prepare(`PRAGMA table_info(round_players)`).all().map(c => c.name);
        ok('players keep id, name, tag, points, level and planet count',
            ['player_id', 'name', 'alliance_tag', 'points', 'level', 'planet_count'].every(c => cols.includes(c)), cols);

        const sys = db.prepare(`SELECT * FROM round_systems WHERE system_id = 1`).get();
        ok('system names and ids are kept — those carry across a round',
            sys.name === 'Rana' && sys.system_id === 1, sys);
        ok('with the coordinates they had, as a record of the round that ended',
            sys.x === 0 && sys.y === 0, sys);

        ok('an unlabelled snapshot still gets a dated label',
            /^Round archived \d{4}-\d{2}-\d{2}$/.test(listRounds(db)[0].label), listRounds(db)[0].label);
        db.close();
    }

    console.log('\n── The archive outlives the rows it was copied from ' + '─'.repeat(23));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        seedRound(db, [{ id: 12, name: 'Gone' }]);
        db.transaction(() => { archiveRound(db, { label: 'R1' }); wipe(db); })();

        ok('an archived player whose account no longer exists is still readable',
            db.prepare(`SELECT name FROM round_players WHERE player_id = 12`).get().name === 'Gone');
        ok('and previousNames finds them even with no live row',
            previousNames(db, 12).length === 1);
        // findByFormerName joins to players to answer "who are they now", so an id that
        // never came back has no current name — it must not drop the row.
        const found = findByFormerName(db, 'Gone');
        ok('the reverse lookup still returns them, with no current name',
            found.length === 1 && found[0].currentName === null, found);

        ok('deleting a round takes its rows with it',
            (db.prepare(`DELETE FROM rounds WHERE label = 'R1'`).run(),
             db.prepare(`SELECT COUNT(*) n FROM round_players`).get().n === 0));
        db.close();
    }

    console.log('\n── The search box only surfaces former names of players who still exist ' + '─'.repeat(1));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        // 39 renamed and is still around; 12 renamed and then the account was gone for good
        // (nuked and never came back). The search box should show the first, not the second —
        // a hit with no live account to open is noise, not a result.
        seedRound(db, [
            { id: 39, name: 'Elfenlied' },
            { id: 12, name: 'Ghost' },
        ]);
        db.transaction(() => { archiveRound(db, { label: 'R1' }); wipe(db); })();

        // Only 39 comes back for the new round.
        seedRound(db, [{ id: 39, name: 'Chewie' }]);

        const hit = searchFormerNamesWithCurrentPlayer(db, 'Elfen');
        ok('finds a former name for a player who currently still exists',
            hit.length === 1 && hit[0].id === 39 && hit[0].name === 'Chewie', hit);

        const noHit = searchFormerNamesWithCurrentPlayer(db, 'Ghost');
        ok('does not return a hit for a player id that no longer exists (p.id IS NOT NULL)',
            noHit.length === 0, noHit);

        ok('an empty query returns nothing', searchFormerNamesWithCurrentPlayer(db, '').length === 0);
        ok('a whitespace query too', searchFormerNamesWithCurrentPlayer(db, '   ').length === 0);
        db.close();
    }

    console.log('\n── Inputs that must not throw ' + '─'.repeat(45));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        seedRound(db, [{ id: 1, name: "O'Brien" }]);
        db.transaction(() => archiveRound(db, { label: "Beta '4" }))();

        ok('a name with an apostrophe survives the round trip',
            db.prepare(`SELECT name FROM round_players WHERE player_id = 1`).get().name === "O'Brien");
        ok('an empty query returns nothing rather than everything', findByFormerName(db, '').length === 0);
        ok('a whitespace query too', findByFormerName(db, '   ').length === 0);
        ok('a wildcard is treated as text, not as SQL', findByFormerName(db, '%').length >= 0);
        ok('a non-numeric player id returns no history', previousNames(db, 'abc').length === 0);
        ok('a missing player id returns no history', previousNames(db, undefined).length === 0);
        ok('an unknown round has no detail', roundDetail(db, 9999) === null);
        ok('a non-numeric round id has no detail', roundDetail(db, 'x') === null);

        const detail = roundDetail(db, listRounds(db)[0].id);
        ok('a known round returns its rows', detail && detail.playerRows.length === 1, detail);
        db.close();
    }

    console.log('\n── Archiving an empty database is not an error ' + '─'.repeat(29));
    {
        const { db, dir } = freshDb(); cleanup.push(dir);
        const r = db.transaction(() => archiveRound(db, { label: 'nothing here' }))();
        ok('it succeeds with zero rows', r.players === 0 && r.systems === 0, r);
        ok('and the round is still recorded, so the wipe is dated', listRounds(db).length === 1);
        db.close();
    }

    console.log('\n── The wipe path actually calls it ' + '─'.repeat(41));
    // A snapshot nothing invokes protects nothing.
    const admin = readCode('src/routes/admin.js');
    ok('nuke-intel archives before deleting',
        admin.indexOf('archiveRound(db') < admin.indexOf('playersRepo.deleteAllPlayers()')
        && admin.indexOf('archiveRound(db') !== -1, [admin.indexOf('archiveRound(db'), admin.indexOf('playersRepo.deleteAllPlayers()')]);
    ok('and it does so inside the same transaction as the deletes',
        /db\.transaction\(\(\) => \{[\s\S]{0,400}archiveRound\(db[\s\S]{0,400}fleetsRepo\.deleteAllFleets\(\)/.test(admin));
    ok('the admin panel can snapshot without wiping', /\/admin\/rounds\/archive/.test(admin));
    ok('and can list what has been archived', /router\.get\('\/admin\/rounds'/.test(admin));

    const intel = readCode('src/routes/intel.js');
    ok('the player intel response carries former names', /formerNames/.test(intel));
    ok('and there is a reverse lookup by old name', /\/intel\/former-names/.test(intel));

    const search = readCode('src/routes/search.js');
    ok('player search also matches names from earlier rounds',
        /searchFormerNamesWithCurrentPlayer\(db, q,/.test(search));

    const ui = readCode('public/js/ui/player-intel.js');
    ok('the panel renders them', /formerNames/.test(ui) && /previously/.test(ui));
    ok('through the escaper, since these are player-supplied strings',
        /esc\(f\.name\)/.test(ui));

    for (const dir of cleanup) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* best effort */ }
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
