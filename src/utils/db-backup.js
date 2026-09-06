// Consistent SQLite backups, and restores that are checked before anyone trusts them.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// Everything the hub knows lives in two SQLite files next to server.js: awt.db (intel,
// accounts, the round archive) and sessions.db (who is logged in). Both run in WAL mode,
// which means the database is awt.db PLUS awt.db-wal at any given moment — `cp awt.db`
// while the hub is running produces a file that is missing every write still in the WAL,
// and can be torn in the middle of a transaction. There was no backup command and no
// documented procedure (issue #134), and the round archives live INSIDE awt.db, so they
// protect against a wipe, not against losing the file.
//
// ─── WHAT THIS DOES ───────────────────────────────────────────────────────────
//   • Copies each database with SQLite's online backup API (better-sqlite3's db.backup),
//     which produces a consistent snapshot of a live database without stopping the hub,
//     then flattens the copy to a single self-contained file (journal_mode=DELETE) so a
//     backup is one file, not a file plus a WAL it has to be paired with.
//   • Copies .env, .session-secret and config.json alongside, because a database with no
//     session secret logs everyone out and a database with no .env has no configuration.
//   • Verifies every copy on the spot: PRAGMA integrity_check, the tables that must exist,
//     and a row count per table, all written into manifest.json next to the files.
//   • Restores ONLY into a directory the caller names, never over a database that has a
//     -wal or -shm sibling (that is a database something has open), and refuses to
//     overwrite an existing file without an explicit force. The restored copy is verified
//     again and its counts compared with the manifest before the restore is called done.
//   • Keeps the newest N backups and removes the rest; files are 0600, directories 0700.
//
// This module deliberately does NOT require src/database.js: it opens its own connections
// so the operator scripts can run against a hub that is up, and against a copy that is not
// the configured database at all.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_FILES = ['awt.db', 'sessions.db'];
const PLAIN_FILES = ['.env', '.session-secret', 'config.json'];
const MANIFEST = 'manifest.json';
const BACKUP_DIR_RE = /^awt-\d{8}-\d{6}$/;

// Tables that must be present for a copy of awt.db to be a hub database at all — the
// accounts, the map, the roster and the round archive. A backup missing any of these is
// not a backup of this application.
const REQUIRED_AWT_TABLES = ['app_users', 'systems', 'planets', 'players', 'rounds', 'round_players', 'round_systems'];
const REQUIRED_SESSION_TABLES = ['sessions'];

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function timestampLabel(date) {
    const d = date || new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    try { fs.chmodSync(dir, DIR_MODE); } catch (err) { /* not every filesystem honours modes */ }
}

function protect(filePath) {
    try { fs.chmodSync(filePath, FILE_MODE); } catch (err) { /* see ensureDir */ }
}

// A database "in use" has a -wal or -shm sibling. Restoring over it would corrupt whatever
// process has it open, and validating a restore must never touch a running hub's files.
function inUseSiblings(dbPath) {
    return ['-wal', '-shm'].map(s => dbPath + s).filter(p => fs.existsSync(p));
}

/**
 * Online backup of one SQLite file into `destPath`, flattened to a single file.
 * The source is opened read-write because a read-only handle on a WAL database whose -shm
 * does not exist yet cannot be opened at all; nothing is ever written through it.
 */
async function backupSqlite(srcPath, destPath) {
    const src = new Database(srcPath, { fileMustExist: true });
    try {
        src.pragma('busy_timeout = 10000');
        await src.backup(destPath);
    } finally {
        src.close();
    }
    // The page copy carries the source's WAL flag in its header. Switch the COPY to a
    // rollback journal so it is one self-contained file that can be opened read-only
    // anywhere, with no -wal/-shm siblings to lose.
    const copy = new Database(destPath);
    try {
        copy.pragma('journal_mode = DELETE');
    } finally {
        copy.close();
    }
    protect(destPath);
}

/**
 * Open a copy read-only and check it: integrity, required tables, a row count per table.
 * Never throws for a bad database — it reports, so the caller can decide and log.
 */
function verifySqlite(filePath, { requiredTables = [] } = {}) {
    const out = { ok: false, integrity: null, tables: [], missing: [], counts: {}, error: null };
    let db;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
        out.integrity = db.pragma('integrity_check', { simple: true });
        out.tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r => r.name);
        out.missing = requiredTables.filter(t => !out.tables.includes(t));
        for (const t of out.tables) {
            out.counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n;
        }
        out.ok = out.integrity === 'ok' && out.missing.length === 0;
    } catch (err) {
        out.error = err.message;
        out.ok = false;
    } finally {
        try { if (db) db.close(); } catch (err) { /* already closed */ }
    }
    return out;
}

