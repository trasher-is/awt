// 2026-10-08: strongest_fleet goes from one row per player to one row per fleet, and the
// migration repairs rows the old scraper wrote one column to the right after the ranking
// page gained a Planet column. Starts from a hand-written player-keyed table holding real
// rows copied from production (as stored, shifted), runs the real initializer twice.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-strongest-fleet-migration-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'legacy.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-migration-password';
const databasePath = require.resolve('../database');
let db;
let fail = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { fail++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); }
}
function openMigrated() {
    delete require.cache[databasePath];
    return require(databasePath);
}

console.log('strongest-fleet-migration.test.js');

try {
    db = new Database(process.env.AWT_DB_PATH);
    db.exec(`
        CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, alliance_id INTEGER);
        INSERT INTO players (id, name) VALUES (19, 'Moardin25'), (177, 'Thanatos'), (426, 'mirador'), (396, 'Acquario'), (500, 'Garbled');
        CREATE TABLE strongest_fleet (
            player_id INTEGER PRIMARY KEY,
            rank INTEGER NOT NULL,
            destroyers INTEGER NOT NULL DEFAULT 0,
            cruisers INTEGER NOT NULL DEFAULT 0,
            battleships INTEGER NOT NULL DEFAULT 0,
            cv INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
        );
        -- player_id, rank, destroyers, cruisers, battleships, cv, updated_at, exactly as stored
        INSERT INTO strongest_fleet VALUES
            (19, 4, 1482, 142, 29, 8, '2026-10-08T23:33:06.417Z'),   -- shifted: 1482 CV = 142 DS / 29 CR / 6 BS at #8
            (177, 1, 9108, 1916, 45, 7, '2026-10-08T13:30:51.796Z'), -- shifted, 38 BS lost in the shift
            (426, 7, 906, 6, 37, 11, '2026-10-08T13:30:51.796Z'),    -- shifted, no BS
            (396, 31, 61, 0, 0, 183, '2026-10-03T04:28:40.610Z'),    -- written before the layout change, correct
            (500, 9, 100, 7, 0, 5, '2026-10-08T13:30:51.796Z');      -- adds up neither way
    `);
    db.close();

    db = openMigrated();
    const rows = db.prepare(`SELECT player_id, rank, destroyers, cruisers, battleships, cv, system_id, planet_index, planet_label, updated_at FROM strongest_fleet ORDER BY player_id`).all();
    const byPlayer = Object.fromEntries(rows.map(r => [r.player_id, r]));
    ok('the table is per-fleet now (an id key, player_id no longer the primary key)',
        db.prepare(`PRAGMA table_info(strongest_fleet)`).all().some(c => c.name === 'id' && c.pk === 1));
    ok('a shifted row is put back in the right columns, battleships recovered from the CV',
        byPlayer[19] && byPlayer[19].cv === 1482 && byPlayer[19].destroyers === 142 && byPlayer[19].cruisers === 29 && byPlayer[19].battleships === 6, byPlayer[19]);
    ok('Thanatos: 9108 CV = 1916 DS / 45 CR / 38 BS',
        byPlayer[177] && byPlayer[177].destroyers === 1916 && byPlayer[177].cruisers === 45 && byPlayer[177].battleships === 38, byPlayer[177]);
    ok('mirador: 906 CV = 6 DS / 37 CR / 0 BS',
        byPlayer[426] && byPlayer[426].destroyers === 6 && byPlayer[426].cruisers === 37 && byPlayer[426].battleships === 0, byPlayer[426]);
    ok('a row that already adds up is kept as it was',
        byPlayer[396] && byPlayer[396].cv === 183 && byPlayer[396].destroyers === 61, byPlayer[396]);
    ok('a row that adds up neither way is dropped', !byPlayer[500], byPlayer[500]);
    ok('repaired rows keep their rank and timestamp, with no location (the system was never captured)',
        byPlayer[19].rank === 4 && byPlayer[19].updated_at === '2026-10-08T23:33:06.417Z'
        && byPlayer[19].system_id === null && byPlayer[19].planet_label === null, byPlayer[19]);

    db.prepare(`INSERT INTO strongest_fleet (player_id, rank, destroyers, cruisers, battleships, cv, updated_at) VALUES (19, 40, 10, 0, 0, 30, 'x')`).run();
    ok('a player can now hold two rows', db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet WHERE player_id = 19`).get().n === 2);

    db.close();
    db = openMigrated();
    ok('a second start changes nothing', db.prepare(`SELECT COUNT(*) AS n FROM strongest_fleet`).get().n === 5);
} catch (err) {
    fail++;
    console.error('  NOT OK - migration test crashed:', err);
} finally {
    if (db && db.open) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (fail > 0) {
    console.error(`${fail} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
