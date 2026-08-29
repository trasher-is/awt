# Database Refactor — discordTimers domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every raw `db.prepare()` call site touching the `discord_timers` table into a new
`src/repositories/discordTimers.js` module, mirroring the pattern established by the five prior
domain plans.

**Architecture:** New `src/repositories/discordTimers.js`. Same conventions as before: module-level
`const` prepared statements, named exported functions, no error-handling changes, behavior-preserving
1:1 moves — no dedups or distinct-pairs needed in this domain, it's the simplest one yet. Three call
sites, all in `src/discord_bot.js` (the `!timer` command and its once-a-minute due-timer poll), no
transactions anywhere in this domain.

**Test note:** `src/utils/discord.test.js` already contains genuine functional/behavioral tests
against this table (it calls `handleTimer`/`checkDueTimers` directly and inspects real row state
afterward via `db.prepare()`, seeding and cleaning up with `discord_user_id LIKE 'test-%'` rows).
This is NOT a source-text scan like the tests that broke in four of the five prior domains — it
tests actual behavior, which this refactor does not change — so it is expected to keep passing
unmodified. Still run it explicitly in Task 3 to confirm.

**Tech Stack:** Node.js, better-sqlite3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Global Constraints

- No SQL text, parameter order, or return-shape changes for any migrated query. No dedups in this
  domain — every function is an exact 1:1 move.
- The `markFired` statement in the original code is prepared fresh on every `checkDueTimers()`
  invocation (inside the function body, not at module scope) — moving it to the repository as a
  module-level `const` is the intended pattern and a free correctness-neutral perf win, exactly like
  the first domain's sync.js statements.
- No error-handling changes — the INSERT's try/catch and the SELECT's try/catch stay in
  `discord_bot.js` exactly as they are; the per-timer try/catch/finally around the Discord API call
  and `markFired.run(t.id)` also stays in `discord_bot.js`.
- No transactions in this domain — nothing to preserve there.
- **Verification lesson from all five prior domains**: a single-line grep misses multi-line
  queries. The "verify no call sites were missed" step requires reading each remaining
  `db.prepare()` call's actual SQL text, not just running the naive grep.
- After the migration step, restart `awt-test` (`pm2 restart awt-test`) and manually exercise
  `!timer` before moving to the next task.

## File Structure

- Create: `src/repositories/discordTimers.js`
- Create: `src/repositories/discordTimers.test.js`
- Modify: `src/discord_bot.js`

---

### Task 1: `src/repositories/discordTimers.js`

**Files:**
- Create: `src/repositories/discordTimers.js`
- Test: `src/repositories/discordTimers.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Task 2):
  - `insertTimer(discordUserId, channelId, label, dueAt): void`
  - `getDueTimers(nowIso): Array<{id, discord_user_id, channel_id, label, due_at}>`
  - `markTimerFired(id): void`

- [ ] **Step 1: Write the module**

Create `src/repositories/discordTimers.js`:

```js
const db = require('../database');

const insertTimerStmt = db.prepare(`
    INSERT INTO discord_timers (discord_user_id, channel_id, label, due_at)
    VALUES (?, ?, ?, ?)
`);
function insertTimer(discordUserId, channelId, label, dueAt) {
    insertTimerStmt.run(discordUserId, channelId, label, dueAt);
}

const getDueTimersStmt = db.prepare(`
    SELECT id, discord_user_id, channel_id, label, due_at
    FROM discord_timers
    WHERE fired_at IS NULL AND due_at <= ?
    ORDER BY due_at ASC
    LIMIT 50
`);
function getDueTimers(nowIso) {
    return getDueTimersStmt.all(nowIso);
}

const markTimerFiredStmt = db.prepare(`UPDATE discord_timers SET fired_at = CURRENT_TIMESTAMP WHERE id = ?`);
function markTimerFired(id) {
    markTimerFiredStmt.run(id);
}

module.exports = { insertTimer, getDueTimers, markTimerFired };
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/discordTimers.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const timers = require('./discordTimers');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('discordTimers.test.js');

const past = new Date(Date.now() - 60000).toISOString();
const future = new Date(Date.now() + 3600000).toISOString();

timers.insertTimer('user-1', 'chan-1', 'a past-due timer', past);
timers.insertTimer('user-1', 'chan-1', 'a future timer', future);

const dueNow = timers.getDueTimers(new Date().toISOString());
ok('getDueTimers finds only the past-due row', dueNow.length === 1 && dueNow[0].label === 'a past-due timer');

timers.markTimerFired(dueNow[0].id);
ok('markTimerFired sets fired_at', !!db.prepare('SELECT fired_at FROM discord_timers WHERE id = ?').get(dueNow[0].id).fired_at);

const dueAfterFiring = timers.getDueTimers(new Date().toISOString());
ok('getDueTimers no longer returns the fired row', dueAfterFiring.length === 0);

const stillFuture = db.prepare(`SELECT COUNT(*) c FROM discord_timers WHERE fired_at IS NULL`).get().c;
ok('the future timer is untouched and still unfired', stillFuture === 1);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `discordTimers.js`, run `node src/repositories/discordTimers.test.js`, confirm
it errors with `Cannot find module './discordTimers'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/discordTimers.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/discordTimers.js src/repositories/discordTimers.test.js
git commit -m "Add discordTimers repository module"
```

