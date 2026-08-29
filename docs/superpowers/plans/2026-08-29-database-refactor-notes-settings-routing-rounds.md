# Database Refactor: notes, settings, routing, rounds (domain 8 of 9)

## Goal

Extract scattered raw `db.prepare(...)` calls for three table groups into new repository
modules, following the pattern established by all seven prior domains: module-level
compiled-once prepared statements + thin exported wrapper functions + a single trailing
`module.exports`.

- `src/repositories/notes.js` — `user_notes`
- `src/repositories/settings.js` — `app_settings`
- `src/repositories/routing.js` — `routes`, `route_legs`

A fourth table group, `rounds`/`round_players`/`round_systems`, is explicitly **NOT**
migrated into a new repository module — see "Rounds: scope decision" below. One small
addition is made to the existing `src/utils/round-archive.js` module instead.

This is the eighth of nine planned domains. After this: battleReports (schema-only shell).

## Spec

Reference: `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Rounds: scope decision (read before starting)

`src/utils/round-archive.js` already centralizes essentially all `rounds`/`round_players`/
`round_systems` SQL behind five exported functions (`archiveRound`, `previousNames`,
`findByFormerName`, `listRounds`, `roundDetail`). Unlike every other domain's scattered
call sites, this table group is **already not scattered** — it already satisfies this
project's actual goal (SQL centralized in one module, not spread across route files).

Its functions take `db` as an explicit first parameter (dependency injection) rather than
requiring `src/database.js` directly, which is a deliberate, different convention from the
`src/repositories/*.js` modules built in domains 1-7. This matters because
`src/utils/round-archive.test.js` exploits it: the test builds its OWN minimal in-memory
`better-sqlite3` database (a handful of tables, not the real schema) and passes that `db`
directly into `archiveRound`/`previousNames`/etc. This lets the test verify transaction
atomicity (a failing archive must roll back the wipe) and column-preservation behavior
without needing the full 60+ table production schema. Converting this module to the
direct-require convention would break that test's entire design — there would be no way to
inject a synthetic schema — for zero benefit, since the SQL is already centralized.

**Ruling (pre-flight, not a mid-execution finding): leave `src/utils/round-archive.js` and
its existing five functions exactly as they are.** Do not touch this file, do not migrate
it to `src/repositories/rounds.js`, do not change its `db`-parameter convention, do not
touch `src/utils/round-archive.test.js`.

The ONE real gap is `src/routes/search.js:88-99`, which has its own ad-hoc raw SQL against
`round_players`/`rounds` (a "search former names, but only for players who still currently
exist" variant, independently written rather than reusing `round-archive.js`). This one
scattered call site DOES need to move — Task 4 below adds a new function to
`round-archive.js` (matching its existing `db`-parameter convention, not the direct-require
convention) and migrates `search.js` to call it.

## Call sites — `user_notes`

### `src/routes/notes.js`
1. **Lines 34-41** — list, `GET /notes`:
   ```js
   const rows = db.prepare(`
       SELECT n.id, n.text, n.due_at, n.remind_15, n.done, n.done_at, n.created_at,
              a.game_name AS author_name
       FROM user_notes n
       LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
       WHERE n.owner_id = ? AND n.done = 0
       ORDER BY (n.due_at IS NULL), n.due_at ASC, n.created_at ASC
   `).all(req.session.userId);
   ```
2. **Lines 72-83** — create, `POST /notes`, INSERT wrapped in a `db.transaction` (loop, one
   row per recipient — the transaction touches only `user_notes`, nothing else):
   ```js
   const insert = db.prepare(`
       INSERT INTO user_notes (owner_id, author_id, text, due_at, remind_15) VALUES (?, ?, ?, ?, ?)
   `);
   const insertAll = db.transaction((ids) => {
       const created = [];
       for (const ownerId of ids) {
           const info = insert.run(ownerId, req.session.userId, text, dueAt ? dueAt.toISOString() : null, remind15);
           created.push(info.lastInsertRowid);
       }
       return created;
   });
   const ids = insertAll(recipientIds);
   ```
3. **Lines 95-98** — mark done, `PATCH /notes/:id/done`:
   ```js
   const info = db.prepare(`
       UPDATE user_notes SET done = 1, done_at = CURRENT_TIMESTAMP
       WHERE id = ? AND owner_id = ?
   `).run(req.params.id, req.session.userId);
   ```
4. **Line 111** — delete, `DELETE /notes/:id`:
   ```js
   const info = db.prepare(`DELETE FROM user_notes WHERE id = ? AND owner_id = ?`).run(req.params.id, req.session.userId);
   ```

### `src/discord_bot.js`
5. **Lines 1497-1503** — reminder poller SELECT, `checkNoteReminders()`:
   ```js
   pending = db.prepare(`
       SELECT n.id, n.text, n.due_at, u.discord_id, u.game_name, a.game_name AS author_name
       FROM user_notes n
       JOIN app_users u ON u.id = n.owner_id
       LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
       WHERE n.done = 0 AND n.remind_15 = 1 AND n.reminded_at IS NULL AND n.due_at IS NOT NULL
   `).all();
   ```
6. **Line 1514** — mark reminded, same function:
   ```js
   const markSent = db.prepare(`UPDATE user_notes SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?`);
   ```
   (called later in a loop as `markSent.run(note.id)`)

## Call sites — `app_settings`

Ten call sites, but heavy duplication — see Global Constraints for the sanctioned dedups
that bring this down to 4 repository functions.

1. `src/utils/discord-post.js:25` — `SELECT value FROM app_settings WHERE key = ?` (param: `key`)
2. `src/utils/interceptors.js:42` — `SELECT value FROM app_settings WHERE key = 'pp_price'` (no params)
3. `src/routes/trade.js:30` — `SELECT value FROM app_settings WHERE key = 'pp_price'` (no params)
4. `src/routes/intel.js:391` — `SELECT value FROM app_settings WHERE key = 'pp_price'` (no params)
5. `src/discord_bot.js:1466` — `SELECT value FROM app_settings WHERE key = ?` (param: `key`)
6. `src/routes/admin.js:382` — `SELECT key, value FROM app_settings` (no params, all rows)
7. `src/routes/admin.js:398-401` — upsert:
   ```js
   db.prepare(`
       INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
   `).run(key, value == null ? '' : String(value).trim());
   ```
8. `src/routes/sync.js:598-601` — byte-identical upsert SQL to #7, called twice with
   `('pp_price', ...)` and `('su_price', ...)`.
9. `src/routes/rzhub.js:102` — `SELECT value FROM app_settings WHERE key = 'rz_ta'` (no params)
10. `src/routes/rzhub.js:137-140` — upsert with a hardcoded literal key:
    ```js
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES ('rz_ta', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(clean));
    ```

## Call sites — `routes` / `route_legs`

All in `src/routes/routes.js`.

1. **Line 106** — expiry sweep: `DELETE FROM routes WHERE expires_at IS NOT NULL AND expires_at < datetime('now')` (no params, run in a try/catch that logs and swallows errors — `purgeExpired()`)
2. **Lines 117-125** — leg fetch by route ids, variable-arity `IN (...)`, inside `hydrate(routeRows)`:
   ```js
   const legs = db.prepare(`
       SELECT rl.*, sf.name AS from_system_name, sf.x AS from_x, sf.y AS from_y,
              st.name AS to_system_name,   st.x AS to_x,   st.y AS to_y
       FROM route_legs rl
       LEFT JOIN systems sf ON sf.id = rl.from_system_id
       LEFT JOIN systems st ON st.id = rl.to_system_id
       WHERE rl.route_id IN (${marks})
       ORDER BY rl.route_id, rl.leg_index
   `).all(...ids);
   ```
3. **Lines 195-201** — list for a user, `GET /routes`:
   ```js
   const rows = db.prepare(`
       SELECT r.*, u.game_name AS author_name
       FROM routes r
       LEFT JOIN app_users u ON u.id = r.author_id
       WHERE r.visibility = 'alliance' OR r.author_id = ?
       ORDER BY COALESCE(r.planned_start_at, r.created_at) ASC
   `).all(req.session.userId);
   ```
4. **Lines 211-215** — single route by id, `GET /routes/:id`:
   ```js
   const row = db.prepare(`
       SELECT r.*, u.game_name AS author_name
       FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
       WHERE r.id = ?
   `).get(req.params.id);
   ```
5. **Lines 245-250** — UPDATE branch of `writeRoute`'s transaction:
   ```js
   db.prepare(`
       UPDATE routes SET title=?, note=?, planned_start_at=?, energy=?, race_speed=?,
                         is_alliance_move=?, biology=?, visibility=?, expires_at=?,
                         updated_at=CURRENT_TIMESTAMP
       WHERE id=?
   `).run(title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, id);
   ```
6. **Line 251** — same transaction, immediately after #5: `DELETE FROM route_legs WHERE route_id = ?` — run with `(id)`.
7. **Lines 253-257** — INSERT branch of the same transaction (when `routeId` is falsy):
   ```js
   const r = db.prepare(`
       INSERT INTO routes (author_id, title, note, planned_start_at, energy, race_speed,
                           is_alliance_move, biology, visibility, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   `).run(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt);
   id = r.lastInsertRowid;
   ```
8. **Lines 261-269** — same transaction, insert each leg:
   ```js
   const ins = db.prepare(`
       INSERT INTO route_legs (route_id, leg_index, from_system_id, from_planet_index,
                               to_system_id, to_planet_index, travel_seconds, distance, bio_needed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   `);
   for (const l of built.legs) {
       ins.run(id, l.legIndex, l.from.systemId, l.from.planetIndex,
               l.to.systemId, l.to.planetIndex, l.travelSeconds, l.distance, l.bioNeeded);
   }
   ```
   Call sites #5-#8 are all inside `writeRoute`'s single `db.transaction(() => {...})`. This
   transaction touches only `routes` and `route_legs` — no other domain's tables.
9. **Line 295** — ownership check, `PUT /routes/:id`: `SELECT id, author_id FROM routes WHERE id = ?`
10. **Line 311** — ownership check, `DELETE /routes/:id`: `SELECT id, author_id FROM routes WHERE id = ?` (byte-identical to #9)
11. **Line 316** — `DELETE /routes/:id`, first statement: `DELETE FROM route_legs WHERE route_id = ?` (byte-identical to #6)
12. **Line 317** — `DELETE /routes/:id`, second statement: `DELETE FROM routes WHERE id = ?`. **Not wrapped in a transaction with #11** — this is pre-existing behavior (a crash between the two calls could orphan one side). Preserve this exactly as-is; do NOT wrap it in a transaction as part of this refactor (see Global Constraints — no behavior changes).
13. **Lines 328-332** — announce, `POST /routes/:id/announce`: byte-identical SQL to #4.

## Global Constraints

**Sanctioned dedups — `settings.js` (4 functions covering all 10 call sites):**
- `getSetting(key)` → `SELECT value FROM app_settings WHERE key = ?`. Covers call sites
  #1 (`discord-post.js`) and #5 (`discord_bot.js`) directly (both call with a variable
  key). Also covers #9 (`rzhub.js` GET) via `getSetting('rz_ta')` — functionally identical
  to a literal `key = 'rz_ta'` since better-sqlite3 binds the parameter the same way SQLite
  would evaluate the literal.
- `getPpPrice()` → `SELECT value FROM app_settings WHERE key = 'pp_price'` (no params).
  Covers #2 (`interceptors.js`), #3 (`trade.js`), #4 (`intel.js`) — three byte-identical
  call sites.
- `getAllSettings()` → `SELECT key, value FROM app_settings` (no params, all rows). Covers
  #6 (`admin.js` GET).
- `setSetting(key, value)` → the upsert. Covers #7 (`admin.js` POST) and #8 (`sync.js`,
  called twice with different key/value pairs) directly. Also covers #10 (`rzhub.js` POST)
  via `setSetting('rz_ta', JSON.stringify(clean))` — same reasoning as `getSetting` above:
  a literal key in the SQL text vs. the same string bound as a parameter produce identical
  behavior.

Each caller's own wrapper function name is preserved (e.g. `discord-post.js` keeps its
exported `settingValue(key)`, which now just calls `settingsRepo.getSetting(key)`
internally; `discord_bot.js` keeps `getSettingValue(key)` the same way). Do not rename or
remove these caller-side wrapper functions — only their internal `db.prepare(...)` line
changes.

**Sanctioned dedups — `routing.js`:**
- `getRouteById(id)` → covers call sites #4 and #13 (byte-identical SQL).
- `getRouteOwnership(id)` → covers call sites #9 and #10 (byte-identical SQL).
- `deleteRouteLegsForRoute(id)` → covers call sites #6 and #11 (byte-identical SQL,
  `DELETE FROM route_legs WHERE route_id = ?`), used both inside `writeRoute`'s update
  branch and in the standalone `DELETE /routes/:id` route.

**No behavior changes, even where the extraction surfaced something that looks fixable.**
Call sites #11/#12 (`DELETE /routes/:id`) are NOT wrapped in a `db.transaction` today even
though they're two related deletes — leave this exactly as it is. Do not add a transaction
around them as part of this refactor; that would be a scope-creep behavior change, not a
refactor. (If this is worth fixing, it's a separate, deliberate change — not bundled here.)

**Transactions stay at the call site, not inside the repository.** Following the
established convention from every prior domain (e.g. `sync.js`'s multi-repo transactions,
`admin.js`'s nuke-intel transaction): `db.transaction(...)` wrappers remain in the
consuming route file, which keeps its own `const db = require('../database');` for that
purpose. Only the individual `db.prepare(...)` statements inside the transaction body move
into repository function calls. This applies to `notes.js`'s `insertAll` transaction
(Task 2) and `routes.js`'s `writeRoute` transaction (Task 4).

**Variable-arity statement — `getRouteLegsForRouteIds(ids)`.** Like prior domains' handling
of variable-arity `IN (...)` clauses, this function cannot use a single module-level
compiled statement (the placeholder count depends on the call). Build the statement
per-call inside the function body, mirroring the existing `hydrate()` code's own
`ids.map(() => '?').join(',')` approach. Return `[]` immediately if `ids` is empty, matching
`hydrate()`'s existing `if (!routeRows.length) return [];` guard (which means this function
is never actually called with an empty array in practice, but should not error if it were).

**Repository functions must not add their own try/catch.** Several call sites are already
wrapped in try/catch in their original files (e.g. `settings.js` getters return a default
value on error; `routes.js`'s `purgeExpired()` logs and swallows). Preserve those try/catch
blocks in the CALLING code unchanged; the repository functions themselves just run the
statement and return/throw normally, matching every prior domain.

**`db` require removal.** After migrating, check whether each touched file still uses `db`
directly for anything else before removing `const db = require('../database');` (or
`require('./database')` in `discord_bot.js`). `notes.js` will still need `db` for its
`db.transaction(...)` wrapper (Task 2) — do NOT remove its `db` require. `routes.js`
likewise keeps `db` for `writeRoute`'s transaction wrapper. `interceptors.js`, `trade.js`,
`intel.js`, `admin.js`, `sync.js`, `discord_bot.js` each have other domains' call sites
already migrated or not-yet-migrated in prior/later domains — verify directly with a grep
before removing anything (this file's Task briefs will tell you what to check). `rzhub.js`
must KEEP its `db` require regardless — it has an unrelated `rz_plans` table (out of scope
for this domain) using raw SQL elsewhere in the same file. `search.js` (Task 4) has exactly
one `db.` usage in the whole file (the call site being migrated) — safe to remove after
migrating.

**Verification technique:** every call site above was independently re-read directly from
source (not just trusted from the extraction agent's report) before writing this plan —
full-file reads of `notes.js`, `discord-post.js`, `interceptors.js`, `trade.js` (partial),
`intel.js` (partial), `admin.js` (partial), `sync.js` (partial), `rzhub.js` (partial),
`discord_bot.js` (partial), `routes.js` (full), `search.js` (partial). Do not re-scan for
more call sites in `user_notes`/`app_settings`/`routes`/`route_legs` — this list is
exhaustive.

## File Structure

- `src/repositories/notes.js` (new) + `src/repositories/notes.test.js` (new)
- `src/repositories/settings.js` (new) + `src/repositories/settings.test.js` (new)
- `src/repositories/routing.js` (new) + `src/repositories/routing.test.js` (new)
- `src/utils/round-archive.js` (one new function added, everything else untouched)
- Consumers migrated: `src/routes/notes.js`, `src/discord_bot.js`, `src/utils/discord-post.js`,
  `src/utils/interceptors.js`, `src/routes/trade.js`, `src/routes/intel.js`,
  `src/routes/admin.js`, `src/routes/sync.js`, `src/routes/rzhub.js`, `src/routes/routes.js`,
  `src/routes/search.js`

## Task 1: Create `src/repositories/notes.js` and its smoke test

Create `src/repositories/notes.js`:

```js
const db = require('../database');

const getActiveNotesForOwnerStmt = db.prepare(`
    SELECT n.id, n.text, n.due_at, n.remind_15, n.done, n.done_at, n.created_at,
           a.game_name AS author_name
    FROM user_notes n
    LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
    WHERE n.owner_id = ? AND n.done = 0
    ORDER BY (n.due_at IS NULL), n.due_at ASC, n.created_at ASC
`);
function getActiveNotesForOwner(ownerId) {
    return getActiveNotesForOwnerStmt.all(ownerId);
}

const insertNoteStmt = db.prepare(`
    INSERT INTO user_notes (owner_id, author_id, text, due_at, remind_15) VALUES (?, ?, ?, ?, ?)
`);
function insertNote(ownerId, authorId, text, dueAt, remind15) {
    return insertNoteStmt.run(ownerId, authorId, text, dueAt, remind15).lastInsertRowid;
}

const markNoteDoneStmt = db.prepare(`
    UPDATE user_notes SET done = 1, done_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
`);
function markNoteDone(id, ownerId) {
    return markNoteDoneStmt.run(id, ownerId).changes;
}

const deleteNoteStmt = db.prepare(`DELETE FROM user_notes WHERE id = ? AND owner_id = ?`);
function deleteNote(id, ownerId) {
    return deleteNoteStmt.run(id, ownerId).changes;
}

const getDueRemindersStmt = db.prepare(`
    SELECT n.id, n.text, n.due_at, u.discord_id, u.game_name, a.game_name AS author_name
    FROM user_notes n
    JOIN app_users u ON u.id = n.owner_id
    LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
    WHERE n.done = 0 AND n.remind_15 = 1 AND n.reminded_at IS NULL AND n.due_at IS NOT NULL
`);
function getDueReminders() {
    return getDueRemindersStmt.all();
}

const markReminderSentStmt = db.prepare(`UPDATE user_notes SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?`);
function markReminderSent(id) {
    markReminderSentStmt.run(id);
}

module.exports = {
    getActiveNotesForOwner, insertNote, markNoteDone, deleteNote,
    getDueReminders, markReminderSent
};
```

Note `insertNote` returns `info.lastInsertRowid` directly (unlike the original inline call
inside `notes.js`'s transaction, which pushed `info.lastInsertRowid` into an array itself —
the array-building loop stays in `notes.js`, Task 2; this repo function just returns the
one id it created).

Then create `src/repositories/notes.test.js` following the exact style of
`src/repositories/discordTimers.test.js` / `src/repositories/incoming.test.js` (temp DB via
`AWT_DB_PATH`, plain `ok()` helper, `process.exit(1)` on failure). Exercise:
- `getActiveNotesForOwner` returns `[]` for an owner with no notes.
- `insertNote` creates a row; `getActiveNotesForOwner` returns it (need an `app_users` row
  for the owner first, since the query LEFT JOINs `app_users` — check `src/database.js` for
  the `app_users` schema and insert a minimal row directly via `db.prepare` in the test
  setup, matching how other repo tests seed prerequisite rows).
- A note with `done = 1` (seed directly, or via `markNoteDone`) does NOT appear in
  `getActiveNotesForOwner`'s results.
- `markNoteDone` returns `1` (changes) for an existing note owned by that user, `0` for a
  note id that doesn't exist or belongs to someone else.
- `deleteNote` returns `1` for an existing note owned by that user, `0` otherwise; the row
  is actually gone afterward (verify via `getActiveNotesForOwner` or a raw `db.prepare`
  check).
- `getDueReminders` returns a note with `remind_15 = 1`, `done = 0`, `reminded_at` NULL,
  and a non-null `due_at`; does NOT return one that's already `done`, already reminded, has
  `remind_15 = 0`, or has a NULL `due_at`.
- `markReminderSent` followed by `getDueReminders` no longer returns that note.

Run `node src/repositories/notes.test.js` directly and confirm it passes before moving on.

**Report file:** `task-1-report.md` — status, test output, any deviations.

## Task 2: Migrate `src/routes/notes.js`

Add `const notesRepo = require('../repositories/notes');` near the top (alongside the
existing `usersRepo` require).

Before (list, `GET /notes`):
```js
        const rows = db.prepare(`
            SELECT n.id, n.text, n.due_at, n.remind_15, n.done, n.done_at, n.created_at,
                   a.game_name AS author_name
            FROM user_notes n
            LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
            WHERE n.owner_id = ? AND n.done = 0
            ORDER BY (n.due_at IS NULL), n.due_at ASC, n.created_at ASC
        `).all(req.session.userId);
```
After:
```js
        const rows = notesRepo.getActiveNotesForOwner(req.session.userId);
```

Before (create, `POST /notes`):
```js
        const insert = db.prepare(`
            INSERT INTO user_notes (owner_id, author_id, text, due_at, remind_15) VALUES (?, ?, ?, ?, ?)
        `);
        const insertAll = db.transaction((ids) => {
            const created = [];
            for (const ownerId of ids) {
                const info = insert.run(ownerId, req.session.userId, text, dueAt ? dueAt.toISOString() : null, remind15);
                created.push(info.lastInsertRowid);
            }
            return created;
        });
        const ids = insertAll(recipientIds);
```
After (the `db.transaction` wrapper stays here — `notes.js` keeps its `db` require for
this; only the inner INSERT moves into the repo):
```js
        const insertAll = db.transaction((ids) => {
            const created = [];
            for (const ownerId of ids) {
                created.push(notesRepo.insertNote(ownerId, req.session.userId, text, dueAt ? dueAt.toISOString() : null, remind15));
            }
            return created;
        });
        const ids = insertAll(recipientIds);
```

Before (mark done, `PATCH /notes/:id/done`):
```js
        const info = db.prepare(`
            UPDATE user_notes SET done = 1, done_at = CURRENT_TIMESTAMP
            WHERE id = ? AND owner_id = ?
        `).run(req.params.id, req.session.userId);
        if (info.changes === 0) return res.status(404).json({ success: false, error: 'Note not found' });
```
After:
```js
        const changes = notesRepo.markNoteDone(req.params.id, req.session.userId);
        if (changes === 0) return res.status(404).json({ success: false, error: 'Note not found' });
```

Before (delete, `DELETE /notes/:id`):
```js
        const info = db.prepare(`DELETE FROM user_notes WHERE id = ? AND owner_id = ?`).run(req.params.id, req.session.userId);
        if (info.changes === 0) return res.status(404).json({ success: false, error: 'Note not found' });
```
After:
```js
        const changes = notesRepo.deleteNote(req.params.id, req.session.userId);
        if (changes === 0) return res.status(404).json({ success: false, error: 'Note not found' });
```

`notes.js` KEEPS its `const db = require('../database');` — it's still needed for the
`db.transaction(...)` wrapper in `POST /notes`. Do not remove it.

**Report file:** `task-2-report.md`.

## Task 3: Migrate `src/discord_bot.js`'s two `user_notes` call sites

Add `const notesRepo = require('./repositories/notes');` alongside this file's other
repository requires (match existing style/location — e.g. near `incomingRepo`).

Before (`checkNoteReminders()`):
```js
        pending = db.prepare(`
            SELECT n.id, n.text, n.due_at, u.discord_id, u.game_name, a.game_name AS author_name
            FROM user_notes n
            JOIN app_users u ON u.id = n.owner_id
            LEFT JOIN app_users a ON a.id = n.author_id AND a.id != n.owner_id
            WHERE n.done = 0 AND n.remind_15 = 1 AND n.reminded_at IS NULL AND n.due_at IS NOT NULL
        `).all();
```
After:
```js
        pending = notesRepo.getDueReminders();
```

Before:
```js
    const markSent = db.prepare(`UPDATE user_notes SET reminded_at = CURRENT_TIMESTAMP WHERE id = ?`);
```
...later used as `markSent.run(note.id)` in a loop. After — replace the loop's call site
directly (there is no longer a `markSent` prepared-statement variable):
```js
    // (removed: markSent variable)
```
and change every `markSent.run(note.id)` call in that loop to `notesRepo.markReminderSent(note.id)`.

This is a large file with dozens of unrelated call sites (other domains, already migrated
or scheduled for later) — touch ONLY these two `user_notes` call sites inside
`checkNoteReminders()`. Do not touch the `app_settings` call site in this same file
(`getSettingValue`, migrated separately in Task 5) or anything else.

**Report file:** `task-3-report.md`.

## Task 4: Migrate `src/routes/search.js`'s scattered `round_players` query into `round-archive.js`

This is the one real gap in the "rounds" table group (see "Rounds: scope decision" above).
Do NOT create `src/repositories/rounds.js`. Instead, add ONE new function to the EXISTING
`src/utils/round-archive.js`, matching its established `db`-parameter convention exactly
(the other five functions in that file all take `db` as their first argument — do not
switch to `require('../database')` for this new function; it must stay consistent with its
siblings and remain injectable by `round-archive.test.js`-style tests).

In `src/utils/round-archive.js`, add (place it near `findByFormerName`, which it closely
resembles):

```js
// Like findByFormerName, but only returns hits for a player who still currently exists
// (used by the player search box, where a hit with no live account to show is noise).
function searchFormerNamesWithCurrentPlayer(db, query, { limit = 20 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    return db.prepare(`
        SELECT rp.player_id AS id, p.name, a.tag AS alliance_tag,
               rp.name AS former_name, r.label AS former_round
        FROM round_players rp
        JOIN rounds r ON r.id = rp.round_id
        LEFT JOIN players p ON p.id = rp.player_id
        LEFT JOIN alliances a ON a.id = p.alliance_id
        WHERE rp.name LIKE ? AND p.id IS NOT NULL
        GROUP BY rp.player_id
        ORDER BY r.id DESC
        LIMIT ?
    `).all(`%${q}%`, limit);
}
```

Add `searchFormerNamesWithCurrentPlayer` to the file's `module.exports` line (append to the
existing list — do not reorder or remove the existing five exports).

This is a genuinely new function (the original `search.js` code built the `%${q}%` LIKE
pattern in the caller and passed `searchTerm` directly, with `LIMIT 20` hardcoded in the
SQL rather than parameterized) — normalizing the query trimming and hardcoded 20 into a
parameter is a light interface improvement over a raw inline block, matching how
`findByFormerName` in the same file already validates/trims its own query input. Preserve
the exact same filtering behavior (`p.id IS NOT NULL`, `GROUP BY rp.player_id`, no
`LOWER()` dedup on name unlike `findByFormerName`, `ORDER BY r.id DESC`, default limit 20).

Then migrate `src/routes/search.js`:

Add `const { searchFormerNamesWithCurrentPlayer } = require('../utils/round-archive');`
near the top, alongside the existing `plansRepo`/`systemsRepo`/`playersRepo` requires.

Before:
```js
        const former = db.prepare(`
            SELECT rp.player_id AS id, p.name, a.tag AS alliance_tag,
                   rp.name AS former_name, r.label AS former_round
            FROM round_players rp
            JOIN rounds r ON r.id = rp.round_id
            LEFT JOIN players p ON p.id = rp.player_id
            LEFT JOIN alliances a ON a.id = p.alliance_id
            WHERE rp.name LIKE ? AND p.id IS NOT NULL
            GROUP BY rp.player_id
            ORDER BY r.id DESC
            LIMIT 20
        `).all(searchTerm);
```
After — note `searchTerm` in the original code was already the `%${q}%`-wrapped pattern
built earlier in the handler; check the handler to confirm what `q` (the raw query) is
called there, and pass that raw value in, NOT the pre-wrapped `searchTerm`, since the new
function does its own wrapping:
```js
        const former = searchFormerNamesWithCurrentPlayer(db, q, { limit: 20 });
```
(If the raw pre-wildcard query variable has a different name in the actual handler, use
that name — read the surrounding code first to confirm, since `searchTerm` in this file may
already be `%${q}%`-wrapped for the OTHER query on line 81 (`playersRepo.searchPlayersByNameOrId`)
and reusing that wrapped value here would double-wrap the wildcard.)

`search.js` has exactly one `db.` usage in the whole file (this call site) — remove
`const db = require('../database');` after migrating, once confirmed via
`grep -n "db\." src/routes/search.js` that nothing else uses it.

**Report file:** `task-4-report.md`.

## Task 5: Create `src/repositories/settings.js` and its smoke test

Create `src/repositories/settings.js`:

```js
const db = require('../database');

const getSettingStmt = db.prepare(`SELECT value FROM app_settings WHERE key = ?`);
function getSetting(key) {
    return getSettingStmt.get(key);
}

const getPpPriceStmt = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`);
function getPpPrice() {
    return getPpPriceStmt.get();
}

const getAllSettingsStmt = db.prepare(`SELECT key, value FROM app_settings`);
function getAllSettings() {
    return getAllSettingsStmt.all();
}

const setSettingStmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`);
function setSetting(key, value) {
    setSettingStmt.run(key, value);
}

module.exports = { getSetting, getPpPrice, getAllSettings, setSetting };
```

Note `getSetting` and `getPpPrice` return the raw row (`{ value: ... }` or `undefined`),
matching what every original call site expected (each caller already does its own
`row && row.value` / `row ? parseFloat(row.value) : NaN` handling — that logic stays in the
caller, unchanged).

Create `src/repositories/settings.test.js` following the established style. Exercise:
- `getSetting('missing_key')` returns `undefined`.
- `setSetting('foo', 'bar')` then `getSetting('foo')` returns `{ value: 'bar' }` (or
  equivalent — check the actual column shape).
- `setSetting('foo', 'baz')` (same key again) updates in place — `getSetting('foo')` now
  returns `'baz'`, and there's still only one row for `key = 'foo'` (verify via
  `getAllSettings()` or a direct count).
- `getPpPrice()` returns `undefined` before any `pp_price` key is set; after
  `setSetting('pp_price', '0.95')`, returns a row with `value === '0.95'`.
- `getAllSettings()` returns all rows written so far (as an array), including a mix of
  `pp_price` and other keys.

Run `node src/repositories/settings.test.js` and confirm it passes.

**Report file:** `task-5-report.md`.

## Task 6: Migrate the 4 simple `app_settings` getter call sites

Migrate these four files, each getting a single `const settingsRepo = require(...);`
(adjust relative path per file location) and swapping exactly one line:

**`src/utils/discord-post.js`** — before:
```js
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
```
after:
```js
        const row = settingsRepo.getSetting(key);
```
Check whether `db` is used elsewhere in this file before removing its require (this file
may have other future/other-domain call sites — verify with grep first).

**`src/utils/interceptors.js`** — before:
```js
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`).get();
```
after:
```js
        const row = settingsRepo.getPpPrice();
```
Same check on `db` usage before removing the require.

**`src/routes/trade.js`** — before:
```js
    const ppRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`).get();
```
after:
```js
    const ppRow = settingsRepo.getPpPrice();
```
This file has other domains' call sites (trade_agreements were migrated in an earlier
domain) — check before removing `db`.

**`src/routes/intel.js`** — before:
```js
        const ppRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'pp_price'`).get();
```
after:
```js
        const ppRow = settingsRepo.getPpPrice();
```
This file uses `db`/repos for several other domains — check before removing anything.

**Report file:** `task-6-report.md` (single report covering all four files, since this is
one batch of small same-shape edits per the subagent-driven-development skill's batching
guidance).

## Task 7: Migrate `src/routes/admin.js`'s and `src/routes/sync.js`'s `app_settings` call sites

Add `const settingsRepo = require('../repositories/settings');` to both files (alongside
their existing repository requires).

**`src/routes/admin.js`** — before (`GET /admin/settings`):
```js
        const rows = db.prepare(`SELECT key, value FROM app_settings`).all();
```
after:
```js
        const rows = settingsRepo.getAllSettings();
```

Before (`POST /admin/settings`):
```js
        db.prepare(`
            INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(key, value == null ? '' : String(value).trim());
```
after:
```js
        settingsRepo.setSetting(key, value == null ? '' : String(value).trim());
```

`admin.js` has MANY other domains' call sites (this is the file with the nuke-intel
mega-transaction) — leave everything else in this file untouched, and keep its `db`
require (used extensively elsewhere, including the not-yet-migrated `battle_reports` raw
delete and the `archiveRound` transaction wrapper).

**`src/routes/sync.js`** — before:
```js
    const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);

    try {
        if (pp_price != null && !isNaN(pp_price)) upsert.run('pp_price', String(pp_price));
        if (su_price != null && !isNaN(su_price)) upsert.run('su_price', String(su_price));
```
after:
```js
    try {
        if (pp_price != null && !isNaN(pp_price)) settingsRepo.setSetting('pp_price', String(pp_price));
        if (su_price != null && !isNaN(su_price)) settingsRepo.setSetting('su_price', String(su_price));
```
`sync.js` has several other domains' transactions already migrated in prior domains — leave
everything else untouched, keep its `db` require.

**Report file:** `task-7-report.md`.

## Task 8: Migrate `src/routes/rzhub.js`'s `app_settings` call sites

Add `const settingsRepo = require('../repositories/settings');` alongside the existing
`db` require.

Before (`GET /ta`):
```js
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'rz_ta'`).get();
```
after:
```js
        const row = settingsRepo.getSetting('rz_ta');
```

Before (`POST /ta`):
```js
        db.prepare(`
            INSERT INTO app_settings (key, value, updated_at) VALUES ('rz_ta', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(JSON.stringify(clean));
```
after:
```js
        settingsRepo.setSetting('rz_ta', JSON.stringify(clean));
```

`rzhub.js` MUST KEEP its `const db = require('../database');` — this file has an unrelated
`rz_plans` table (a separate shared-notes feature) using raw SQL elsewhere in the same
file, out of scope for this domain. Do not remove the require, do not touch anything else
in this file.

**Report file:** `task-8-report.md`.

## Task 9: Create `src/repositories/routing.js` and its smoke test

Create `src/repositories/routing.js`:

```js
const db = require('../database');

const purgeExpiredRoutesStmt = db.prepare(`DELETE FROM routes WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`);
function purgeExpiredRoutes() {
    return purgeExpiredRoutesStmt.run().changes;
}

function getRouteLegsForRouteIds(ids) {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`
        SELECT rl.*, sf.name AS from_system_name, sf.x AS from_x, sf.y AS from_y,
               st.name AS to_system_name,   st.x AS to_x,   st.y AS to_y
        FROM route_legs rl
        LEFT JOIN systems sf ON sf.id = rl.from_system_id
        LEFT JOIN systems st ON st.id = rl.to_system_id
        WHERE rl.route_id IN (${marks})
        ORDER BY rl.route_id, rl.leg_index
    `).all(...ids);
}

const getRoutesForUserStmt = db.prepare(`
    SELECT r.*, u.game_name AS author_name
    FROM routes r
    LEFT JOIN app_users u ON u.id = r.author_id
    WHERE r.visibility = 'alliance' OR r.author_id = ?
    ORDER BY COALESCE(r.planned_start_at, r.created_at) ASC
`);
function getRoutesForUser(userId) {
    return getRoutesForUserStmt.all(userId);
}

const getRouteByIdStmt = db.prepare(`
    SELECT r.*, u.game_name AS author_name
    FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
    WHERE r.id = ?
`);
function getRouteById(id) {
    return getRouteByIdStmt.get(id);
}

const getRouteOwnershipStmt = db.prepare(`SELECT id, author_id FROM routes WHERE id = ?`);
function getRouteOwnership(id) {
    return getRouteOwnershipStmt.get(id);
}

const updateRouteStmt = db.prepare(`
    UPDATE routes SET title=?, note=?, planned_start_at=?, energy=?, race_speed=?,
                      is_alliance_move=?, biology=?, visibility=?, expires_at=?,
                      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
`);
function updateRoute(id, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt) {
    updateRouteStmt.run(title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, id);
}

const insertRouteStmt = db.prepare(`
    INSERT INTO routes (author_id, title, note, planned_start_at, energy, race_speed,
                        is_alliance_move, biology, visibility, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function insertRoute(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt) {
    return insertRouteStmt.run(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt).lastInsertRowid;
}

const deleteRouteLegsForRouteStmt = db.prepare(`DELETE FROM route_legs WHERE route_id = ?`);
function deleteRouteLegsForRoute(routeId) {
    deleteRouteLegsForRouteStmt.run(routeId);
}

const insertRouteLegStmt = db.prepare(`
    INSERT INTO route_legs (route_id, leg_index, from_system_id, from_planet_index,
                            to_system_id, to_planet_index, travel_seconds, distance, bio_needed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function insertRouteLeg(routeId, legIndex, fromSystemId, fromPlanetIndex, toSystemId, toPlanetIndex, travelSeconds, distance, bioNeeded) {
    insertRouteLegStmt.run(routeId, legIndex, fromSystemId, fromPlanetIndex, toSystemId, toPlanetIndex, travelSeconds, distance, bioNeeded);
}

const deleteRouteStmt = db.prepare(`DELETE FROM routes WHERE id = ?`);
function deleteRoute(id) {
    deleteRouteStmt.run(id);
}

module.exports = {
    purgeExpiredRoutes, getRouteLegsForRouteIds, getRoutesForUser, getRouteById,
    getRouteOwnership, updateRoute, insertRoute, deleteRouteLegsForRoute, insertRouteLeg,
    deleteRoute
};
```

Create `src/repositories/routing.test.js` following the established style. Exercise:
- `getRouteById`/`getRouteOwnership` return `undefined` for a missing id.
- `insertRoute` creates a row and returns its id; `getRouteById` then returns it with all
  fields matching what was written (you'll need a minimal `app_users` row for the
  `author_id` foreign-key-adjacent LEFT JOIN to resolve `author_name`, though since it's a
  LEFT JOIN a missing author row should still work — test both: with and without an
  `app_users` row present).
- `updateRoute` on an existing id changes its fields; `getRouteById` reflects the update
  (including that `updated_at` changes — or at least is set).
- `insertRouteLeg` (called a few times for the same `route_id`) followed by
  `getRouteLegsForRouteIds([routeId])` returns all of them, ordered by `leg_index`.
- `getRouteLegsForRouteIds([])` returns `[]` without querying (no error).
- `getRouteLegsForRouteIds([id1, id2])` (two different routes, each with legs) returns only
  the legs belonging to those two route ids, correctly attributed via `route_id`.
- `deleteRouteLegsForRoute(routeId)` removes only that route's legs, leaving another
  route's legs untouched.
- `deleteRoute(id)` removes the route row; `getRouteById(id)` afterward returns
  `undefined`.
- `getRoutesForUser(userId)` returns routes where `visibility = 'alliance'` OR
  `author_id = userId`, and excludes a private route belonging to a DIFFERENT user.
- `purgeExpiredRoutes()` removes a route with an `expires_at` in the past, leaves one with
  `expires_at` in the future or NULL untouched, and returns the count removed.

Run `node src/repositories/routing.test.js` and confirm it passes.

**Report file:** `task-9-report.md`.

## Task 10: Migrate `src/routes/routes.js`

Add `const routingRepo = require('../repositories/routing');` near the top, alongside the
existing `systemsRepo` require. `routes.js` KEEPS its `const db = require('../database');`
— it's still needed for `writeRoute`'s `db.transaction(...)` wrapper.

Before (`purgeExpired`):
```js
function purgeExpired() {
    try {
        const r = db.prepare(`DELETE FROM routes WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
        if (r.changes > 0) console.log(`[Routes] Removed ${r.changes} expired route(s).`);
    } catch (err) {
        console.error('[Routes] Expiry sweep failed:', err.message);
    }
}
```
After:
```js
function purgeExpired() {
    try {
        const changes = routingRepo.purgeExpiredRoutes();
        if (changes > 0) console.log(`[Routes] Removed ${changes} expired route(s).`);
    } catch (err) {
        console.error('[Routes] Expiry sweep failed:', err.message);
    }
}
```

Before (`hydrate`'s leg fetch):
```js
    const legs = db.prepare(`
        SELECT rl.*, sf.name AS from_system_name, sf.x AS from_x, sf.y AS from_y,
               st.name AS to_system_name,   st.x AS to_x,   st.y AS to_y
        FROM route_legs rl
        LEFT JOIN systems sf ON sf.id = rl.from_system_id
        LEFT JOIN systems st ON st.id = rl.to_system_id
        WHERE rl.route_id IN (${marks})
        ORDER BY rl.route_id, rl.leg_index
    `).all(...ids);
```
After — note `marks` was only ever used to build the `IN (...)` placeholder string, which
now lives inside the repo function; remove the now-unused `const marks = ids.map(() => '?').join(',');`
line above this call site too:
```js
    const legs = routingRepo.getRouteLegsForRouteIds(ids);
```

Before (`GET /routes` list):
```js
        const rows = db.prepare(`
            SELECT r.*, u.game_name AS author_name
            FROM routes r
            LEFT JOIN app_users u ON u.id = r.author_id
            WHERE r.visibility = 'alliance' OR r.author_id = ?
            ORDER BY COALESCE(r.planned_start_at, r.created_at) ASC
        `).all(req.session.userId);
```
After:
```js
        const rows = routingRepo.getRoutesForUser(req.session.userId);
```

Before (`GET /routes/:id`):
```js
        const row = db.prepare(`
            SELECT r.*, u.game_name AS author_name
            FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
            WHERE r.id = ?
        `).get(req.params.id);
```
After:
```js
        const row = routingRepo.getRouteById(req.params.id);
```

Before (`writeRoute`'s transaction body):
```js
    const tx = db.transaction(() => {
        let id = routeId;
        if (id) {
            db.prepare(`
                UPDATE routes SET title=?, note=?, planned_start_at=?, energy=?, race_speed=?,
                                  is_alliance_move=?, biology=?, visibility=?, expires_at=?,
                                  updated_at=CURRENT_TIMESTAMP
                WHERE id=?
            `).run(title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, id);
            db.prepare(`DELETE FROM route_legs WHERE route_id = ?`).run(id);
        } else {
            const r = db.prepare(`
                INSERT INTO routes (author_id, title, note, planned_start_at, energy, race_speed,
                                    is_alliance_move, biology, visibility, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt);
            id = r.lastInsertRowid;
        }

        const ins = db.prepare(`
            INSERT INTO route_legs (route_id, leg_index, from_system_id, from_planet_index,
                                    to_system_id, to_planet_index, travel_seconds, distance, bio_needed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const l of built.legs) {
            ins.run(id, l.legIndex, l.from.systemId, l.from.planetIndex,
                    l.to.systemId, l.to.planetIndex, l.travelSeconds, l.distance, l.bioNeeded);
        }
        return id;
    });
```
After — the `db.transaction(...)` wrapper itself stays (this is what preserves atomicity
across the update/insert-legs or insert-route/insert-legs sequence):
```js
    const tx = db.transaction(() => {
        let id = routeId;
        if (id) {
            routingRepo.updateRoute(id, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt);
            routingRepo.deleteRouteLegsForRoute(id);
        } else {
            id = routingRepo.insertRoute(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt);
        }

        for (const l of built.legs) {
            routingRepo.insertRouteLeg(id, l.legIndex, l.from.systemId, l.from.planetIndex,
                    l.to.systemId, l.to.planetIndex, l.travelSeconds, l.distance, l.bioNeeded);
        }
        return id;
    });
```

Before (`PUT /routes/:id` ownership check):
```js
        const row = db.prepare(`SELECT id, author_id FROM routes WHERE id = ?`).get(req.params.id);
```
After:
```js
        const row = routingRepo.getRouteOwnership(req.params.id);
```

Before (`DELETE /routes/:id`):
```js
        const row = db.prepare(`SELECT id, author_id FROM routes WHERE id = ?`).get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (!mayModify(row, req.session)) {
            return res.status(403).json({ error: 'That route belongs to someone else. Ask them or an admin to remove it.' });
        }
        db.prepare(`DELETE FROM route_legs WHERE route_id = ?`).run(row.id);
        db.prepare(`DELETE FROM routes WHERE id = ?`).run(row.id);
```
After — preserve the exact same NOT-transactional two-step sequence (see Global
Constraints: do not add a transaction here):
```js
        const row = routingRepo.getRouteOwnership(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (!mayModify(row, req.session)) {
            return res.status(403).json({ error: 'That route belongs to someone else. Ask them or an admin to remove it.' });
        }
        routingRepo.deleteRouteLegsForRoute(row.id);
        routingRepo.deleteRoute(row.id);
```

Before (`POST /routes/:id/announce`):
```js
        const row = db.prepare(`
            SELECT r.*, u.game_name AS author_name
            FROM routes r LEFT JOIN app_users u ON u.id = r.author_id
            WHERE r.id = ?
        `).get(req.params.id);
```
After:
```js
        const row = routingRepo.getRouteById(req.params.id);
```

**Report file:** `task-10-report.md`.

## Task 11: Regression pass

Run the full test suite and confirm all suites pass, including the four new repository
test files (`notes.test.js`, `settings.test.js`, `routing.test.js` — `round-archive.test.js`
should be UNCHANGED and still passing, since Task 4 only added one new function to that
file and did not touch its existing five). Confirm no source-text regex test elsewhere
references the old raw-SQL literal locations that just moved — spot-check
`grep -rn "user_notes\|app_settings\|FROM routes\|route_legs" src/**/*.test.js` for any
test file outside `src/repositories/` that scans source text for these tables (none are
known to exist from this domain's extraction, but confirm rather than assume — do NOT
include `round-archive.test.js` in this concern since it was explicitly ruled out of scope
for these four tables and its own `round_players`/`rounds`-related regex checks near the
bottom of that file, e.g. checking `admin.js`'s nuke-intel ordering, are about a DIFFERENT
table group entirely and remain correct since `admin.js`'s `archiveRound` call site is
untouched by this domain).

**Report file:** `task-11-report.md` — full test run output summary (pass/fail counts per suite).
