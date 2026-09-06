// Backups are consistent, verified, restorable — and the round archive survives them.
//
// Run with:  node src/utils/db-backup.test.js
//
// The hub had no backup command and no procedure (issue #134). awt.db is a WAL database,
// so a plain copy of the file misses every write still in the WAL; the round archives live
// inside that same file, so they protect against a wipe but not against losing the file.
//
// Everything here runs on a synthetic hub directory under a temp folder: a REAL schema
// (src/database.js, pointed at the temp file), synthetic rows, a fake .env and secret.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-backup-'));
const hubDir = path.join(tmp, 'hub');
fs.mkdirSync(hubDir);
process.env.AWT_DB_PATH = path.join(hubDir, 'awt.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic';
delete process.env.DISCORD_TOKEN;

const Database = require('better-sqlite3');
const db = require('../database');
const systemsRepo = require('../repositories/systems');
const usersRepo = require('../repositories/users');
const { archiveRound } = require('./round-archive');
const { SESSION_SCHEMA } = require('./session-store');
const backup = require('./db-backup');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const modeOf = p => fs.statSync(p).mode & 0o777;
const posix = process.platform !== 'win32';

// ─── A HUB WITH A PAST ─────────────────────────────────────────────────────────
// Two archived rounds, a live round, two accounts, a session, a config.
for (let round = 1; round <= 2; round++) {
    for (let i = 1; i <= 5; i++) systemsRepo.upsertSystemFull(i, `R${round} System ${i}`, i * round, -i);
    db.prepare(`INSERT OR REPLACE INTO players (id, name, points) VALUES (39, ?, ?)`).run(round === 1 ? 'Elfenlied' : 'Chewie', round * 1000);
    db.transaction(() => {
        archiveRound(db, { label: `Beta ${round}` });
        db.prepare(`DELETE FROM players`).run();
        db.prepare(`DELETE FROM systems`).run();
    })();
}
for (let i = 1; i <= 7; i++) systemsRepo.upsertSystemFull(i, `Live System ${i}`, i, i);
db.prepare(`INSERT INTO players (id, name, points) VALUES (39, 'Chewie', 5000)`).run();
usersRepo.createUser('Member', 'hash', 'user', null);
db.pragma('wal_checkpoint(PASSIVE)');
// Leave a write in the WAL on purpose: a naive file copy would not contain it.
db.prepare(`INSERT INTO app_settings (key, value) VALUES ('only_in_wal', 'yes')`).run();

const sessions = new Database(path.join(hubDir, 'sessions.db'));
sessions.pragma('journal_mode = WAL');
sessions.exec(SESSION_SCHEMA);
sessions.prepare(`INSERT INTO sessions VALUES ('sid-1', ?, '{"userId":1}')`).run(Date.now() + 86400000);
// kept open: a live hub holds this file too

fs.writeFileSync(path.join(hubDir, '.env'), 'PORT=3000\nSESSION_SECRET=\n');
fs.writeFileSync(path.join(hubDir, '.session-secret'), 'a'.repeat(96), { mode: 0o600 });
fs.writeFileSync(path.join(hubDir, 'config.json'), '{"logPath":"/tmp/x.log"}\n');

const expected = {
    rounds: 2, round_systems: 10, round_players: 2, systems: 7, players: 1,
    app_users: db.prepare(`SELECT COUNT(*) n FROM app_users`).get().n,
};

const dest = path.join(tmp, 'backups');
const T0 = new Date('2026-09-06T03:15:00Z');
const at = minutes => new Date(T0.getTime() + minutes * 60000);

(async () => {
    console.log('── A backup is consistent, complete and verified ' + '─'.repeat(27));
    const r1 = await backup.createBackup({ rootDir: hubDir, destDir: dest, now: T0, keep: 2 });
    ok('the backup succeeded and verified', r1.ok === true, r1.manifest);
    ok('it lives in a timestamped directory under the destination', path.basename(r1.dir) === 'awt-20260906-031500', r1.dir);
    const names = r1.manifest.files.map(f => f.name).sort();
    ok('it holds both databases and all three config files',
        JSON.stringify(names) === JSON.stringify(['.env', '.session-secret', 'awt.db', 'config.json', 'sessions.db']), names);
    ok('the manifest records a checksum per file', r1.manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));

    const awtEntry = r1.manifest.files.find(f => f.name === 'awt.db');
    ok('awt.db passed integrity_check', awtEntry.verify.integrity === 'ok', awtEntry.verify.integrity);
    ok('and has every required table', awtEntry.verify.missing.length === 0, awtEntry.verify.missing);
    ok('the manifest counts show the round archive and the live data',
        awtEntry.verify.counts.rounds === expected.rounds && awtEntry.verify.counts.round_systems === expected.round_systems
        && awtEntry.verify.counts.systems === expected.systems && awtEntry.verify.counts.app_users === expected.app_users,
        awtEntry.verify.counts);

    const copy = new Database(path.join(r1.dir, 'awt.db'), { readonly: true });
    ok('the write that only existed in the WAL is in the backup (cp would have lost it)',
        copy.prepare(`SELECT value FROM app_settings WHERE key = 'only_in_wal'`).get().value === 'yes');
    ok('the backup is a single self-contained file, not WAL',
        copy.pragma('journal_mode', { simple: true }) === 'delete'
        && !fs.existsSync(path.join(r1.dir, 'awt.db-wal')), copy.pragma('journal_mode', { simple: true }));
    ok('the archived name history is in it', copy.prepare(`SELECT name FROM round_players WHERE round_id = 1`).get().name === 'Elfenlied');
    copy.close();
    const sessCopy = new Database(path.join(r1.dir, 'sessions.db'), { readonly: true });
    ok('sessions.db was backed up while another connection held it open',
        sessCopy.prepare(`SELECT COUNT(*) n FROM sessions`).get().n === 1);
    sessCopy.close();

    if (posix) {
        ok('backup files are owner-only (0600)', r1.manifest.files.every(f => modeOf(path.join(r1.dir, f.name)) === 0o600)
            && modeOf(path.join(r1.dir, backup.MANIFEST)) === 0o600,
            r1.manifest.files.map(f => modeOf(path.join(r1.dir, f.name)).toString(8)));
        ok('the backup directory is owner-only (0700)', modeOf(r1.dir) === 0o700, modeOf(r1.dir).toString(8));
    }
    ok('re-verifying the backup in place agrees', backup.verifyBackup(r1.dir).ok === true);

    console.log('\n── The backup is independent of what happens to the source afterwards ' + '─'.repeat(5));
    db.prepare(`DELETE FROM systems`).run();
    db.prepare(`DELETE FROM rounds`).run();
    ok('the live database lost its rounds and systems', db.prepare(`SELECT COUNT(*) n FROM rounds`).get().n === 0);
    const copy2 = new Database(path.join(r1.dir, 'awt.db'), { readonly: true });
    ok('the backup still has them', copy2.prepare(`SELECT COUNT(*) n FROM rounds`).get().n === 2
        && copy2.prepare(`SELECT COUNT(*) n FROM systems`).get().n === 7);
    copy2.close();
    ok('and the source is still readable by the hub — nothing was written through the backup handle',
        db.prepare(`SELECT COUNT(*) n FROM app_users`).get().n === expected.app_users);

    console.log('\n── Restore into a separate location, verified ' + '─'.repeat(30));
    const restoreDir = path.join(tmp, 'restore-check');
    const rr = backup.restoreBackup({ backupDir: r1.dir, targetDir: restoreDir });
    ok('restore reports success', rr.written.includes('awt.db') && rr.written.includes('sessions.db'), rr.written);
    ok('secrets are NOT restored by default', !rr.secretsRestored && !fs.existsSync(path.join(restoreDir, '.env')));
    ok('the restored awt.db verifies with matching counts',
        rr.verify['awt.db'].ok && rr.verify['awt.db'].countsMatch, rr.verify['awt.db']);
    const restored = new Database(path.join(restoreDir, 'awt.db'), { readonly: true });
    ok('the round archive survived the round trip',
        restored.prepare(`SELECT COUNT(*) n FROM rounds`).get().n === expected.rounds
        && restored.prepare(`SELECT label FROM rounds ORDER BY id`).all().map(r => r.label).join(',') === 'Beta 1,Beta 2');
    ok('and the current data', restored.prepare(`SELECT COUNT(*) n FROM systems`).get().n === expected.systems
        && restored.prepare(`SELECT name FROM players WHERE id = 39`).get().name === 'Chewie');
    ok('and the accounts', restored.prepare(`SELECT COUNT(*) n FROM app_users`).get().n === expected.app_users);
    restored.close();
    ok('the restored database opens with the hub schema (src/database.js migrations are no-ops on it)', (() => {
        const d = new Database(path.join(restoreDir, 'awt.db'));
        try { d.exec(`ALTER TABLE app_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0`); return false; }
        catch (e) { return /duplicate column/.test(e.message); }
        finally { d.close(); }
    })());
    if (posix) ok('restored files are owner-only', modeOf(path.join(restoreDir, 'awt.db')) === 0o600);

    const withSecrets = backup.restoreBackup({ backupDir: r1.dir, targetDir: path.join(tmp, 'restore-full'), includeSecrets: true, includeSessions: false });
    ok('opting in restores the secrets too', withSecrets.secretsRestored && fs.existsSync(path.join(tmp, 'restore-full', '.session-secret')));
    ok('and opting out skips sessions', !withSecrets.sessionsRestored && !fs.existsSync(path.join(tmp, 'restore-full', 'sessions.db')));

    console.log('\n── Restore never overwrites a live or existing database by accident ' + '─'.repeat(8));
    let threw = null;
    try { backup.restoreBackup({ backupDir: r1.dir, targetDir: restoreDir }); } catch (e) { threw = e.message; }
    ok('restoring over an existing file without force is refused', /Refusing to overwrite/.test(threw || ''), threw);

    threw = null;
    try { backup.restoreBackup({ backupDir: r1.dir, targetDir: hubDir, force: true }); } catch (e) { threw = e.message; }
    ok('restoring over the RUNNING hub database is refused even with force (its -wal/-shm exist)',
        /-wal|-shm|has it open/.test(threw || ''), threw);
    ok('and it did not touch the live file', db.prepare(`SELECT COUNT(*) n FROM rounds`).get().n === 0);

    // Mark the file about to be replaced, so the aside copy can be told apart from the new one.
    const marked = new Database(path.join(restoreDir, 'awt.db'));
    marked.prepare(`INSERT INTO app_settings (key, value) VALUES ('before_force', 'yes')`).run();
    marked.close();
    const rr2 = backup.restoreBackup({ backupDir: r1.dir, targetDir: restoreDir, force: true });
    ok('force over a stopped (no -wal/-shm) database goes through', rr2.verify['awt.db'].ok);
    ok('the replaced files were moved aside, not deleted — that is the rollback',
        rr2.movedAside.length === 2 && rr2.movedAside.every(p => /\.pre-restore-\d{8}-\d{6}$/.test(p) && fs.existsSync(p)), rr2.movedAside);
    const aside = new Database(rr2.movedAside.find(p => /awt\.db\.pre-restore/.test(p)), { readonly: true });
    ok('and the aside copy is the file that was there before', aside.prepare(`SELECT value FROM app_settings WHERE key = 'before_force'`).get().value === 'yes');
    aside.close();
    const fresh = new Database(path.join(restoreDir, 'awt.db'), { readonly: true });
    ok('while the restored file is the backup', fresh.prepare(`SELECT value FROM app_settings WHERE key = 'before_force'`).get() === undefined);
    fresh.close();

    console.log('\n── A damaged backup is refused before it can be restored ' + '─'.repeat(19));
    const r2 = await backup.createBackup({ rootDir: hubDir, destDir: dest, now: at(1), keep: 5 });
    fs.writeFileSync(path.join(r2.dir, 'awt.db'), Buffer.from('this is not a database'));
    const v = backup.verifyBackup(r2.dir);
    ok('verification fails on the damaged copy', v.ok === false && v.results.find(x => x.name === 'awt.db').ok === false);
    threw = null;
    try { backup.restoreBackup({ backupDir: r2.dir, targetDir: path.join(tmp, 'never') }); } catch (e) { threw = e.message; }
    ok('restore refuses it', /failed verification/.test(threw || ''), threw);
    ok('and wrote nothing', !fs.existsSync(path.join(tmp, 'never', 'awt.db')));
    fs.rmSync(r2.dir, { recursive: true, force: true });

    console.log('\n── Retention keeps the newest N ' + '─'.repeat(43));
    const r3 = await backup.createBackup({ rootDir: hubDir, destDir: dest, now: at(2), keep: 2 });
    const r4 = await backup.createBackup({ rootDir: hubDir, destDir: dest, now: at(3), keep: 2 });
    const remaining = backup.listBackups(dest).map(p => path.basename(p));
    ok('three backups with keep=2 leaves the two newest',
        JSON.stringify(remaining) === JSON.stringify([path.basename(r3.dir), path.basename(r4.dir)]), remaining);
    ok('the oldest was reported as pruned', r4.pruned.length === 1 && r4.pruned[0] === r1.dir, r4.pruned);
    ok('keep <= 0 keeps everything', backup.pruneBackups(dest, 0).length === 0 && backup.listBackups(dest).length === 2);
    ok('a random directory under the destination is not mistaken for a backup', (() => {
        fs.mkdirSync(path.join(dest, 'notes'));
        return backup.listBackups(dest).length === 2;
    })());

    console.log('\n── Guard rails ' + '─'.repeat(60));
    threw = null;
    try { await backup.createBackup({ rootDir: hubDir, destDir: hubDir }); } catch (e) { threw = e.message; }
    ok('the destination may not be the hub directory itself', /must not be the hub directory/.test(threw || ''), threw);
    threw = null;
    try { await backup.createBackup({ rootDir: path.join(tmp, 'nowhere'), destDir: dest }); } catch (e) { threw = e.message; }
    ok('a missing database is an error, not an empty backup', /No database to back up/.test(threw || ''), threw);
    ok('timestamps are UTC and sortable', backup.timestampLabel(new Date('2026-01-02T03:04:05Z')) === '20260102-030405');

    console.log('\n── Operator scripts and documentation ' + '─'.repeat(37));
    const root = path.join(__dirname, '..', '..');
    const backupScript = fs.readFileSync(path.join(root, 'scripts', 'backup-db.js'), 'utf8');
    const restoreScript = fs.readFileSync(path.join(root, 'scripts', 'restore-db.js'), 'utf8');
    ok('scripts/backup-db.js drives this module', /require\(path\.join\(ROOT, 'src', 'utils', 'db-backup'\)\)/.test(backupScript) && /createBackup\(/.test(backupScript));
    ok('scripts/restore-db.js drives this module', /restoreBackup\(/.test(restoreScript));
    ok('the backup script honours AWT_BACKUP_DIR and AWT_BACKUP_KEEP', /AWT_BACKUP_DIR/.test(backupScript) && /AWT_BACKUP_KEEP/.test(backupScript));
    ok('the restore script requires an explicit target directory', /--to/.test(restoreScript) && /Usage:/.test(restoreScript));
    const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    ok('.env.example documents both variables', /^AWT_BACKUP_DIR=/m.test(env) && /^AWT_BACKUP_KEEP=/m.test(env));
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    ok('a backups/ folder inside the checkout could never be committed', /^backups\/$/m.test(gitignore));
    const ops = fs.readFileSync(path.join(root, 'docs', 'operations.md'), 'utf8');
    for (const [what, re] of [
        ['the backup command', /scripts\/backup-db\.js/],
        ['the restore command', /scripts\/restore-db\.js/],
        ['every file that matters', /awt\.db[\s\S]*sessions\.db[\s\S]*\.env[\s\S]*\.session-secret[\s\S]*config\.json/],
        ['retention', /retention|AWT_BACKUP_KEEP/i],
        ['file permissions', /0600|owner-only/],
        ['what happens to sessions on restore', /sessions?\.db[\s\S]{0,600}(log in again|fresh login|same session secret)/i],
        ['the restore order and rollback', /rollback/i],
        ['the rule about never validating on the live database', /never[\s\S]{0,120}(running|live)[\s\S]{0,120}database/i],
    ]) ok(`docs/operations.md covers ${what}`, re.test(ops));
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    ok('README points at the procedure', /docs\/operations\.md/.test(readme) && /backup/i.test(readme));

    sessions.close();
    db.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
