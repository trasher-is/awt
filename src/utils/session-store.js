// Keeping the session store out of the intel database.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// The production error log showed:
//
//   Error: SQLITE_BUSY: database is locked
//   Error: SQLITE_BUSY: database is locked
//   Error: SQLITE_BUSY: database is locked
//   Error: SQLITE_BUSY: database is locked
//
// That wording identifies the driver. better-sqlite3 — our connection, in
// src/database.js — words it "database is locked" with the code on a separate property,
// and it already sets `busy_timeout = 10000`, so it waits rather than failing. The
// "SQLITE_BUSY: " prefix is node-sqlite3's, which is what connect-sqlite3 uses.
//
// So it is the SESSION store failing, and it was pointed at 'awt.db' — the same file the
// intel database writes to. A galaxy or system sync writes thousands of rows in one
// transaction and holds the write lock for its duration; connect-sqlite3 exposes no
// busy-timeout option, so a session write landing in that window fails immediately. A
// failed session write means a member's login silently does not persist — logged out
// mid-scan, for no visible reason.
//
// Sessions and intel have nothing to do with each other. Giving sessions their own file
// removes the contention entirely instead of tuning it: two files, two write locks.
//
// The copy below exists so nobody is logged out by the change. It runs once — the moment
// the new file exists it is a no-op — and it does not delete anything from the old
// database, so reverting this commit puts everyone back exactly where they were.

const fs = require('fs');
const Database = require('better-sqlite3');

// connect-sqlite3's own schema, from node_modules/connect-sqlite3/lib/connect-sqlite3.js:
//   CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)
const SESSION_TABLE = 'sessions';
const SESSION_SCHEMA = `CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (sid PRIMARY KEY, expired, sess)`;

/**
 * Move existing sessions from the intel database into their own file, once.
 *
 * Returns a short report rather than logging directly, so the caller decides what the
 * console says and a test can assert on it.
 */
function splitSessionsDatabase(legacyPath, targetPath, { now = Date.now() } = {}) {
    if (fs.existsSync(targetPath)) return { action: 'already-split', copied: 0 };
    if (!fs.existsSync(legacyPath)) return { action: 'no-legacy-database', copied: 0 };

    let rows = [];
    let legacy;
    try {
        legacy = new Database(legacyPath, { readonly: true });
        const hasTable = legacy
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
            .get(SESSION_TABLE);
        if (!hasTable) return { action: 'no-legacy-sessions', copied: 0 };

        // Expired rows are not worth carrying over; connect-sqlite3 stores the expiry as
        // milliseconds since the epoch.
        rows = legacy.prepare(`SELECT sid, expired, sess FROM ${SESSION_TABLE}`).all()
            .filter(r => !(Number(r.expired) > 0) || Number(r.expired) > now);
    } catch (err) {
        // A locked or unreadable legacy database must not stop the app from starting —
        // the worst case here is that everyone logs in again.
        return { action: 'legacy-unreadable', copied: 0, error: err.message };
    } finally {
        try { if (legacy) legacy.close(); } catch (err) { /* already closed */ }
    }

    let target;
    try {
        target = new Database(targetPath);
        target.pragma('journal_mode = WAL');
        target.exec(SESSION_SCHEMA);
        const insert = target.prepare(`INSERT OR REPLACE INTO ${SESSION_TABLE} VALUES (?, ?, ?)`);
        target.transaction(list => { for (const r of list) insert.run(r.sid, r.expired, r.sess); })(rows);
    } catch (err) {
        return { action: 'target-unwritable', copied: 0, error: err.message };
    } finally {
        try { if (target) target.close(); } catch (err) { /* already closed */ }
    }

    return { action: 'split', copied: rows.length };
}

module.exports = { splitSessionsDatabase, SESSION_TABLE, SESSION_SCHEMA };
