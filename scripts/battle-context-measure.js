#!/usr/bin/env node
// Read-only diagnostics against a COPY. No migrations, names, report/player ids,
// writes or game requests. Copy procedure: docs/operations.md.
const Database = require('better-sqlite3');
const { measureContext } = require('../src/utils/battle-context');
const file = process.argv[2];
if (!file || file.startsWith('--')) {
    console.error('Usage: node scripts/battle-context-measure.js <copy-of-awt.db>');
    process.exit(2);
}
const db = new Database(file, { readonly: true, fileMustExist: true });
try { console.log(JSON.stringify(measureContext(db), null, 2)); }
finally { db.close(); }
