# Database Refactor: battleReports (domain 9 of 9 — final domain)

## Goal

Extract the genuinely scattered raw `db.prepare(...)` calls against `battle_reports` (outside
its existing ingest module) into a new `src/repositories/battleReports.js`, following the
pattern established by all eight prior domains.

This is the LAST domain in the database-call refactor project.

## Spec

Reference: `docs/superpowers/specs/2026-08-27-database-refactor-design.md`. Note: that spec
originally described this domain as "schema-only, population logic deferred to a future
API-integration project." That API-integration project has since been merged (mid-session,
domains 1-2 of this refactor), so real call sites now exist. This plan supersedes that
outdated assumption with the actual current state of the code.

## Scope decision — `src/utils/battle-reports.js` is NOT touched (same reasoning as round-archive.js)

`src/utils/battle-reports.js` already centralizes the report-mapping and idempotent-upsert
logic behind three exported functions (`mapApiReport`, `upsertReports`, `formatBattleEmbed`).
`upsertReports(db, rows)` takes `db` as an explicit parameter (dependency injection), exactly
like `src/utils/round-archive.js`'s functions from domain 8 — and for the identical reason:
its test file, `src/utils/battle-reports.test.js`, builds its own minimal synthetic
`better-sqlite3` database (a hand-copied `battle_reports` schema, not the full production
schema) and passes it directly into `upsertReports`. Converting this function to the
direct-`require('../database')` convention used by `src/repositories/*.js` modules would
break that test's ability to inject a synthetic schema, for zero benefit — the SQL is
already centralized in one module.

**Ruling (pre-flight): leave `src/utils/battle-reports.js` and its three exported functions
exactly as they are.** Do not touch this file, do not migrate `upsertReports` into
`src/repositories/battleReports.js`, do not change its `db`-parameter convention, do not
touch its own upsert/mapping/formatting tests in `battle-reports.test.js` (lines 1-184 —
the mapping, upsert-idempotency, and embed-formatting test blocks). Only ONE check near the
bottom of that test file needs a source-text update (see Task 2 below) because it inspects
`admin.js`'s raw SQL text, which genuinely moves.

## Call sites — genuinely scattered (this domain's actual scope)

### `src/routes/admin.js` — inside the `nukeTx` round-nuke transaction

1. **Line 314** (inside `nukeTx`, between `systemsRepo.deleteAllPlanetEvents()` and
   `systemsRepo.deleteAllPlanets()`):
   ```js
   db.prepare(`DELETE FROM battle_reports`).run();
   ```
   No WHERE clause, no params. This is the one raw SQL line in `nukeTx` not yet routed
   through a repository — every other statement in that transaction already calls a repo
   function (`fleetsRepo.deleteAllFleets()`, `plansRepo.deleteAllPlans()`,
   `systemsRepo.deleteAllPlanetEvents()`, `systemsRepo.deleteAllPlanets()`,
   `playersRepo.deleteAllPlayers()`, `alliancesRepo.deleteAllAlliances()`,
   `systemsRepo.deleteAllSystems()`, plus `archiveRound(db, {...})`). `starbase_order_audit`
   is deliberately NOT deleted here (a permanent operations log, not round data) — do not
   touch that table or its comment.

### `src/routes/sync.js` — inside `POST /sync/battle-reports`

2. **Lines 520-521** — pending-announcements read:
   ```js
   const pending = db.prepare(
       `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`).all();
   ```
   Not in a transaction (guarded by an outer `if (settingValue('discord_battlereport_channel'))`).
