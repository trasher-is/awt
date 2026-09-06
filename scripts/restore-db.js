#!/usr/bin/env node
// Restore a backup taken by scripts/backup-db.js INTO A DIRECTORY YOU NAME, and verify it.
//
//   node scripts/restore-db.js ~/awt-backups/awt-20260906-031500 --to /tmp/awt-check
//       Restore into a scratch directory and verify: integrity, schema, row counts against
//       the manifest. This is the validation step — it never touches the running hub.
//
//   node scripts/restore-db.js ~/awt-backups/awt-20260906-031500 --to /root/awt --force
//       The real thing. Stop the hub first (pm2 stop awt). Refused, force or not, while
//       awt.db-wal/-shm exist next to the target — those mean a process still has it open.
//
//   --no-sessions    do not restore sessions.db (everyone logs in again)
//   --with-secrets   also restore .env, .session-secret and config.json from the backup
//
// Sessions restored from sessions.db are only valid if the SAME session secret is in place
// afterwards (SESSION_SECRET in .env, or .session-secret). Without --with-secrets on a
// fresh machine, members log in again — the safe default. Full procedure, restore order and
// rollback: docs/operations.md.

const path = require('path');

const ROOT = path.join(__dirname, '..');
const { restoreBackup } = require(path.join(ROOT, 'src', 'utils', 'db-backup'));

const args = process.argv.slice(2);
const backupDir = args.find(a => !a.startsWith('--'));
const toIdx = args.indexOf('--to');
const targetDir = toIdx !== -1 ? args[toIdx + 1] : null;

if (!backupDir || !targetDir || targetDir.startsWith('--')) {
    console.error('Usage: node scripts/restore-db.js <backup-dir> --to <target-dir> [--force] [--no-sessions] [--with-secrets]');
    process.exit(2);
}

try {
    console.log(`[Restore] ${backupDir} -> ${targetDir}`);
    const r = restoreBackup({
        backupDir,
        targetDir,
        force: args.includes('--force'),
        includeSessions: !args.includes('--no-sessions'),
        includeSecrets: args.includes('--with-secrets'),
        log: console.log,
    });
    const awt = r.verify['awt.db'];
    console.log(`[Restore] OK. awt.db: integrity ${awt.integrity}, ${awt.tables.length} tables, ` +
        `${awt.counts.rounds || 0} archived rounds, ${awt.counts.app_users || 0} accounts, ${awt.counts.systems || 0} systems.`);
    console.log(r.sessionsRestored
        ? '[Restore] sessions.db restored — logins survive only if the same session secret is in place.'
        : '[Restore] sessions.db not restored — every member logs in again.');
    if (r.movedAside.length) {
        console.log(`[Restore] Replaced files were kept for rollback:\n${r.movedAside.map(p => `    ${p}`).join('\n')}`);
    }
    if (path.resolve(targetDir) === path.resolve(ROOT)) {
        console.log('[Restore] This is the hub directory: start the hub (pm2 start awt) and check the admin panel.');
    } else {
        console.log('[Restore] Verified in a separate location. To put it live: stop the hub, move these files into place, start the hub.');
    }
} catch (err) {
    console.error(`[Restore] ${err.message}`);
    process.exit(1);
}