---

### Task 2: Migrate `src/discord_bot.js`

**Files:**
- Modify: `src/discord_bot.js`

**Interfaces:**
- Consumes: `discordTimers` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`plansRepo`/`playersRepo`/
`alliancesRepo`/`usersRepo` imports, add:
```js
const discordTimersRepo = require('./repositories/discordTimers');
```

- [ ] **Step 2: `handleTimer`'s insert**

Before:
```js
    try {
        db.prepare(`
            INSERT INTO discord_timers (discord_user_id, channel_id, label, due_at)
            VALUES (?, ?, ?, ?)
        `).run(userId, channelId, String(input).slice(0, 200), dueAt.toISOString());
    } catch (err) {
        console.error('[Discord] Could not store timer:', err.message);
        return reply('❌ Could not save that timer. Try again.');
    }
```
After:
```js
    try {
        discordTimersRepo.insertTimer(userId, channelId, String(input).slice(0, 200), dueAt.toISOString());
    } catch (err) {
        console.error('[Discord] Could not store timer:', err.message);
        return reply('❌ Could not save that timer. Try again.');
    }
```

- [ ] **Step 3: `checkDueTimers`'s due-lookup**

Before:
```js
    let due;
    try {
        due = db.prepare(`
            SELECT id, discord_user_id, channel_id, label, due_at
            FROM discord_timers
            WHERE fired_at IS NULL AND due_at <= ?
            ORDER BY due_at ASC
            LIMIT 50
        `).all(new Date().toISOString());
    } catch (err) {
        console.error('[Discord] Timer lookup failed:', err.message);
        return;
    }
```
After:
```js
    let due;
    try {
        due = discordTimersRepo.getDueTimers(new Date().toISOString());
    } catch (err) {
        console.error('[Discord] Timer lookup failed:', err.message);
        return;
    }
```

- [ ] **Step 4: `checkDueTimers`'s mark-fired**

Before:
```js
    const markFired = db.prepare(`UPDATE discord_timers SET fired_at = CURRENT_TIMESTAMP WHERE id = ?`);
    for (const t of due) {
        try {
            const channel = await client.channels.fetch(t.channel_id);
            if (channel && typeof channel.send === 'function') {
                const late = Date.now() - new Date(t.due_at).getTime();
                // If the bot was down, say so instead of pretending it was on time.
                const lateNote = late > 120000 ? ` _(fired ${Math.round(late / 60000)} min late — the bot was not running)_` : '';
                await channel.send(`🔔 <@${t.discord_user_id}> **TIME IS UP!** Your timer for "${t.label}" has finished.${lateNote}`);
            }
        } catch (err) {
            // A deleted channel must not stop the rest of the queue, and must not leave
            // this row to be retried forever.
            console.error(`[Discord] Timer ${t.id} ping failed:`, err.message);
        } finally {
            markFired.run(t.id);
        }
    }
```
After:
```js
    for (const t of due) {
        try {
            const channel = await client.channels.fetch(t.channel_id);
            if (channel && typeof channel.send === 'function') {
                const late = Date.now() - new Date(t.due_at).getTime();
                // If the bot was down, say so instead of pretending it was on time.
                const lateNote = late > 120000 ? ` _(fired ${Math.round(late / 60000)} min late — the bot was not running)_` : '';
                await channel.send(`🔔 <@${t.discord_user_id}> **TIME IS UP!** Your timer for "${t.label}" has finished.${lateNote}`);
            }
        } catch (err) {
            // A deleted channel must not stop the rest of the queue, and must not leave
            // this row to be retried forever.
            console.error(`[Discord] Timer ${t.id} ping failed:`, err.message);
        } finally {
            discordTimersRepo.markTimerFired(t.id);
        }
    }
```

- [ ] **Step 5: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/discord_bot.js | grep -i "discord_timers"`.
Expected: no output. Then run `grep -rln "discord_timers" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js"` — expected: no output either, confirming `discord_bot.js` was this domain's sole consumer.

- [ ] **Step 6: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`, confirm the Discord bot reconnects. In the Discord test
server, run `!timer 1min` and wait slightly over a minute to confirm it fires (or check
`src/repositories/discordTimers.js`'s table directly via a quick `sqlite3` query if you don't want
to wait).

- [ ] **Step 7: Commit**

```bash
cd /root/awt-test
git add src/discord_bot.js
git commit -m "Migrate discord_bot.js discord_timers queries to the repository layer"
```

---

### Task 3: Full regression pass and close out the domain

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /root/awt-test && npm test`
Expected: all suites pass (including the new `repositories/discordTimers.test.js`), exit code 0.
Pay specific attention to `src/utils/discord.test.js` — per this plan's Test note, it does genuine
functional/behavioral testing against this table (not a source-text scan), so it should pass
unmodified; if it fails, read the failure carefully before assuming it's the same source-text-drift
pattern as prior domains, since this one's mechanism is different.

- [ ] **Step 2: Confirm zero remaining raw call sites for this domain, codebase-wide**

```bash
cd /root/awt-test && grep -rln "discord_timers" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js"
```
Expected: no output.

- [ ] **Step 3: Final end-to-end pass on `awt-test`**

Run: `pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 30 --nostream`
Expected: clean boot, no errors, Discord bot reconnects.
