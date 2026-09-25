#!/usr/bin/env node
// Measure what the battle-race card would show for every player without bio, on a COPY of
// the hub database (issue #282, "Measure first"). Read-only: the file is opened with
// SQLite's readonly flag, no migrations run, and nothing is saved.
//
//   node scripts/battle-race-measure.js /path/to/copy-of-awt.db
//   node scripts/battle-race-measure.js /path/to/copy-of-awt.db --universe redzone
//
// Prints counts only (players narrowed, skip reasons, the results saved by earlier
// versions as a baseline). No names, ids or report numbers, so the output can be posted
// on a public issue as-is. Do not point it at the live database file of a running hub:
// take a copy with scripts/backup-db.js first.

const path = require('path');
const Database = require('better-sqlite3');
const { measureBattleRace } = require(path.join(__dirname, '..', 'src', 'utils', 'battle-race-inputs'));

const file = process.argv[2];
if (!file || file.startsWith('--')) {
    console.error('Usage: node scripts/battle-race-measure.js <copy-of-awt.db> [--universe standard|redzone]');
    process.exit(2);
}
const flag = process.argv.indexOf('--universe');
const universe = flag === -1 ? 'standard' : process.argv[flag + 1];

const db = new Database(file, { readonly: true, fileMustExist: true });
try {
    console.log(JSON.stringify(measureBattleRace(db, { universe }), null, 2));
} catch (err) {
    // Read-only means no migrations: a file from before the battle-race columns cannot be read.
    if (/no such (column|table)/.test(err.message)) {
        console.error(`This database predates the battle-race schema (${err.message}). Measure a copy of a current hub database.`);
        process.exitCode = 1;
    } else {
        throw err;
    }
} finally {
    db.close();
}
