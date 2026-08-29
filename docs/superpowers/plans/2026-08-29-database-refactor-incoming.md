# Database Refactor: incoming (incoming_msgs)

## Goal

Extract every raw `db.prepare(...)` call touching the `incoming_msgs` table into a new
`src/repositories/incoming.js` repository module, following the exact pattern established by
the six prior domains (systems/fleets/plans, players, alliances, users, trade, discordTimers):
module-level compiled-once prepared statements + thin exported wrapper functions + a single
trailing `module.exports = {...}`.

This is the seventh of nine planned domains. Remaining after this one: notes/settings/routing/rounds,
battleReports.

## Spec

Reference: `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Background

The `incoming_alerts` table (created in `src/database.js`) is a real table but is **never
referenced by name** in any call site outside the schema file — no runtime code does
`FROM incoming_alerts` / `INTO incoming_alerts` / etc. anywhere in `src/`. This was confirmed by
an exhaustive repo-wide search for the literal strings `incoming_alerts` and `incoming_msgs`
across every `.js` file (not just `src/routes/incoming.js`). Consequently this domain's
repository module only needs functions for `incoming_msgs` — there is nothing to migrate for
`incoming_alerts`. Do not invent functions for it.

All 7 real call sites key off `alert_key` and are plain (non-transactional) `db.prepare(...)`
calls — there is no `db.transaction(...)` anywhere in this domain.

## Call sites (verified directly against source, line numbers as of this plan's writing)

### `src/utils/covering.js`

1. **Line 13** — `getCovering(alertKey)`
   ```js
   const row = db.prepare(`SELECT covering FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
   ```
2. **Lines 23-26** — `setCovering(alertKey, names)`
   ```js
   db.prepare(`
       INSERT INTO incoming_msgs (alert_key, covering) VALUES (?, ?)
       ON CONFLICT(alert_key) DO UPDATE SET covering = excluded.covering, updated_at = CURRENT_TIMESTAMP
   `).run(alertKey, names.join('\n'));
   ```

### `src/discord_bot.js`

3. **Lines 1642-1648** — `record(msgId)` closure inside `sendOrEditIncoming(alertKey, content)`
   ```js
   const record = (msgId) => db.prepare(`
       INSERT INTO incoming_msgs (alert_key, channel_id, message_id) VALUES (?, ?, ?)
       ON CONFLICT(alert_key) DO UPDATE SET
           channel_id = excluded.channel_id,
           message_id = excluded.message_id,
           updated_at = CURRENT_TIMESTAMP
   `).run(alertKey, channelId, msgId);
   ```
   Called as `record(sent.id)` only when a brand-new Discord message was posted (not on edit).
4. **Line 1654** — same function, "try to edit the existing alert first":
   ```js
   existing = alertKey != null
       ? db.prepare(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`).get(alertKey)
       : null;
   ```
5. **Line 1690** — `updateIncomingCover(alertKey)`:
   ```js
   row = db.prepare(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
   ```

### `src/routes/incoming.js`

6. **Line 262** — inside `announceIncoming(data)`:
   ```js
   const prevRow = db.prepare(`SELECT last_ontime FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
   ```
7. **Line 272** — same function, a few lines later:
   ```js
   db.prepare(`UPDATE incoming_msgs SET last_ontime = ? WHERE alert_key = ?`).run(current.join(','), alertKey);
   ```

## Global Constraints

**Dedup (sanctioned):** Call sites #4 and #5 are byte-identical SQL
(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`) used at two call sites
in `discord_bot.js`. Consolidate into ONE repository function: `getMessageRef(alertKey)`.

**Distinct pair — do NOT merge:** `covering.js`'s `setCovering` upsert (#2, writes only
`covering`) and `discord_bot.js`'s `record` upsert (#3, writes only `channel_id`/`message_id`)
target different columns of the same row and must remain two separate repository functions
(`upsertCovering` and `upsertMessageRef`). Do not attempt to combine them into one
all-columns upsert — that would change behavior (e.g. `upsertCovering` would start
clobbering `channel_id`/`message_id` with NULLs on a fresh INSERT branch when the row doesn't
already exist, since a single combined INSERT requires values for all listed columns).

**No transactions in this domain** — every call site is a bare `db.prepare(...).get()/.run()`.
Nothing to preserve in that regard.

**Error handling stays in the caller.** Several call sites are already wrapped in `try/catch`
in their original files (e.g. `covering.js`'s `getCovering` swallows errors and returns `[]`;
`discord_bot.js`'s `updateIncomingCover` catches and returns `false`). The repository functions
themselves must NOT add their own try/catch — they should just run the prepared statement and
return/throw normally, exactly like every prior domain's repository functions. Preserve the
existing try/catch blocks in the calling files unchanged; only the inner `db.prepare(...)` line
moves into the repository call.

**Verification technique:** confirmed via a full-file read (not line-anchored grep) that these
are the ONLY 7 real call sites for `incoming_msgs` in `src/`, and that `incoming_alerts` has
zero runtime call sites. Do not re-scan for more — this list is exhaustive and already verified.

## File Structure

- `src/repositories/incoming.js` (new)
- `src/repositories/incoming.test.js` (new)
- `src/utils/covering.js` (migrate call sites #1, #2)
- `src/discord_bot.js` (migrate call sites #3, #4, #5 — #4/#5 dedup to one shared call)
- `src/routes/incoming.js` (migrate call sites #6, #7)

## Task 1: Create `src/repositories/incoming.js` and its smoke test

Create `src/repositories/incoming.js` with this exact content:

```js
const db = require('../database');

const getCoveringRowStmt = db.prepare(`SELECT covering FROM incoming_msgs WHERE alert_key = ?`);
function getCoveringRow(alertKey) {
    return getCoveringRowStmt.get(alertKey);
}

const upsertCoveringStmt = db.prepare(`
    INSERT INTO incoming_msgs (alert_key, covering) VALUES (?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET covering = excluded.covering, updated_at = CURRENT_TIMESTAMP
`);
function upsertCovering(alertKey, covering) {
    upsertCoveringStmt.run(alertKey, covering);
}

const upsertMessageRefStmt = db.prepare(`
    INSERT INTO incoming_msgs (alert_key, channel_id, message_id) VALUES (?, ?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertMessageRef(alertKey, channelId, messageId) {
    upsertMessageRefStmt.run(alertKey, channelId, messageId);
}

const getMessageRefStmt = db.prepare(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`);
function getMessageRef(alertKey) {
    return getMessageRefStmt.get(alertKey);
}

const getLastOntimeRowStmt = db.prepare(`SELECT last_ontime FROM incoming_msgs WHERE alert_key = ?`);
function getLastOntimeRow(alertKey) {
    return getLastOntimeRowStmt.get(alertKey);
}

const updateLastOntimeStmt = db.prepare(`UPDATE incoming_msgs SET last_ontime = ? WHERE alert_key = ?`);
function updateLastOntime(alertKey, lastOntime) {
    updateLastOntimeStmt.run(lastOntime, alertKey);
}

module.exports = {
    getCoveringRow, upsertCovering, upsertMessageRef, getMessageRef,
    getLastOntimeRow, updateLastOntime
};
```

Then create `src/repositories/incoming.test.js`, following the exact style of
`src/repositories/discordTimers.test.js` (temp DB via `AWT_DB_PATH`, plain `ok()` helper,
`process.exit(1)` on failure). It must exercise:

- `getCoveringRow` returns `undefined` for an alert_key with no row yet.
- `upsertCovering` on a fresh alert_key creates the row; `getCoveringRow` then returns it.
- `upsertCovering` called again on the SAME alert_key updates `covering` (and does not error).
- `upsertMessageRef` on a fresh alert_key creates the row; `getMessageRef` returns
  `{ message_id, channel_id }` matching what was written.
- `upsertMessageRef` called again on the same alert_key updates `channel_id`/`message_id`.
- Calling `upsertCovering` then `upsertMessageRef` on the SAME alert_key (simulating the
  real-world race between a News-panel covering claim and a Discord message being recorded)
  results in a single row with both the covering text AND the message ref intact — i.e.
  confirm the two upserts don't clobber each other's columns.
- `getLastOntimeRow` returns `undefined` before any `updateLastOntime` call, then
  `updateLastOntime` followed by `getLastOntimeRow` round-trips the value.

Run `node src/repositories/incoming.test.js` directly to confirm it passes before moving on.

**Report file:** none needed — this is a single self-contained task; report DONE/BLOCKED status only.

## Task 2: Migrate `src/utils/covering.js`

Replace call site #1 (line 13) and call site #2 (lines 23-26).

Before:
```js
const db = require('../database');
```
After (add the repository import; keep the existing `db` require only if anything else in the
file still needs it directly — check before removing. In this file nothing else uses `db`, so
replace the require entirely):
```js
const incomingRepo = require('../repositories/incoming');
```

Before (`getCovering`):
```js
function getCovering(alertKey) {
    try {
        const row = db.prepare(`SELECT covering FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
        return row && row.covering ? row.covering.split('\n').filter(Boolean) : [];
    } catch (e) {
        return [];
    }
}
```
After:
```js
function getCovering(alertKey) {
    try {
        const row = incomingRepo.getCoveringRow(alertKey);
        return row && row.covering ? row.covering.split('\n').filter(Boolean) : [];
    } catch (e) {
        return [];
    }
}
```

Before (`setCovering`):
```js
function setCovering(alertKey, names) {
    // The incoming_msgs row usually already exists (created when the alert was first sent),
    // but a News-panel claim can race ahead of that — upsert so it's never lost.
    db.prepare(`
        INSERT INTO incoming_msgs (alert_key, covering) VALUES (?, ?)
        ON CONFLICT(alert_key) DO UPDATE SET covering = excluded.covering, updated_at = CURRENT_TIMESTAMP
    `).run(alertKey, names.join('\n'));
}
```
After:
```js
function setCovering(alertKey, names) {
    // The incoming_msgs row usually already exists (created when the alert was first sent),
    // but a News-panel claim can race ahead of that — upsert so it's never lost.
    incomingRepo.upsertCovering(alertKey, names.join('\n'));
}
```

Nothing else in this file touches `db` — verify that after the edit (`grep -n "db\." src/utils/covering.js`
should return nothing) and remove the old `const db = require('../database');` line entirely.

**Report file:** `task-2-report.md` (per this skill's convention) — status + confirmation the
`db` require was removed cleanly (or a note if something else in the file still needed it).

## Task 3: Migrate `src/discord_bot.js`

Migrate call sites #3, #4, #5. Do NOT touch any other `db.prepare` calls in this large file —
only the three inside `sendOrEditIncoming` and `updateIncomingCover` that reference
`incoming_msgs`.

Add near the top of the file, alongside the other repository requires already present from
prior domains (e.g. `const usersRepo = require('./repositories/users');` — match that exact
existing style/location):
```js
const incomingRepo = require('./repositories/incoming');
```

Before (`record` closure, call site #3):
```js
    const record = (msgId) => db.prepare(`
        INSERT INTO incoming_msgs (alert_key, channel_id, message_id) VALUES (?, ?, ?)
        ON CONFLICT(alert_key) DO UPDATE SET
            channel_id = excluded.channel_id,
            message_id = excluded.message_id,
            updated_at = CURRENT_TIMESTAMP
    `).run(alertKey, channelId, msgId);
```
After:
```js
    const record = (msgId) => incomingRepo.upsertMessageRef(alertKey, channelId, msgId);
```

Before (call site #4, "try to edit the existing alert first"):
```js
    let existing = null;
    try {
        existing = alertKey != null
            ? db.prepare(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`).get(alertKey)
            : null;
    } catch (err) { existing = null; }
```
After:
```js
    let existing = null;
    try {
        existing = alertKey != null ? incomingRepo.getMessageRef(alertKey) : null;
    } catch (err) { existing = null; }
```

Before (call site #5, in `updateIncomingCover`):
```js
    let row;
    try {
        row = db.prepare(`SELECT message_id, channel_id FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
    } catch (e) { return false; }
```
After:
```js
    let row;
    try {
        row = incomingRepo.getMessageRef(alertKey);
    } catch (e) { return false; }
```

This is the sanctioned dedup: call sites #4 and #5 both now call the same
`incomingRepo.getMessageRef(alertKey)`. Do not create two separate functions for these.

Leave every other `db.prepare` call in `discord_bot.js` completely untouched (this file has
many call sites belonging to other already-migrated or not-yet-migrated domains — e.g. the
`!link` transaction near line 133 is unrelated user/link-code logic from the users domain).

**Report file:** `task-3-report.md` — status + confirmation no other `db.prepare` calls in this
file were touched, and that `node -e "require('./src/discord_bot.js')"` (or the project's normal
syntax-check/lint step) doesn't error on load.

## Task 4: Migrate `src/routes/incoming.js`

Migrate call sites #6 and #7, inside `announceIncoming(data)`.

Add near the top of the file, alongside the existing `playersRepo`/`systemsRepo` requires
already present from prior domains (match their exact style):
```js
const incomingRepo = require('../repositories/incoming');
```

Before:
```js
    try {
        const prevRow = db.prepare(`SELECT last_ontime FROM incoming_msgs WHERE alert_key = ?`).get(alertKey);
        const prev = prevRow && prevRow.last_ontime ? prevRow.last_ontime.split(',').filter(Boolean) : [];
        const prevSet = new Set(prev);
        const newcomers = current.filter(n => !prevSet.has(n));

        if (sent.edited && newcomers.length > 0) {
            const planetLabel = `${data.target.planetName || 'Planet'} [${data.target.systemId}] #${data.target.planetIndex}`;
            const reply = buildReply(defenders, planetLabel, data.target);
            if (reply) replied = await replyToIncoming(sent.channelId, sent.messageId, reply);
        }
        db.prepare(`UPDATE incoming_msgs SET last_ontime = ? WHERE alert_key = ?`).run(current.join(','), alertKey);
    } catch (e) {
        console.error('[Incoming] reply bookkeeping failed:', e.message);
    }
```
After:
```js
    try {
        const prevRow = incomingRepo.getLastOntimeRow(alertKey);
        const prev = prevRow && prevRow.last_ontime ? prevRow.last_ontime.split(',').filter(Boolean) : [];
        const prevSet = new Set(prev);
        const newcomers = current.filter(n => !prevSet.has(n));

        if (sent.edited && newcomers.length > 0) {
            const planetLabel = `${data.target.planetName || 'Planet'} [${data.target.systemId}] #${data.target.planetIndex}`;
            const reply = buildReply(defenders, planetLabel, data.target);
            if (reply) replied = await replyToIncoming(sent.channelId, sent.messageId, reply);
        }
        incomingRepo.updateLastOntime(alertKey, current.join(','));
    } catch (e) {
        console.error('[Incoming] reply bookkeeping failed:', e.message);
    }
```

Note the parameter order flip: the repository's `updateLastOntime(alertKey, lastOntime)` takes
`alertKey` first (matching every other repo function's convention of key-first), while the raw
SQL had `(current.join(','), alertKey)` in bind order matching `SET last_ontime = ? WHERE alert_key = ?`.
Confirm the call site passes `(alertKey, current.join(','))` in that order, matching the
function signature in Task 1 — NOT the raw SQL's bind order.

Check whether `db` (`require('../database')`) is still used elsewhere in this file before
removing its require — `src/routes/incoming.js` likely has other call sites belonging to other
domains or not-yet-migrated domains; if so, leave the `db` require in place untouched.

**Report file:** `task-4-report.md` — status + note on whether the `db` require was removed or
kept (and why).

## Task 5: Regression pass

Run the full test suite (`npm test` or equivalent project test runner) and confirm all suites
pass, including the new `src/repositories/incoming.test.js`. Confirm no source-text regex test
elsewhere in the suite references the old `db.prepare(...incoming_msgs...)` literal locations
that just moved (spot-check: `grep -rn "incoming_msgs" src/**/*.test.js` for any test file
outside `src/repositories/` that scans source text for this table name — none are known to
exist from this domain's extraction, but confirm rather than assume).

**Report file:** `task-5-report.md` — full test run output summary (pass/fail counts per suite).