function requiredTablesFor(name) {
    if (name === 'awt.db') return REQUIRED_AWT_TABLES;
    if (name === 'sessions.db') return REQUIRED_SESSION_TABLES;
    return [];
}

/**
 * Take one backup of everything under `rootDir` into a new timestamped directory below
 * `destDir`, verify it, write the manifest, then apply retention.
 *
 * @returns {Promise<{dir, label, manifest, ok, pruned: string[]}>}
 */
async function createBackup({ rootDir, destDir, now = new Date(), keep = 14, log = null } = {}) {
    if (!rootDir || !destDir) throw new Error('createBackup needs rootDir and destDir');
    const awtPath = path.join(rootDir, 'awt.db');
    if (!fs.existsSync(awtPath)) throw new Error(`No database to back up at ${awtPath}`);
    if (path.resolve(destDir) === path.resolve(rootDir) || path.resolve(destDir).startsWith(path.resolve(rootDir) + path.sep + 'public')) {
        throw new Error('The backup destination must not be the hub directory itself or anything it serves');
    }

    ensureDir(destDir);
    const label = timestampLabel(now);
    const dir = path.join(destDir, `awt-${label}`);
    if (fs.existsSync(dir)) throw new Error(`A backup already exists at ${dir} — two backups in the same second?`);
    fs.mkdirSync(dir, { mode: DIR_MODE });

    const say = msg => { if (log) log(msg); };
    const files = [];
    let ok = true;

    for (const name of DB_FILES) {
        const src = path.join(rootDir, name);
        if (!fs.existsSync(src)) { say(`  - ${name}: not present, skipped`); continue; }
        const dest = path.join(dir, name);
        await backupSqlite(src, dest);
        const verify = verifySqlite(dest, { requiredTables: requiredTablesFor(name) });
        ok = ok && verify.ok;
        files.push({ name, kind: 'sqlite', bytes: fs.statSync(dest).size, sha256: sha256File(dest), verify });
        say(`  - ${name}: ${verify.ok ? 'ok' : 'FAILED verification'} (${verify.tables.length} tables, integrity ${verify.integrity || verify.error})`);
    }

    for (const name of PLAIN_FILES) {
        const src = path.join(rootDir, name);
        if (!fs.existsSync(src)) { say(`  - ${name}: not present, skipped`); continue; }
        const dest = path.join(dir, name);
        fs.copyFileSync(src, dest);
        protect(dest);
        files.push({ name, kind: 'file', bytes: fs.statSync(dest).size, sha256: sha256File(dest) });
        say(`  - ${name}: copied`);
    }

    const manifest = {
        format: 1,
        createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
        host: os.hostname(),
        source: path.resolve(rootDir),
        ok,
        files,
    };
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: FILE_MODE });
    protect(path.join(dir, MANIFEST));

    // A backup that failed verification is kept (it may still be the best evidence of
    // what went wrong) but must never push a GOOD one out of the retention window.
    const pruned = ok ? pruneBackups(destDir, keep) : [];
    return { dir, label, manifest, ok, pruned };
}

/** Backup directories under `destDir`, oldest first. */
function listBackups(destDir) {
    if (!fs.existsSync(destDir)) return [];
    return fs.readdirSync(destDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && BACKUP_DIR_RE.test(e.name))
        .map(e => path.join(destDir, e.name))
        .sort();
}

/** Remove all but the newest `keep` backups. keep <= 0 means keep everything. */
function pruneBackups(destDir, keep) {
    const n = Number(keep);
    if (!Number.isFinite(n) || n <= 0) return [];
    const all = listBackups(destDir);
    const excess = all.slice(0, Math.max(0, all.length - n));
    for (const dir of excess) fs.rmSync(dir, { recursive: true, force: true });
    return excess;
}

