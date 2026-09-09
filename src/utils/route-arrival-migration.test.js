// Issue #163: adding target arrival must not rebuild or reinterpret saved route snapshots.
// Start from a hand-written pre-feature schema, then run the real database initializer
// twice against the same synthetic file. No production database or game data is used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-route-arrival-migration-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'legacy.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-migration-password';
const databasePath = require.resolve('../database');
let db;
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ok - ${name}`); }
    else { fail++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); }
}
function openMigrated() {
    delete require.cache[databasePath];
    return require(databasePath);
}
const routeRows = connection => connection.prepare('SELECT * FROM routes ORDER BY id').all();
const legRows = connection => connection.prepare('SELECT * FROM route_legs ORDER BY route_id, leg_index').all();
const oldRouteValues = rows => rows.map(({ target_arrival_at, ...oldValues }) => oldValues);

try {
    db = new Database(process.env.AWT_DB_PATH);
    db.pragma('foreign_keys = ON');
    // The tables below deliberately lack target_arrival_at. Stored durations/alliance
    // flags are observations from save time and must remain unchanged during migration.
    db.exec(`
        CREATE TABLE app_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, game_name TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, role TEXT DEFAULT 'user', is_active INTEGER DEFAULT 1
        );
        CREATE TABLE routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            author_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
            title TEXT, note TEXT, planned_start_at DATETIME,
            energy INTEGER DEFAULT 0, race_speed INTEGER DEFAULT 0,
            is_alliance_move INTEGER DEFAULT 0, biology INTEGER DEFAULT 0,
            visibility TEXT DEFAULT 'alliance', expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE route_legs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
            leg_index INTEGER NOT NULL, from_system_id INTEGER, from_planet_index INTEGER,
            to_system_id INTEGER, to_planet_index INTEGER,
            travel_seconds INTEGER DEFAULT 0, distance REAL DEFAULT 0,
            bio_needed INTEGER DEFAULT 0, is_alliance_move INTEGER DEFAULT 0
        );
        INSERT INTO app_users (id, game_name, password_hash, role)
            VALUES (7, 'SyntheticNavigator', 'not-a-real-password-hash', 'user');
        INSERT INTO routes
            (id, author_id, title, note, planned_start_at, energy, race_speed,
             is_alliance_move, biology, visibility, expires_at, created_at, updated_at)
            VALUES
            (31, 7, 'Synthetic two-hop route', 'Preserve the saved timing',
             '2026-10-25T00:30:00.000Z', 17, 3, 0, 9, 'alliance',
             '2026-10-26T12:00:00.000Z', '2026-09-01 10:00:00', '2026-09-02 11:00:00'),
            (32, 7, 'Synthetic unplanned route', NULL, NULL, 8, -2, 1, 4,
             'alliance', NULL, '2026-09-03 12:00:00', '2026-09-04 13:00:00');
        INSERT INTO route_legs
            (id, route_id, leg_index, from_system_id, from_planet_index,
             to_system_id, to_planet_index, travel_seconds, distance, bio_needed, is_alliance_move)
            VALUES
            (71, 31, 0, 501, 2, 502, 5, 2719, 4.5, 3, 0),
            (72, 31, 1, 502, 5, 503, 8, 881, 1.25, 2, 1),
            (73, 32, 0, 601, 1, 602, 11, 5432, 9.75, 4, 1);
    `);
    const oldRoutes = routeRows(db);
    const oldLegs = legRows(db);
    db.close();
    db = openMigrated();

    console.log('route-arrival-migration.test.js');
    let columns = db.pragma('table_info(routes)').filter(column => column.name === 'target_arrival_at');
    const migrated = columns.length === 1;
    ok('the legacy routes table gains exactly one nullable target_arrival_at column',
        migrated && columns[0].notnull === 0, columns);
    ok('old routes default to no target arrival instead of an invented schedule',
        routeRows(db).every(row => row.target_arrival_at === null));
    ok('every existing route value and ID survives the additive migration',
        JSON.stringify(oldRouteValues(routeRows(db))) === JSON.stringify(oldRoutes));
    ok('saved leg durations, alliance flags, coordinates, ordering and IDs survive unchanged',
        JSON.stringify(legRows(db)) === JSON.stringify(oldLegs));
    ok('existing author and leg foreign keys remain valid',
        db.pragma('foreign_key_check').length === 0
        && db.prepare('SELECT author_id FROM routes WHERE id=31').get().author_id === 7);

    // This UTC instant is inside the autumn DST overlap in Europe/Warsaw. The database
    // must preserve the instant verbatim, without interpreting it in the host timezone.
    const targetArrival = '2026-10-25T01:30:00.000Z';
    if (migrated) db.prepare('UPDATE routes SET target_arrival_at=? WHERE id=31').run(targetArrival);
    const newRouteId = Number(db.prepare('INSERT INTO routes (author_id, title) VALUES (?, ?)')
        .run(7, 'Synthetic route after migration').lastInsertRowid);
    ok('migration preserves route autoincrement state', newRouteId > 32, newRouteId);
    const afterFirstOpen = routeRows(db);
    db.close();
    db = openMigrated();

    columns = db.pragma('table_info(routes)').filter(column => column.name === 'target_arrival_at');
    ok('reopening the migrated database is idempotent and does not duplicate the column', columns.length === 1);
    ok('reopening preserves all route values, including newly saved target arrival',
        JSON.stringify(routeRows(db)) === JSON.stringify(afterFirstOpen));
    ok('a saved target arrival survives reopening as exactly the same UTC instant',
        db.prepare('SELECT * FROM routes WHERE id=31').get().target_arrival_at === targetArrival);
    ok('legacy and new routes without an arrival remain null after reopening',
        [32, newRouteId].every(id => db.prepare('SELECT * FROM routes WHERE id=?').get(id).target_arrival_at === null));
    ok('reopening still preserves every old leg and all foreign-key relationships',
        JSON.stringify(legRows(db)) === JSON.stringify(oldLegs) && db.pragma('foreign_key_check').length === 0);
} catch (error) {
    fail++;
    console.error('  NOT OK - migration test crashed:', error);
} finally {
    if (db && db.open) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
