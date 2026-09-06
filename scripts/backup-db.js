#!/usr/bin/env node
// Take a consistent backup of the hub's databases and configuration, verify it, prune old
// ones. Safe to run while the hub is up — it uses SQLite's online backup API, never cp.
//
//   node scripts/backup-db.js                       # to $AWT_BACKUP_DIR or ~/awt-backups
//   node scripts/backup-db.js --dest /mnt/backups   # elsewhere
//   node scripts/backup-db.js --keep 30             # retention (default AWT_BACKUP_KEEP or 14)
//   node scripts/backup-db.js --verify DIR          # re-check an existing backup, no new one
//   node scripts/backup-db.js --list                # what is in the destination
//
// Exit code is non-zero if the backup (or the verification) failed, so a cron line can
// alert on it. The full procedure — what is backed up, retention, permissions, restore
// order and rollback — is in docs/operations.md.

const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// Same anchoring as server.js: read .env from the project, not from the cwd cron runs in.
require('dotenv').config({ path: path.join(ROOT, '.env') });

const { createBackup, verifyBackup, listBackups } = require(path.join(ROOT, 'src', 'utils', 'db-backup'));

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}

const dest = arg('--dest', process.env.AWT_BACKUP_DIR || path.join(os.homedir(), 'awt-backups'));
const keep = Number(arg('--keep', process.env.AWT_BACKUP_KEEP === undefined ? 14 : process.env.AWT_BACKUP_KEEP));
const verifyDir = arg('--verify', null);
const list = process.argv.includes('--list');

(async () => {
    if (list) {
        const all = listBackups(dest);
        console.log(all.length ? all.join('\n') : `No backups under ${dest}`);
        return;
    }

    if (verifyDir) {
        const r = verifyBackup(verifyDir === true ? dest : verifyDir);
        for (const e of r.results) {
            const detail = e.verify ? ` — integrity ${e.verify.integrity || e.verify.error}, ${Object.keys(e.verify.counts).length} tables${e.countsMatch === false ? ', ROW COUNTS DIFFER FROM MANIFEST' : ''}` : '';
            console.log(`  ${e.ok ? 'ok ' : 'BAD'} ${e.name}${e.exists ? '' : ' (missing)'}${e.sha256Matches ? '' : ' (checksum differs)'}${detail}`);
        }
        console.log(r.ok ? 'Backup verified.' : 'BACKUP FAILED VERIFICATION.');
        process.exit(r.ok ? 0 : 1);
    }

    console.log(`[Backup] ${ROOT} -> ${dest} (keeping the newest ${keep > 0 ? keep : 'all'})`);
    const r = await createBackup({ rootDir: ROOT, destDir: dest, keep, log: console.log });
    for (const old of r.pruned) console.log(`  - pruned ${old}`);
    console.log(`[Backup] ${r.ok ? 'OK' : 'FAILED VERIFICATION'}: ${r.dir}`);
    process.exit(r.ok ? 0 : 1);
})().catch(err => {
    console.error(`[Backup] ${err.message}`);
    process.exit(1);
});
