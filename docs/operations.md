# Operations

What the person running the hub needs to know that is not about the game: what a round
reset removes, and how to back the database up and prove the backup restores.

## Round-scoped records

"Nuke data" in the admin panel (`POST /hub-api/admin/nuke-intel`, `src/routes/admin.js`)
ends a round. It takes a snapshot into the round archive first and then deletes, in one
SQLite transaction, everything that only means something on **this round's map**. If any
step fails — the snapshot included — nothing is deleted.

The map reshuffles between rounds but **system ids come back**. Anything keyed by a system
or planet id that survives a reset silently reattaches to the new map: a route from last
round shows this round's coordinates with last round's travel times, an old takeover
assignment appears on a planet nobody assigned. That is why the list below is explicit
rather than "whatever cascades from `systems`".

| Table | Round-scoped? | Why |
|---|---|---|
| `systems`, `planets`, `planet_events`, `best_guarded` | **removed** | the map itself |
| `players`, `player_name_history`, `player_logins` | **removed** | the roster of this round (who they *were* is kept in the archive) |
| `alliances`, `alliance_member_stats` | **removed** | this round's alliances; member stats are keyed by the stable player id and would otherwise rejoin as "Unknown" |
| `fleets` | **removed** | positions on the wiped map |
| `planet_plans` | **removed** | notes about planets on the wiped map (cascades from `systems`) |
| `routes`, `route_legs` | **removed** (since #128) | plans over system ids that the next round reuses |
| `planet_takeovers` | **removed** (since #128) | assignments keyed by `(system_id, planet_index)`, no foreign key to `systems` |
| `system_claims` | **removed** | territory earmarks for this round's map (cascades from `systems`) |
| `battle_reports`, `news_events` | **removed** | battles and conquests on the wiped map |
| `incoming_alerts`, `incoming_msgs` | **removed** | keyed by attack identities of this round |
| `trade_agreements` | **removed** | pairs of this round's player names |
| `app_users`, `discord_link_codes` | kept | accounts and their Discord links |
| `app_settings`, `alliance_broadcasts` | kept | hub configuration and announcements |
| `discord_timers` | kept | a member's `!timer` is not about the map |
| `rz_plans` | kept | the RedZone planner is a different game |
| `starbase_order_audit` | kept | an operations record of who sent what through the hub |
| `rounds`, `round_players`, `round_systems` | kept, **grows by one** | the archive the reset writes to |

The regression test for this list is `src/routes/admin-round-reset.test.js`: it seeds a
round, runs the real reset endpoint, reseeds the same system ids and checks that nothing
from the previous round is visible through the route and takeover endpoints. When a table
is added to the schema, decide which row of this table it belongs in and, if it is
round-scoped, add its delete to the reset transaction **after** `archiveRound`.

## Backup and restore

### What has to be backed up

Everything the hub knows is in the project directory, next to `server.js`:

| File | What it holds | Lose it and… |
|---|---|---|
| `awt.db` | intel, accounts, settings, **the round archive** | everything is gone, including the history of who was who |
| `sessions.db` | who is logged in | everyone logs in again (harmless) |
| `.env` | configuration, optionally `SESSION_SECRET` | the hub boots on defaults; with `SESSION_SECRET` gone, everyone logs in again |
| `.session-secret` | the generated session secret when `SESSION_SECRET` is not set | everyone logs in again |
| `config.json` | optional local overrides (`logPath`) | the admin log viewer looks in the default place |

Both databases run in **WAL mode**: at any moment the database is `awt.db` *plus*
`awt.db-wal`. Copying `awt.db` alone while the hub runs produces a file missing every write
still in the WAL, possibly torn mid-transaction. `cp`, `rsync` and snapshot tools that do
not know SQLite are **not** a backup of a live hub. The round archive is inside `awt.db`,
so it protects against a round wipe — not against losing the file.

### Taking a backup

```bash
node scripts/backup-db.js                    # -> $AWT_BACKUP_DIR, or ~/awt-backups
node scripts/backup-db.js --dest /mnt/backup --keep 30
```

Safe while the hub is up. The script uses SQLite's **online backup API** for both databases
(a consistent snapshot, WAL included), flattens each copy to a single self-contained file,
copies the three configuration files, and writes `manifest.json` with a SHA-256 per file,
`PRAGMA integrity_check`, the table list and a row count per table. Files are `0600`,
directories `0700`. The exit code is non-zero if anything failed verification, so a cron
line can alert on it:

```cron
17 3 * * *  cd /root/awt && /usr/bin/node scripts/backup-db.js >> /var/log/awt-backup.log 2>&1
```

**Destination.** Set `AWT_BACKUP_DIR` in `.env` (or pass `--dest`) to a directory
**outside this checkout** — this repository is public, and a backup contains every member's
account, the intel database and the session secret. The script refuses to write into the
project directory. Copy the backup directory off the machine as well; a backup on the same
disk as the database protects against mistakes, not against the disk.

**Retention.** `AWT_BACKUP_KEEP` (default 14, `--keep` overrides, `0` keeps everything).
Pruning only runs after a *successful* backup, so a failed one never pushes a good one out.

**Checking an old backup:** `node scripts/backup-db.js --verify ~/awt-backups/awt-20260906-031500`
re-computes checksums, integrity and row counts against the manifest.

### Restoring

The rule: **never validate a restore on the running production database.** Restore into a
separate directory first, look at it, and only then decide to put it live.

```bash
# 1. Validate: restore into scratch space and let the script verify it.
node scripts/restore-db.js ~/awt-backups/awt-20260906-031500 --to /tmp/awt-check
#    -> integrity ok, required tables present, row counts equal to the manifest,
#       and how many archived rounds / accounts / systems it holds.

# 2. Optional: look inside.
sqlite3 /tmp/awt-check/awt.db 'SELECT id, label, archived_at FROM rounds;'

# 3. Put it live — restore order matters:
pm2 stop awt                                          # a. stop the hub (nothing may hold awt.db)
node scripts/restore-db.js ~/awt-backups/awt-20260906-031500 --to /root/awt --force  # b. databases
#    the files being replaced are moved aside as awt.db.pre-restore-<stamp> etc., never deleted;
#    add --with-secrets to also restore .env, .session-secret and config.json
pm2 start awt                                         # c. start, then check the admin panel
```

The restore script **refuses**, with or without `--force`, while `awt.db-wal` or
`awt.db-shm` exist next to the target: those files mean a process still has the database
open. (Once every connection has closed cleanly, SQLite removes both files — so their
absence means "nothing has it open right now", not "this is not the production
directory". `--force` is what says you mean it.) It also refuses to overwrite an existing
file unless `--force` is given, and it refuses a backup that fails verification. Every
check runs before the first byte is written, so a refusal leaves the target untouched, and
with `--force` every replaced file is renamed to `<name>.pre-restore-<stamp>` first.

**Sessions.** `sessions.db` is restored by default (`--no-sessions` skips it). Restored
sessions are only valid if the **same session secret** is in place afterwards —
`SESSION_SECRET` in `.env`, or the `.session-secret` file. On the same machine that is
already true. On a fresh machine without `--with-secrets`, or after rotating the secret,
every member simply logs in again; nothing else is lost. Restoring sessions is a
convenience, not a requirement.

**Rollback.** The `<name>.pre-restore-<stamp>` files the restore leaves next to the
database *are* the rollback: stop the hub, move them back over the restored files, start the
hub. Do not delete them until the restored hub has been used for a while.

### What the test proves

`src/utils/db-backup.test.js` builds a synthetic hub directory with the real schema, two
archived rounds, live data, a write that exists only in the WAL, an open `sessions.db` and
the three config files; backs it up; damages the source; restores into a separate directory
and checks that the round archive, the current data and the accounts all came back with the
same row counts. It also checks that a restore over a database with `-wal`/`-shm` siblings
is refused, that a damaged backup is refused, and that retention keeps the newest N.