function readManifest(backupDir) {
    const p = path.join(backupDir, MANIFEST);
    if (!fs.existsSync(p)) throw new Error(`Not a backup directory (no ${MANIFEST}): ${backupDir}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Re-verify a backup directory in place: every database it holds, against its manifest. */
function verifyBackup(backupDir) {
    const manifest = readManifest(backupDir);
    const results = [];
    let ok = true;
    for (const f of manifest.files) {
        const p = path.join(backupDir, f.name);
        const exists = fs.existsSync(p);
        const sha = exists ? sha256File(p) : null;
        const entry = { name: f.name, exists, sha256Matches: exists && sha === f.sha256 };
        if (f.kind === 'sqlite' && exists) {
            entry.verify = verifySqlite(p, { requiredTables: requiredTablesFor(f.name) });
            entry.countsMatch = f.verify && JSON.stringify(entry.verify.counts) === JSON.stringify(f.verify.counts);
            entry.ok = entry.sha256Matches && entry.verify.ok && entry.countsMatch !== false;
        } else {
            entry.ok = entry.sha256Matches;
        }
        ok = ok && entry.ok;
        results.push(entry);
    }
    return { ok, manifest, results };
}

/**
 * Restore a backup INTO `targetDir` — a separate location by default; the hub's own
 * directory only when the hub is stopped and the caller says `force`.
 *
 * Databases are copied by default; .env/.session-secret/config.json only with
 * `includeSecrets`, because the target machine usually has its own. Sessions are copied
 * unless `includeSessions` is false — and they only remain valid if the SAME session
 * secret is in place afterwards (SESSION_SECRET in .env, or .session-secret); otherwise
 * every member simply logs in again, which is the safe default.
 */
function restoreBackup({ backupDir, targetDir, force = false, includeSessions = true, includeSecrets = false, log = null } = {}) {
    if (!backupDir || !targetDir) throw new Error('restoreBackup needs backupDir and targetDir');
    const say = msg => { if (log) log(msg); };

    const check = verifyBackup(backupDir);
    if (!check.ok) {
        const bad = check.results.filter(r => !r.ok).map(r => r.name);
        throw new Error(`Refusing to restore: the backup failed verification (${bad.join(', ')}). Pick another backup.`);
    }

    const wanted = check.manifest.files.filter(f => {
        if (f.name === 'awt.db') return true;
        if (f.name === 'sessions.db') return includeSessions;
        return includeSecrets;
    });
    if (!wanted.some(f => f.name === 'awt.db')) throw new Error('This backup holds no awt.db');

    ensureDir(targetDir);

    // Every guard runs BEFORE the first byte is written, so a refusal leaves the target
    // exactly as it was.
    for (const f of wanted) {
        const dest = path.join(targetDir, f.name);
        if (f.kind === 'sqlite') {
            const live = inUseSiblings(dest);
            if (live.length) {
                throw new Error(`Refusing to restore over ${dest}: ${live.map(p => path.basename(p)).join(' and ')} exist, so a process has it open. Stop the hub first; remove the -wal/-shm files only once you are sure nothing holds the database.`);
            }
        }
        if (fs.existsSync(dest) && !force) {
            throw new Error(`Refusing to overwrite ${dest}. Restore into an empty directory, or pass force after stopping the hub.`);
        }
    }

    // With force, whatever is being replaced is moved aside first, never deleted: the
    // `.pre-restore-<stamp>` files ARE the rollback, and they exist even when the operator
    // skipped the manual step in docs/operations.md.
    const stamp = timestampLabel(new Date());
    const written = [];
    const movedAside = [];
    for (const f of wanted) {
        const src = path.join(backupDir, f.name);
        const dest = path.join(targetDir, f.name);
        if (fs.existsSync(dest)) {
            const aside = `${dest}.pre-restore-${stamp}`;
            fs.renameSync(dest, aside);
            movedAside.push(aside);
            say(`  - ${f.name}: existing file kept as ${path.basename(aside)}`);
        }
        fs.copyFileSync(src, dest);
        protect(dest);
        written.push(f.name);
        say(`  - ${f.name}: restored`);
    }

    // Verify what was actually written, against what the manifest promised.
    const verify = {};
    let ok = true;
    for (const f of wanted.filter(f => f.kind === 'sqlite')) {
        const v = verifySqlite(path.join(targetDir, f.name), { requiredTables: requiredTablesFor(f.name) });
        const countsMatch = JSON.stringify(v.counts) === JSON.stringify(f.verify.counts);
        verify[f.name] = Object.assign(v, { countsMatch });
        ok = ok && v.ok && countsMatch;
        say(`  - ${f.name}: ${v.ok && countsMatch ? 'verified — integrity ok, row counts match the manifest' : 'VERIFICATION FAILED'}`);
    }
    if (!ok) throw new Error('The restored files did not verify. Do not start the hub on them.');

    return {
        targetDir, written, movedAside, verify, manifest: check.manifest,
        sessionsRestored: written.includes('sessions.db'),
        secretsRestored: written.some(n => PLAIN_FILES.includes(n)),
    };
}

module.exports = {
    createBackup, listBackups, pruneBackups, verifyBackup, verifySqlite, restoreBackup,
    backupSqlite, timestampLabel, inUseSiblings,
    DB_FILES, PLAIN_FILES, MANIFEST, REQUIRED_AWT_TABLES, REQUIRED_SESSION_TABLES, FILE_MODE, DIR_MODE,
};