3. **Line 523** — mark-announced statement (prepared here, executed per-row in #4's transaction):
   ```js
   const markAnnounced = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
   ```
4. **Lines 547-548** — the flip transaction:
   ```js
   const flip = db.transaction((ids) => { for (const id of ids) markAnnounced.run(id); });
   flip(pending.map(r => r.id));
   ```
   This transaction touches ONLY `battle_reports` (repeated `markAnnounced.run(id)` calls) —
   no other table.
5. **Line 554** — newest-timestamp read (the dashboard scheduler's `BattleDateFrom` cursor):
   ```js
   const newest = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`).get().newest || null;
   ```
   Not in a transaction.

## Out of scope — `starbase_order_audit`

`src/routes/sync.js`'s `POST /sync/starbase-audit` handler (lines ~567-593) has one raw
`INSERT INTO starbase_order_audit` call site. This is a genuinely different table with no
relationship to `battle_reports` (confirmed: no FK, explicitly excluded from the round-nuke
per a comment in `admin.js`, survives round wipes while `battle_reports` does not). **Do not
touch this call site or this table as part of this domain.** It is out of scope for the
entire refactor project as currently planned (the original migration order the user
approved never named it) — leave it exactly as-is.

## Global Constraints

**No transaction changes.** The `flip` transaction (call site #4) stays in `sync.js`
exactly as it is — only the individual `markAnnounced.run(id)` statement (call site #3)
moves into a repository function; the loop and the `db.transaction(...)` wrapper remain in
`sync.js`. Similarly, `nukeTx` in `admin.js` stays in `admin.js` — only call site #1 moves.

**`db` require stays in both files.** `admin.js` needs `db` for `nukeTx`'s wrapper and
`archiveRound(db, {...})`. `sync.js` needs `db` for `upsertReports(db, rows)` (unchanged,
per the scope decision above) and the `flip` transaction wrapper. Do not remove either
file's `db` require.

**No added try/catch inside the repository module** — matching every prior domain.

**Known test breakage to fix (source-text regex, the same recurring pattern hit in domains
1, 4, and 8):** `src/utils/battle-reports.test.js` lines 189-194 do a source-text check on
`admin.js`:
```js
const admin = readCode('src/routes/admin.js');
ok('the round wipe clears battle reports', /DELETE FROM battle_reports/.test(admin));
ok('inside the same transaction as the other deletes',
    admin.indexOf('DELETE FROM battle_reports') > admin.indexOf('archiveRound(db')
    && admin.indexOf('DELETE FROM battle_reports') < admin.indexOf('nukeTx()'),
    [admin.indexOf('archiveRound(db'), admin.indexOf('DELETE FROM battle_reports'), admin.indexOf('nukeTx()')]);
```
Once call site #1 becomes `battleReportsRepo.deleteAllBattleReports();`, the literal string
`DELETE FROM battle_reports` no longer appears in `admin.js`, breaking both checks. Task 2
below fixes this by retargeting the regex/`indexOf` calls at the new call site's text
(`battleReportsRepo.deleteAllBattleReports()`), preserving the REAL property under test
(the wipe happens after the archive snapshot and before the transaction closes) rather than
weakening it. This is exactly the "retarget without weakening" pattern from every prior
domain's equivalent fix — do not simply delete the check or make it vacuous.

**Verification technique:** every call site above was independently re-read directly from
source (full-file or targeted reads of `battle-reports.js`, `admin.js`'s nukeTx block,
`sync.js`'s battle-reports and starbase-audit handlers, `battle-reports.test.js` in full)
before writing this plan, in addition to an extraction agent's initial full-file search
across all of `src/`. Confirmed `battle_report_units` does not exist as a table anywhere in
the codebase — do not create functions for it. Do not re-scan for more call sites.

## File Structure

- `src/repositories/battleReports.js` (new) + `src/repositories/battleReports.test.js` (new)
- `src/routes/admin.js` (migrate call site #1)
- `src/routes/sync.js` (migrate call sites #2, #3, #4 [statement only, transaction stays], #5)
- `src/utils/battle-reports.test.js` (retarget the one source-text check for #1's new location)

## Task 1: Create `src/repositories/battleReports.js` and its smoke test

Create `src/repositories/battleReports.js`:

```js
const db = require('../database');

const deleteAllBattleReportsStmt = db.prepare(`DELETE FROM battle_reports`);
function deleteAllBattleReports() {
    return deleteAllBattleReportsStmt.run().changes;
}

const getPendingAnnouncementsStmt = db.prepare(
    `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`
);
function getPendingAnnouncements() {
    return getPendingAnnouncementsStmt.all();
}

const markAnnouncedStmt = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
function markAnnounced(id) {
    markAnnouncedStmt.run(id);
}

const getNewestStartedAtStmt = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`);
function getNewestStartedAt() {
    return getNewestStartedAtStmt.get().newest || null;
}

module.exports = { deleteAllBattleReports, getPendingAnnouncements, markAnnounced, getNewestStartedAt };
```

Note `getNewestStartedAt` returns the already-unwrapped `|| null` value directly (matching
what the original inline call site computed), unlike `getPendingAnnouncements` which returns
the raw row array — preserve this exact shape since `sync.js`'s `res.json({..., newest_started_at: newest})`
expects the unwrapped value, not a row object.

Create `src/repositories/battleReports.test.js` following the exact style of
`src/repositories/discordTimers.test.js` / `src/repositories/incoming.test.js` (temp DB via
`AWT_DB_PATH`, plain `ok()` helper, `process.exit(1)` on failure, `fs.rmSync` cleanup at the
end). You will need to insert `battle_reports` rows directly via raw `db.prepare(...)` in the
test setup (matching the real schema's columns — check `src/database.js`'s
`CREATE TABLE IF NOT EXISTS battle_reports` block for the minimal required columns, at least
`id`, `started_at`, `announced`). Exercise:
- `getPendingAnnouncements()` returns `[]` when no rows exist.
- Insert several rows with `announced = 0` and varying `started_at`; confirm
  `getPendingAnnouncements()` returns them ordered by `started_at ASC, id ASC` (seed with
  out-of-order ids so this actually tests the ORDER BY, not insertion order).
- `markAnnounced(id)` flips exactly that row's `announced` to `1`; confirm via
  `getPendingAnnouncements()` no longer including it, while another still-pending row does.
- `getNewestStartedAt()` returns `null` when the table is empty; after inserting rows with
  different `started_at` values, returns the latest one (string comparison order, matching
  the original `MAX(started_at)` behavior on ISO-string timestamps).
- `deleteAllBattleReports()` removes every row regardless of `announced` state, and returns
  the count deleted.

Run `node src/repositories/battleReports.test.js` directly and confirm it passes.

**Report file:** `task-1-report.md`.

## Task 2: Migrate `src/routes/admin.js` and fix the source-text test

Add `const battleReportsRepo = require('../repositories/battleReports');` alongside this
file's other repository requires (match existing style/location, e.g. near `alliancesRepo`).

Before (inside `nukeTx`):
```js
    // Battle reports describe battles on the map being wiped — they go with it.
    // starbase_order_audit is deliberately NOT here: it is an operations record
    // of who sent what through the hub, and that stays true across rounds.
    db.prepare(`DELETE FROM battle_reports`).run();
```
After — preserve the comment exactly, only the statement line changes:
```js
    // Battle reports describe battles on the map being wiped — they go with it.
    // starbase_order_audit is deliberately NOT here: it is an operations record
    // of who sent what through the hub, and that stays true across rounds.
    battleReportsRepo.deleteAllBattleReports();
```

`admin.js` KEEPS its `db` require (used extensively elsewhere in this same transaction and
file) — do not remove it.

Then fix `src/utils/battle-reports.test.js` lines 189-194 (the source-text check that breaks
because the literal string `DELETE FROM battle_reports` no longer appears in `admin.js`).
Retarget it at the new call site text WITHOUT weakening what property is verified — the
check must still confirm (a) the wipe call exists in `admin.js`, and (b) it happens between
`archiveRound(db` and the transaction's invocation `nukeTx()`. Before:
```js
    const admin = readCode('src/routes/admin.js');
    ok('the round wipe clears battle reports', /DELETE FROM battle_reports/.test(admin));
    ok('inside the same transaction as the other deletes',
        admin.indexOf('DELETE FROM battle_reports') > admin.indexOf('archiveRound(db')
        && admin.indexOf('DELETE FROM battle_reports') < admin.indexOf('nukeTx()'),
        [admin.indexOf('archiveRound(db'), admin.indexOf('DELETE FROM battle_reports'), admin.indexOf('nukeTx()')]);
    ok('but never touches the starbase order audit', !/DELETE FROM starbase_order_audit/.test(admin));
```
After:
```js
    const admin = readCode('src/routes/admin.js');
    ok('the round wipe clears battle reports', /battleReportsRepo\.deleteAllBattleReports\(\)/.test(admin));
    ok('inside the same transaction as the other deletes',
        admin.indexOf('battleReportsRepo.deleteAllBattleReports()') > admin.indexOf('archiveRound(db')
        && admin.indexOf('battleReportsRepo.deleteAllBattleReports()') < admin.indexOf('nukeTx()'),
        [admin.indexOf('archiveRound(db'), admin.indexOf('battleReportsRepo.deleteAllBattleReports()'), admin.indexOf('nukeTx()')]);
    ok('but never touches the starbase order audit', !/DELETE FROM starbase_order_audit/.test(admin));
```
The third check (starbase_order_audit) is untouched — that table's raw SQL never appears in
`admin.js` regardless of this migration, so the check remains valid as-is.

Run `node src/utils/battle-reports.test.js` directly and confirm all its checks (including
this retargeted one and the untouched mapping/upsert/embed tests earlier in the file) still
pass. Then run the full test suite and confirm no regressions (30 suites expected — 29 from
before plus the new `battleReports.test.js` from Task 1).

Commit both the `admin.js` change and the `battle-reports.test.js` fix together in one
commit (they're one coherent change: migrate the call site, fix the test that observes it),
with a message like "Migrate admin.js battle_reports delete to battleReports repository".

**Report file:** `task-2-report.md`.

## Task 3: Migrate `src/routes/sync.js`

Add `const battleReportsRepo = require('../repositories/battleReports');` near the top,
alongside the existing `mapApiReport, upsertReports, formatBattleEmbed` import from
`../utils/battle-reports` and other repository requires.

Before (pending-read, call site #2):
```js
            const pending = db.prepare(
                `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`).all();
```
After:
```js
            const pending = battleReportsRepo.getPendingAnnouncements();
```

Before (mark-announced prep + flip transaction, call sites #3 and #4 — the `db.transaction`
wrapper stays, only the inner statement changes):
```js
                const markAnnounced = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
                const toEmbed = pending.slice(0, 5);
                for (const row of toEmbed) {
                    /* ... embed formatting and postEmbed calls, unchanged ... */
                }
                if (pending.length > toEmbed.length) {
                    /* ... unchanged ... */
                }
                const flip = db.transaction((ids) => { for (const id of ids) markAnnounced.run(id); });
                flip(pending.map(r => r.id));
```
After — remove the `markAnnounced` prepared-statement variable entirely; the transaction
callback now calls the repo function directly:
```js
                const toEmbed = pending.slice(0, 5);
                for (const row of toEmbed) {
                    /* ... embed formatting and postEmbed calls, UNCHANGED — do not touch ... */
                }
                if (pending.length > toEmbed.length) {
                    /* ... UNCHANGED ... */
                }
                const flip = db.transaction((ids) => { for (const id of ids) battleReportsRepo.markAnnounced(id); });
                flip(pending.map(r => r.id));
```
Everything between the `markAnnounced` declaration and the `flip`/`pending.map` lines
(the embed-building and `postEmbed(...)` Discord side effects) is UNCHANGED — do not touch
it, only remove the `markAnnounced` prepared-statement declaration and update its one call
site inside the `flip` transaction callback.

Before (newest-timestamp read, call site #5):
```js
        const newest = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`).get().newest || null;
```
After:
```js
        const newest = battleReportsRepo.getNewestStartedAt();
```

`sync.js` KEEPS its `db` require — still needed for `upsertReports(db, rows)` (unchanged,
per the scope decision) and the `flip` transaction wrapper. Do not touch the
`/sync/starbase-audit` handler or anything else in this file.

Run the full test suite and confirm no regressions (30 suites expected). Commit with a
message like "Migrate sync.js battle_reports call sites to battleReports repository".

**Report file:** `task-3-report.md`.

## Task 4: Regression pass (final domain — also confirm project completeness)

Run the full test suite and confirm all 30 suites pass. Confirm no source-text regex test
elsewhere references the old raw-SQL literal locations that just moved — spot-check
`grep -rln "battle_reports" src --include="*.test.js"` and manually inspect any hit outside
`src/repositories/battleReports.test.js` and the already-fixed
`src/utils/battle-reports.test.js` to confirm nothing else needs updating (none are
expected, but confirm rather than assume, per this project's established verification
discipline).

As this is the NINTH and FINAL domain in the whole refactor project, also do one broader
sanity check: `grep -rn "db\.prepare\|db\.transaction\|db\.exec" src --include="*.js"` across
files OUTSIDE `src/repositories/` and outside `*.test.js`, and confirm every remaining hit
is either (a) `src/utils/round-archive.js` or `src/utils/battle-reports.js` (both explicitly
and deliberately excluded from the repository pattern, per documented rulings in domains 8
and 9), or (b) `src/routes/rzhub.js`'s `rz_plans` table (explicitly out of scope for the
whole project, never on the approved migration list), or (c) `src/routes/sync.js`'s
`starbase_order_audit` call site (explicitly out of scope, see this plan's own "Out of
scope" section). If anything else turns up, flag it — do not silently expand this task's
scope to fix it; report it for a decision instead.

**Report file:** `task-4-report.md` — full test run output summary, plus the broader
sanity-check grep output and your assessment of each remaining hit.
