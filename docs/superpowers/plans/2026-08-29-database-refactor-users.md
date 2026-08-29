# Database Refactor — users domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every raw `db.prepare()` call site touching the `app_users` and `discord_link_codes`
tables into a new `src/repositories/users.js` module, mirroring the pattern established by
`systems.js`/`fleets.js`/`plans.js`/`players.js`/`alliances.js` from the four prior domain plans.

**Architecture:** New `src/repositories/users.js`. Same conventions as before: module-level `const`
prepared statements, named exported functions, no error-handling changes, behavior-preserving 1:1
moves with FIVE sanctioned dedups this time (documented below — this domain has more duplicate SQL
than any prior one, because `admin.js`'s user-management panel repeats the same lookup boilerplate
across several endpoints). Where a route touches tables outside this domain in the same handler, only
the app_users/discord_link_codes calls migrate — the rest stay raw `db.prepare()` until their own
domain's plan runs (`players`/`alliances` are already migrated and untouched here; `user_notes`,
`routes`/`route_legs`, `battle_reports`, everything else stays raw).

**Security note:** this domain includes `src/routes/auth.js` (login, session, the Discord account-link
minting flow, and the anti-credential-sharing "nuke" ban) and `src/discord_bot.js`'s account-linking
challenge/response flow. These are exact 1:1 SQL moves like everything else in this refactor — no
authentication or authorization logic changes — but extra care migrating and verifying them is
warranted given what they protect.

**Tech Stack:** Node.js, better-sqlite3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Global Constraints

- No SQL text, parameter order, or return-shape changes for any migrated query, with exactly FIVE
  documented dedups (each consolidates byte-identical SQL used at multiple original call sites,
  same category as `createPlan` in the plans domain and `getPlayerCombatStats` in the players
  domain):
  1. `getUserByDiscordId(discordId)` — consolidates two identical
     `SELECT game_name FROM app_users WHERE discord_id = ?` lookups in `discord_bot.js` (the cover
     button handler and `handleLink`'s "already linked?" check).
  2. `getUserByDiscordName(discordName, atDiscordName)` — consolidates two identical
     `SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`
     lookups in `discord_bot.js` (`!bio` and `!plan`).
  3. `getUserNameById(id)` — consolidates FOUR identical
     `SELECT game_name FROM app_users WHERE id = ?` lookups in `admin.js` (edit-name load,
     delete-user load, change-role load, change-password load).
  4. `deleteExpiredLinkCodes()` — consolidates two identical
     `DELETE FROM discord_link_codes WHERE expires_at < datetime('now')` statements, one in
     `discord_bot.js`'s `handleLink` (wrapped in try/catch there — the repo function itself has no
     try/catch, matching the "no error-handling changes" rule; the caller keeps its own try/catch),
     one in `auth.js`'s `/link-code` mint transaction.
  5. `markLinkCodeUsed(discordId, code)` — consolidates two identical
     `UPDATE discord_link_codes SET used_at = CURRENT_TIMESTAMP, used_by_discord_id = ? WHERE code = ?`
     statements in `discord_bot.js` (the "already linked to you" short-circuit, and the real link
     commit inside a transaction).
  Every other function is an exact 1:1 move — in particular, do NOT merge any of these
  look-alike-but-distinct statements:
  - `admin.js`'s `SELECT game_name, discord_id, discord_name FROM app_users WHERE id = ?`
    (3 columns) vs. `auth.js`'s `SELECT id, game_name, discord_id, discord_name FROM app_users
    WHERE id = ?` (4 columns, includes `id`) — different column lists, stay as
    `getUserDiscordInfoById(id)` and `getUserById(id)` respectively.
  - `auth.js`'s `DELETE FROM discord_link_codes WHERE user_id = ? AND used_at IS NULL` vs.
    `admin.js`'s `DELETE FROM discord_link_codes WHERE user_id = ?` (no `used_at` filter) — stay as
    `deleteUnusedLinkCodesForUser(userId)` and `deleteLinkCodesByUserId(userId)` respectively.
- Prepared statements compiled once at module load, except `getValidActiveUserIds` (variable-arity
  id array, matching the `getSystemsByIds` pattern from the first domain).
- No error-handling changes — try/catch and HTTP status codes stay in calling routes.
- Two small multi-statement transactions in this domain touch ONLY this domain's own two tables
  (unlike prior domains' cross-domain transactions) — no domain-boundary risk, but still move as a
  unit and verify the transaction wrapper itself is untouched:
  1. `discord_bot.js`'s `handleLink` link-commit: `UPDATE app_users` then `UPDATE discord_link_codes`.
  2. `auth.js`'s `/link-code` mint: `DELETE ... unused`, `DELETE ... expired`, `INSERT` — three
     statements, all `discord_link_codes`.
  3. `admin.js`'s clear-discord-link: `UPDATE app_users` (clear fields) then
     `DELETE FROM discord_link_codes WHERE user_id = ?`.
- **Verification lesson from four prior domains**: a single-line grep misses multi-line queries —
  this caused real gaps caught only by final reviews. Every "verify no call sites were missed" step
  in this plan requires reading each remaining `db.prepare()`/`db.transaction()` block's actual SQL
  text, not just running the naive grep. Also **re-run the full test suite** (`npm test`) after each
  file's migration and watch for any test asserting against literal source text containing
  `app_users`/`discord_link_codes` SQL — this exact failure mode hit three of the four prior domains.
- After each task's migration step, restart `awt-test` (`pm2 restart awt-test`) and manually
  exercise the affected feature before moving to the next task.

## File Structure

- Create: `src/repositories/users.js`
- Create: `src/repositories/users.test.js`
- Modify: `src/discord_bot.js`, `src/routes/auth.js`, `src/routes/admin.js`,
  `src/utils/interceptors.js`, `src/routes/notes.js`, `src/routes/intel.js`

---

### Task 1: `src/repositories/users.js`

**Files:**
- Create: `src/repositories/users.js`
- Test: `src/repositories/users.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Tasks 2–5):
  - `getUserByDiscordId(discordId): {game_name} | undefined`
  - `getUserByDiscordName(discordName, atDiscordName): {id, game_name} | undefined`
  - `getUserAllianceTagByDiscordName(discordName, atDiscordName): {tag} | undefined`
  - `getUserMentionByGameName(gameNameLower): {discord_id} | undefined`
  - `getActiveRecipientsExcludingAdmin(sessionUserId): Array<{id, game_name}>`
  - `getValidActiveUserIds(ids: number[]): Array<{id}>`
  - `getUserByGameName(gameName): object | undefined`
  - `getUserAllianceIdBridge(userId): {alliance_id} | undefined`
  - `getUserById(id): {id, game_name, discord_id, discord_name} | undefined`
  - `getAllUsersWithIdle(): Array<object>`
  - `getUserNameById(id): {game_name} | undefined`
  - `getUserDiscordInfoById(id): {game_name, discord_id, discord_name} | undefined`
  - `getUserActiveStatusById(id): {game_name, is_active} | undefined`
  - `getAdminPasswordHash(): {password_hash} | undefined`
  - `getActiveMemberNames(): Array<{game_name}>`
  - `updateUserGameName(id, newName): void`
  - `deleteUser(id): void`
  - `createUser(gameName, passwordHash, role, discordName): void`
  - `updateUserDiscordName(id, discordName): void`
  - `clearUserDiscordFields(id): void`
  - `setUserActive(id, isActive): void`
  - `setUserRole(id, role): void`
  - `setUserPasswordHash(id, hash): void`
  - `updateUserDiscordLink(discordId, discordName, userId): void`
  - `banUser(id): void`
  - `deleteExpiredLinkCodes(): void`
  - `getLinkCodeWithUser(code): object | undefined`
  - `markLinkCodeUsed(discordId, code): void`
  - `mintLinkCode(code, userId, expiresAt): void`
  - `deleteUnusedLinkCodesForUser(userId): void`
  - `deleteLinkCodesByUserId(userId): void`

- [ ] **Step 1: Write the module**

Create `src/repositories/users.js`:

```js
const db = require('../database');

// --- app_users: read ---

// Consolidates discord_bot.js's cover-button handler and handleLink's "already linked?"
// check — both used byte-identical SQL. See Global Constraints dedup #1.
const getUserByDiscordIdStmt = db.prepare(`SELECT game_name FROM app_users WHERE discord_id = ?`);
function getUserByDiscordId(discordId) {
    return getUserByDiscordIdStmt.get(discordId);
}

// Consolidates discord_bot.js's !bio and !plan commands — both used byte-identical SQL.
// See Global Constraints dedup #2.
const getUserByDiscordNameStmt = db.prepare(`SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`);
function getUserByDiscordName(discordName, atDiscordName) {
    return getUserByDiscordNameStmt.get(discordName, atDiscordName);
}

const getUserAllianceTagByDiscordNameStmt = db.prepare(`
    SELECT a.tag 
    FROM app_users u
    JOIN players p ON u.game_name = p.name
    JOIN alliances a ON p.alliance_id = a.id
    WHERE LOWER(u.discord_name) = ? OR LOWER(u.discord_name) = ?
`);
function getUserAllianceTagByDiscordName(discordName, atDiscordName) {
    return getUserAllianceTagByDiscordNameStmt.get(discordName, atDiscordName);
}

const getUserMentionByGameNameStmt = db.prepare(`
    SELECT discord_id FROM app_users WHERE LOWER(game_name) = ? AND discord_id IS NOT NULL
`);
function getUserMentionByGameName(gameNameLower) {
    return getUserMentionByGameNameStmt.get(gameNameLower);
}

const getActiveRecipientsExcludingAdminStmt = db.prepare(`
    SELECT id, game_name FROM app_users
    WHERE is_active = 1 AND (game_name != 'admin' OR id = ?)
    ORDER BY game_name COLLATE NOCASE
`);
function getActiveRecipientsExcludingAdmin(sessionUserId) {
    return getActiveRecipientsExcludingAdminStmt.all(sessionUserId);
}

// Arity varies per call (ids length), so prepared fresh each call — same reasoning as
// systems.js's getSystemsByIds.
function getValidActiveUserIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id FROM app_users WHERE is_active = 1 AND id IN (${placeholders})`).all(...ids);
}

const getUserByGameNameStmt = db.prepare(`SELECT * FROM app_users WHERE game_name = ?`);
function getUserByGameName(gameName) {
    return getUserByGameNameStmt.get(gameName);
}

const getUserAllianceIdBridgeStmt = db.prepare(`
    SELECT p.alliance_id AS alliance_id
    FROM app_users u
    JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
    WHERE u.id = ?
`);
function getUserAllianceIdBridge(userId) {
    return getUserAllianceIdBridgeStmt.get(userId);
}

const getUserByIdStmt = db.prepare(`SELECT id, game_name, discord_id, discord_name FROM app_users WHERE id = ?`);
function getUserById(id) {
    return getUserByIdStmt.get(id);
}

const getAllUsersWithIdleStmt = db.prepare(`
    SELECT u.id, u.game_name, u.role, u.is_active, u.discord_name, p.idle_time
    FROM app_users u
    LEFT JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
    ORDER BY u.id ASC
`);
function getAllUsersWithIdle() {
    return getAllUsersWithIdleStmt.all();
}

// Consolidates admin.js's edit-name/delete-user/change-role/change-password load queries —
// all four used byte-identical SQL. See Global Constraints dedup #3.
const getUserNameByIdStmt = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`);
function getUserNameById(id) {
    return getUserNameByIdStmt.get(id);
}

// NOT the same as getUserById above — this one omits `id` from the column list. See
// Global Constraints: these two must stay distinct.
const getUserDiscordInfoByIdStmt = db.prepare(`SELECT game_name, discord_id, discord_name FROM app_users WHERE id = ?`);
function getUserDiscordInfoById(id) {
    return getUserDiscordInfoByIdStmt.get(id);
}

const getUserActiveStatusByIdStmt = db.prepare(`SELECT game_name, is_active FROM app_users WHERE id = ?`);
function getUserActiveStatusById(id) {
    return getUserActiveStatusByIdStmt.get(id);
}

const getAdminPasswordHashStmt = db.prepare(`SELECT password_hash FROM app_users WHERE game_name = 'admin'`);
function getAdminPasswordHash() {
    return getAdminPasswordHashStmt.get();
}

const getActiveMemberNamesStmt = db.prepare(`SELECT game_name FROM app_users WHERE is_active = 1`);
function getActiveMemberNames() {
    return getActiveMemberNamesStmt.all();
}

// --- app_users: write ---

const updateUserGameNameStmt = db.prepare(`UPDATE app_users SET game_name = ? WHERE id = ?`);
function updateUserGameName(id, newName) {
    updateUserGameNameStmt.run(newName, id);
}

const deleteUserStmt = db.prepare(`DELETE FROM app_users WHERE id = ?`);
function deleteUser(id) {
    deleteUserStmt.run(id);
}

const createUserStmt = db.prepare(`INSERT INTO app_users (game_name, password_hash, role, discord_name) VALUES (?, ?, ?, ?)`);
function createUser(gameName, passwordHash, role, discordName) {
    createUserStmt.run(gameName, passwordHash, role, discordName);
}

const updateUserDiscordNameStmt = db.prepare(`UPDATE app_users SET discord_name = ? WHERE id = ?`);
function updateUserDiscordName(id, discordName) {
    updateUserDiscordNameStmt.run(discordName, id);
}

const clearUserDiscordFieldsStmt = db.prepare(`UPDATE app_users SET discord_id = NULL, discord_name = NULL WHERE id = ?`);
function clearUserDiscordFields(id) {
    clearUserDiscordFieldsStmt.run(id);
}

const setUserActiveStmt = db.prepare(`UPDATE app_users SET is_active = ? WHERE id = ?`);
function setUserActive(id, isActive) {
    setUserActiveStmt.run(isActive, id);
}

const setUserRoleStmt = db.prepare(`UPDATE app_users SET role = ? WHERE id = ?`);
function setUserRole(id, role) {
    setUserRoleStmt.run(role, id);
}

const setUserPasswordHashStmt = db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`);
function setUserPasswordHash(id, hash) {
    setUserPasswordHashStmt.run(hash, id);
}

const updateUserDiscordLinkStmt = db.prepare(`UPDATE app_users SET discord_id = ?, discord_name = ? WHERE id = ?`);
function updateUserDiscordLink(discordId, discordName, userId) {
    updateUserDiscordLinkStmt.run(discordId, discordName, userId);
}

const banUserStmt = db.prepare(`UPDATE app_users SET is_active = 0 WHERE id = ?`);
function banUser(id) {
    banUserStmt.run(id);
}

// --- discord_link_codes ---

// Consolidates discord_bot.js's handleLink sweep and auth.js's /link-code mint transaction
// — both used byte-identical SQL. See Global Constraints dedup #4. The caller in
// discord_bot.js wraps its own call in try/catch (unchanged) — this function has none,
// same as every other thin wrapper in this codebase.
const deleteExpiredLinkCodesStmt = db.prepare(`DELETE FROM discord_link_codes WHERE expires_at < datetime('now')`);
function deleteExpiredLinkCodes() {
    deleteExpiredLinkCodesStmt.run();
}

const getLinkCodeWithUserStmt = db.prepare(`
    SELECT c.code, c.user_id, c.used_at, c.expires_at, u.game_name, u.discord_id
    FROM discord_link_codes c
    JOIN app_users u ON u.id = c.user_id
    WHERE c.code = ?
`);
function getLinkCodeWithUser(code) {
    return getLinkCodeWithUserStmt.get(code);
}

// Consolidates discord_bot.js's "already linked to you" short-circuit and the real link
// commit inside a transaction — both used byte-identical SQL. See Global Constraints
// dedup #5.
const markLinkCodeUsedStmt = db.prepare(`UPDATE discord_link_codes SET used_at = CURRENT_TIMESTAMP, used_by_discord_id = ? WHERE code = ?`);
function markLinkCodeUsed(discordId, code) {
    markLinkCodeUsedStmt.run(discordId, code);
}

const mintLinkCodeStmt = db.prepare(`INSERT INTO discord_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`);
function mintLinkCode(code, userId, expiresAt) {
    mintLinkCodeStmt.run(code, userId, expiresAt);
}

// NOT the same as deleteLinkCodesByUserId below — this one filters on used_at IS NULL.
// See Global Constraints: these two must stay distinct.
const deleteUnusedLinkCodesForUserStmt = db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ? AND used_at IS NULL`);
function deleteUnusedLinkCodesForUser(userId) {
    deleteUnusedLinkCodesForUserStmt.run(userId);
}

const deleteLinkCodesByUserIdStmt = db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ?`);
function deleteLinkCodesByUserId(userId) {
    deleteLinkCodesByUserIdStmt.run(userId);
}

module.exports = {
    getUserByDiscordId, getUserByDiscordName, getUserAllianceTagByDiscordName,
    getUserMentionByGameName, getActiveRecipientsExcludingAdmin, getValidActiveUserIds,
    getUserByGameName, getUserAllianceIdBridge, getUserById, getAllUsersWithIdle,
    getUserNameById, getUserDiscordInfoById, getUserActiveStatusById, getAdminPasswordHash,
    getActiveMemberNames,
    updateUserGameName, deleteUser, createUser, updateUserDiscordName, clearUserDiscordFields,
    setUserActive, setUserRole, setUserPasswordHash, updateUserDiscordLink, banUser,
    deleteExpiredLinkCodes, getLinkCodeWithUser, markLinkCodeUsed, mintLinkCode,
    deleteUnusedLinkCodesForUser, deleteLinkCodesByUserId,
};
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/users.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const users = require('./users');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('users.test.js');

// The default admin row auto-created on schema init already occupies id 1 — work around it,
// same as the players/plans domains' smoke tests had to.
users.createUser('caveman', 'hash1', 'user', null);
const caveman = users.getUserByGameName('caveman');
ok('createUser created the row', !!caveman);
ok('getUserByGameName returns the full row', caveman.role === 'user');

ok('getUserNameById finds the new user', users.getUserNameById(caveman.id).game_name === 'caveman');

users.updateUserGameName(caveman.id, 'Caveman2');
ok('updateUserGameName renames', users.getUserNameById(caveman.id).game_name === 'Caveman2');

users.updateUserDiscordName(caveman.id, 'caveman#discord');
ok('updateUserDiscordName sets discord_name', users.getUserDiscordInfoById(caveman.id).discord_name === 'caveman#discord');

users.updateUserDiscordLink('12345', 'CavemanDiscord', caveman.id);
ok('updateUserDiscordLink sets both discord_id and discord_name', users.getUserByDiscordId('12345').game_name === 'Caveman2');
ok('getUserById returns id+game_name+discord fields', users.getUserById(caveman.id).discord_id === '12345');

const byName = users.getUserByDiscordName('cavemandiscord', '@cavemandiscord');
ok('getUserByDiscordName matches case-insensitively', byName && byName.id === caveman.id);

users.clearUserDiscordFields(caveman.id);
ok('clearUserDiscordFields nulls both fields', users.getUserById(caveman.id).discord_id === null && users.getUserById(caveman.id).discord_name === null);

ok('getUserActiveStatusById defaults to active', users.getUserActiveStatusById(caveman.id).is_active === 1);
users.setUserActive(caveman.id, 0);
ok('setUserActive deactivates', users.getUserActiveStatusById(caveman.id).is_active === 0);
users.setUserActive(caveman.id, 1);

users.setUserRole(caveman.id, 'admin');
ok('setUserRole changes role', users.getUserByGameName('Caveman2').role === 'admin');
users.setUserRole(caveman.id, 'user');

users.setUserPasswordHash(caveman.id, 'newhash');
ok('setUserPasswordHash changes the hash', users.getUserByGameName('Caveman2').password_hash === 'newhash');

const activeRecipients = users.getActiveRecipientsExcludingAdmin(caveman.id);
ok('getActiveRecipientsExcludingAdmin excludes the bootstrap admin by default', !activeRecipients.some(u => u.game_name === 'admin'));

const validIds = users.getValidActiveUserIds([caveman.id, 99999]);
ok('getValidActiveUserIds filters out nonexistent ids', validIds.length === 1 && validIds[0].id === caveman.id);
ok('getValidActiveUserIds returns [] for an empty id list', users.getValidActiveUserIds([]).length === 0);

ok('getAllUsersWithIdle includes the bootstrap admin and caveman', users.getAllUsersWithIdle().length === 2);

ok('getActiveMemberNames lists active game names', users.getActiveMemberNames().includes('Caveman2'));

ok('getAdminPasswordHash finds the bootstrap admin', !!users.getAdminPasswordHash());

users.banUser(caveman.id);
ok('banUser deactivates the account', users.getUserActiveStatusById(caveman.id).is_active === 0);

users.mintLinkCode('ABCD1234', caveman.id, new Date(Date.now() + 600000).toISOString());
const linkRow = users.getLinkCodeWithUser('ABCD1234');
ok('mintLinkCode/getLinkCodeWithUser round-trip', linkRow && linkRow.game_name === 'Caveman2');

users.markLinkCodeUsed('12345', 'ABCD1234');
ok('markLinkCodeUsed sets used_at', !!db.prepare('SELECT used_at FROM discord_link_codes WHERE code = ?').get('ABCD1234').used_at);

users.mintLinkCode('EXPIRED1', caveman.id, '2020-01-01T00:00:00.000Z');
users.deleteExpiredLinkCodes();
ok('deleteExpiredLinkCodes removes only the expired row', !users.getLinkCodeWithUser('EXPIRED1') && !!users.getLinkCodeWithUser('ABCD1234'));

users.mintLinkCode('UNUSED99', caveman.id, new Date(Date.now() + 600000).toISOString());
users.deleteUnusedLinkCodesForUser(caveman.id);
ok('deleteUnusedLinkCodesForUser removes the unused row but not the already-used one', !users.getLinkCodeWithUser('UNUSED99') && !!users.getLinkCodeWithUser('ABCD1234'));

users.deleteLinkCodesByUserId(caveman.id);
ok('deleteLinkCodesByUserId removes remaining codes regardless of used_at', !users.getLinkCodeWithUser('ABCD1234'));

users.deleteUser(caveman.id);
ok('deleteUser removes the row', users.getUserByGameName('Caveman2') === undefined);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `users.js`, run `node src/repositories/users.test.js`, confirm it errors
with `Cannot find module './users'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/users.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/users.js src/repositories/users.test.js
git commit -m "Add users repository module (app_users, discord_link_codes)"
```

---

### Task 2: Migrate `src/discord_bot.js`

10 call sites, one small same-domain transaction. Read carefully — this file has several
near-identical lookups that must map to the correct dedup or stay distinct per Global Constraints.

**Files:**
- Modify: `src/discord_bot.js`

**Interfaces:**
- Consumes: `users` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`plansRepo`/`playersRepo`/`alliancesRepo`
imports, add:
```js
const usersRepo = require('./repositories/users');
```

- [ ] **Step 2: Cover-button handler**

Before:
```js
            const row = db.prepare(`SELECT game_name FROM app_users WHERE discord_id = ?`).get(interaction.user.id);
```
After: `const row = usersRepo.getUserByDiscordId(interaction.user.id);`

- [ ] **Step 3: `handleLink`'s "already linked?" check**

Before:
```js
    const already = db.prepare(`SELECT game_name FROM app_users WHERE discord_id = ?`).get(userId);
```
After: `const already = usersRepo.getUserByDiscordId(userId);`

- [ ] **Step 4: `handleLink`'s expired-code sweep**

Before (this line stays wrapped in the same try/catch — only the statement inside changes):
```js
    try { db.prepare(`DELETE FROM discord_link_codes WHERE expires_at < datetime('now')`).run(); } catch (_) {}
```
After:
```js
    try { usersRepo.deleteExpiredLinkCodes(); } catch (_) {}
```

- [ ] **Step 5: `handleLink`'s code lookup**

Before:
```js
    const row = db.prepare(`
        SELECT c.code, c.user_id, c.used_at, c.expires_at, u.game_name, u.discord_id
        FROM discord_link_codes c
        JOIN app_users u ON u.id = c.user_id
        WHERE c.code = ?
    `).get(normalised);
```
After: `const row = usersRepo.getLinkCodeWithUser(normalised);`

- [ ] **Step 6: `handleLink`'s "already linked to you" short-circuit**

Before:
```js
    if (row.discord_id === userId) {
        db.prepare(`UPDATE discord_link_codes SET used_at = CURRENT_TIMESTAMP, used_by_discord_id = ? WHERE code = ?`).run(userId, normalised);
        return reply(`ℹ️ **${row.game_name}** is already linked to you. Nothing to do.`);
    }
```
After:
```js
    if (row.discord_id === userId) {
        usersRepo.markLinkCodeUsed(userId, normalised);
        return reply(`ℹ️ **${row.game_name}** is already linked to you. Nothing to do.`);
    }
```

- [ ] **Step 7: `handleLink`'s real link commit, inside its transaction**

Before:
```js
        const link = db.transaction(() => {
            db.prepare(`UPDATE app_users SET discord_id = ?, discord_name = ? WHERE id = ?`).run(userId, username, row.user_id);
            db.prepare(`UPDATE discord_link_codes SET used_at = CURRENT_TIMESTAMP, used_by_discord_id = ? WHERE code = ?`).run(userId, normalised);
        });
        link();
```
After:
```js
        const link = db.transaction(() => {
            usersRepo.updateUserDiscordLink(userId, username, row.user_id);
            usersRepo.markLinkCodeUsed(userId, normalised);
        });
        link();
```

- [ ] **Step 8: `!bio` command's user lookup**

Before:
```js
        const user = db.prepare(`SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`)
                       .get(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);
```
After:
```js
        const user = usersRepo.getUserByDiscordName(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);
```

- [ ] **Step 9: `!plan` command's user lookup**

Before (identical pattern to Step 8, different command):
```js
        const user = db.prepare(`SELECT id, game_name FROM app_users WHERE LOWER(discord_name) = ? OR LOWER(discord_name) = ?`)
                       .get(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);
```
After:
```js
        const user = usersRepo.getUserByDiscordName(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);
```

- [ ] **Step 10: `!holes` command's own-alliance lookup**

Before:
```js
            const userAlliance = db.prepare(`
                SELECT a.tag 
                FROM app_users u
                JOIN players p ON u.game_name = p.name
                JOIN alliances a ON p.alliance_id = a.id
                WHERE LOWER(u.discord_name) = ? OR LOWER(u.discord_name) = ?
            `).get(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);
```
After:
```js
            const userAlliance = usersRepo.getUserAllianceTagByDiscordName(discordName.toLowerCase(), `@${discordName.toLowerCase()}`);
```

- [ ] **Step 11: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/discord_bot.js`, and for every remaining
match, read its full SQL text and confirm its primary table is NOT `app_users`/`discord_link_codes`.

- [ ] **Step 12: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`, confirm the Discord bot reconnects. In the Discord test
server: click a "cover" button on an incoming alert if one is active, run `!bio` and `!plan` as a
linked user, run `!holes` with no tag argument (exercises the own-alliance lookup), and run
`!link <code>` end-to-end (mint a code via the Hub's "Link Discord" panel first, or via curl
against `/hub-api/link-code` with a valid session).

- [ ] **Step 13: Commit**

```bash
cd /root/awt-test
git add src/discord_bot.js
git commit -m "Migrate discord_bot.js app_users/discord_link_codes queries to the repository layer"
```

---

### Task 3: Migrate `src/routes/auth.js`

Security-sensitive: login, session bootstrapping, the Discord link-code mint transaction, and the
anti-credential-sharing ban. 5 call sites, one small same-domain transaction.

**Files:**
- Modify: `src/routes/auth.js`

**Interfaces:**
- Consumes: `users` from Task 1

- [ ] **Step 1: Add the import**

```js
const usersRepo = require('../repositories/users');
```

- [ ] **Step 2: `POST /login`**

Before:
```js
    const user = db.prepare(`SELECT * FROM app_users WHERE game_name = ?`).get(game_name);
```
After: `const user = usersRepo.getUserByGameName(game_name);`

- [ ] **Step 3: `GET /me`'s alliance-bridge lookup**

Before:
```js
        const row = db.prepare(`
            SELECT p.alliance_id AS alliance_id
            FROM app_users u
            JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
            WHERE u.id = ?
        `).get(req.session.userId);
```
After: `const row = usersRepo.getUserAllianceIdBridge(req.session.userId);`

- [ ] **Step 4: `POST /link-code`'s account load**

Before:
```js
        const me = db.prepare(`SELECT id, game_name, discord_id, discord_name FROM app_users WHERE id = ?`).get(req.session.userId);
```
After: `const me = usersRepo.getUserById(req.session.userId);`

- [ ] **Step 5: `POST /link-code`'s mint transaction**

Before:
```js
        db.transaction(() => {
            db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ? AND used_at IS NULL`).run(me.id);
            db.prepare(`DELETE FROM discord_link_codes WHERE expires_at < datetime('now')`).run();
            db.prepare(`INSERT INTO discord_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`).run(code, me.id, expiresAt);
        })();
```
After:
```js
        db.transaction(() => {
            usersRepo.deleteUnusedLinkCodesForUser(me.id);
            usersRepo.deleteExpiredLinkCodes();
            usersRepo.mintLinkCode(code, me.id, expiresAt);
        })();
```

- [ ] **Step 6: `POST /nuke`'s ban**

Before:
```js
    db.prepare(`UPDATE app_users SET is_active = 0 WHERE id = ?`).run(userId);
```
After: `usersRepo.banUser(userId);`

- [ ] **Step 7: Verify no domain call sites were missed, and the file no longer needs `db`**

Run: `cd /root/awt-test && grep -n "db\.prepare\|db\.transaction\|require('../database')" src/routes/auth.js`.
Confirm zero remaining `db.prepare`/`db.transaction` calls in this file (auth.js's only SQL was
these 5 call sites, all migrated) — if that's true, remove the now-unused
`const db = require('../database');` line entirely rather than leaving a dead import. If any
`db.prepare` call remains that you didn't expect, stop and read it before removing the import.

- [ ] **Step 8: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`. Log in as `caveman` at
`https://test.37.27.17.97.nip.io` (confirms `/login`), confirm `/me` loads correctly (alliance id
bridge), and generate a Discord link code from the sidebar's "Link Discord" panel (confirms
`/link-code`'s transaction). Do NOT test `/nuke` live — it's a destructive security trap that bans
the account; reading the migrated code and confirming the SQL/logic is unchanged is sufficient
verification for that one endpoint.

- [ ] **Step 9: Commit**

```bash
cd /root/awt-test
git add src/routes/auth.js
git commit -m "Migrate auth.js app_users/discord_link_codes queries to the repository layer"
```

---

### Task 4: Migrate `src/routes/admin.js`

The largest consumer in this domain — 17 call sites (the full user-management CRUD panel), plus
one small same-domain transaction. Four call sites collapse into the same dedup
(`getUserNameById`) — verify all four are replaced, not just some.

**Files:**
- Modify: `src/routes/admin.js`

**Interfaces:**
- Consumes: `users` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing repository imports:
```js
const usersRepo = require('../repositories/users');
```

- [ ] **Step 2: `GET /admin/users`**

Before:
```js
        const users = db.prepare(`
            SELECT u.id, u.game_name, u.role, u.is_active, u.discord_name, p.idle_time
            FROM app_users u
            LEFT JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
            ORDER BY u.id ASC
        `).all();
```
After: `const users = usersRepo.getAllUsersWithIdle();`

(Note: the route handler's local variable is also named `users` — this is fine, it now shadows
the module import `usersRepo` under a different name, no collision.)

- [ ] **Step 3: `POST /admin/users/:id/name` (edit name)**

Before:
```js
        const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot rename the master admin' });
        if (new_name.toLowerCase() === 'admin') return res.status(400).json({ error: 'Cannot use reserved name' });

        db.prepare(`UPDATE app_users SET game_name = ? WHERE id = ?`).run(new_name.trim(), req.params.id);
```
After:
```js
        const user = usersRepo.getUserNameById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot rename the master admin' });
        if (new_name.toLowerCase() === 'admin') return res.status(400).json({ error: 'Cannot use reserved name' });

        usersRepo.updateUserGameName(req.params.id, new_name.trim());
```

- [ ] **Step 4: `DELETE /admin/users/:id`**

Before:
```js
        const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot delete the master admin' });

        db.prepare(`DELETE FROM app_users WHERE id = ?`).run(req.params.id);
```
After:
```js
        const user = usersRepo.getUserNameById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot delete the master admin' });

        usersRepo.deleteUser(req.params.id);
```

- [ ] **Step 5: `POST /admin/users` (create)**

Before:
```js
        const hash = bcrypt.hashSync(password, 10);
        db.prepare(`INSERT INTO app_users (game_name, password_hash, role, discord_name) VALUES (?, ?, ?, ?)`).run(game_name, hash, role || 'user', discord_name || null);
```
After:
```js
        const hash = bcrypt.hashSync(password, 10);
        usersRepo.createUser(game_name, hash, role || 'user', discord_name || null);
```

- [ ] **Step 6: `POST /admin/users/:id/discord`**

Before:
```js
        db.prepare(`UPDATE app_users SET discord_name = ? WHERE id = ?`).run(discord_name, req.params.id);
```
After: `usersRepo.updateUserDiscordName(req.params.id, discord_name);`

- [ ] **Step 7: `DELETE /admin/users/:id/discord`**

Before:
```js
        const user = db.prepare(`SELECT game_name, discord_id, discord_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.discord_id && !user.discord_name) {
            return res.json({ success: true, changed: false, message: 'That account has no Discord link.' });
        }
        db.transaction(() => {
            db.prepare(`UPDATE app_users SET discord_id = NULL, discord_name = NULL WHERE id = ?`).run(req.params.id);
            // Any pending link codes for this account are void once an admin intervenes.
            db.prepare(`DELETE FROM discord_link_codes WHERE user_id = ?`).run(req.params.id);
        })();
```
After:
```js
        const user = usersRepo.getUserDiscordInfoById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!user.discord_id && !user.discord_name) {
            return res.json({ success: true, changed: false, message: 'That account has no Discord link.' });
        }
        db.transaction(() => {
            usersRepo.clearUserDiscordFields(req.params.id);
            // Any pending link codes for this account are void once an admin intervenes.
            usersRepo.deleteLinkCodesByUserId(req.params.id);
        })();
```

- [ ] **Step 8: `POST /admin/users/:id/toggle`**

Before:
```js
        const user = db.prepare(`SELECT game_name, is_active FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot ban the master admin' });

        const newStatus = user.is_active === 1 ? 0 : 1;
        db.prepare(`UPDATE app_users SET is_active = ? WHERE id = ?`).run(newStatus, req.params.id);
```
After:
```js
        const user = usersRepo.getUserActiveStatusById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot ban the master admin' });

        const newStatus = user.is_active === 1 ? 0 : 1;
        usersRepo.setUserActive(req.params.id, newStatus);
```

- [ ] **Step 9: `POST /admin/users/:id/role`**

Before:
```js
        const user = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot change the master admin role' });

        db.prepare(`UPDATE app_users SET role = ? WHERE id = ?`).run(role, req.params.id);
```
After:
```js
        const user = usersRepo.getUserNameById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.game_name === 'admin') return res.status(403).json({ error: 'Cannot change the master admin role' });

        usersRepo.setUserRole(req.params.id, role);
```

- [ ] **Step 10: `POST /admin/users/:id/password`**

Before:
```js
        const targetUser = db.prepare(`SELECT game_name FROM app_users WHERE id = ?`).get(req.params.id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        // SECURITY: Only the session holding the 'admin' game_name can change the master admin password
        if (targetUser.game_name === 'admin' && req.session.gameName !== 'admin') {
            return res.status(403).json({ error: 'Only the Master Admin can change this password.' });
        }

        const hash = bcrypt.hashSync(new_password, 10);
        db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hash, req.params.id);
```
After:
```js
        const targetUser = usersRepo.getUserNameById(req.params.id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        // SECURITY: Only the session holding the 'admin' game_name can change the master admin password
        if (targetUser.game_name === 'admin' && req.session.gameName !== 'admin') {
            return res.status(403).json({ error: 'Only the Master Admin can change this password.' });
        }

        const hash = bcrypt.hashSync(new_password, 10);
        usersRepo.setUserPasswordHash(req.params.id, hash);
```

- [ ] **Step 11: `POST /admin/nuke-intel`'s master-password check**

Before:
```js
    const adminUser = db.prepare(`SELECT password_hash FROM app_users WHERE game_name = 'admin'`).get();
```
After: `const adminUser = usersRepo.getAdminPasswordHash();`

(Leave the rest of `nuke-intel`'s transaction — `archiveRound`, and every already-migrated
`fleetsRepo`/`plansRepo`/`systemsRepo`/`playersRepo`/`alliancesRepo` call plus the raw
`battle_reports` delete — completely untouched. This step only replaces the master-password
lookup that happens BEFORE the transaction starts.)

- [ ] **Step 12: Verify all four `getUserNameById` dedup sites were replaced, and no other domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/routes/admin.js`, and for every remaining
match, read its full SQL text and confirm its primary table is NOT `app_users`/
`discord_link_codes` (should be `app_settings`, `alliance_broadcasts`... wait, `alliances`/
`alliance_broadcasts` are already migrated too — should be `battle_reports`, `rounds`-related, or
other not-yet-migrated tables only). Specifically confirm `usersRepo.getUserNameById` appears at
all four of: the edit-name handler, the delete-user handler, the change-role handler, and the
change-password handler — not just some of them.

- [ ] **Step 13: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
As admin at `https://test.37.27.17.97.nip.io`: open the user-management panel and exercise each
control — view the list, edit a test user's name, toggle active/ban, change role, change
password, update/clear their Discord link, delete a test user, and create a new one. Do NOT test
`nuke-intel` live unless you're prepared to re-seed — reading the migrated master-password check
and confirming it's unchanged is sufficient for that one path.

- [ ] **Step 14: Commit**

```bash
cd /root/awt-test
git add src/routes/admin.js
git commit -m "Migrate admin.js app_users/discord_link_codes queries to the repository layer"
```

---

### Task 5: Migrate the remaining files (interceptors.js, notes.js, intel.js)

**Files:**
- Modify: `src/utils/interceptors.js`, `src/routes/notes.js`, `src/routes/intel.js`

**Interfaces:**
- Consumes: `users` from Task 1

- [ ] **Step 1: `src/utils/interceptors.js` — add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`playersRepo` imports:
```js
const usersRepo = require('../repositories/users');
```

- [ ] **Step 2: `src/utils/interceptors.js` — the Discord-mention lookup**

Before:
```js
    const mentionFor = db.prepare(`
        SELECT discord_id FROM app_users WHERE LOWER(game_name) = ? AND discord_id IS NOT NULL
    `);
    for (const a of byPlayer.values()) {
        try {
            const row = mentionFor.get(a.name.toLowerCase());
```
After:
```js
    for (const a of byPlayer.values()) {
        try {
            const row = usersRepo.getUserMentionByGameName(a.name.toLowerCase());
```

- [ ] **Step 3: `src/routes/notes.js` — add the import**

```js
const usersRepo = require('../repositories/users');
```

- [ ] **Step 4: `src/routes/notes.js` — `GET /notes/recipients`**

Before:
```js
        const rows = db.prepare(`
            SELECT id, game_name FROM app_users
            WHERE is_active = 1 AND (game_name != 'admin' OR id = ?)
            ORDER BY game_name COLLATE NOCASE
        `).all(req.session.userId);
```
After: `const rows = usersRepo.getActiveRecipientsExcludingAdmin(req.session.userId);`

- [ ] **Step 5: `src/routes/notes.js` — recipient-id validation on note creation**

Before:
```js
        if (recipientIds.length) {
            const placeholders = recipientIds.map(() => '?').join(',');
            const validIds = db.prepare(`SELECT id FROM app_users WHERE is_active = 1 AND id IN (${placeholders})`)
                .all(...recipientIds).map((r) => r.id);
            recipientIds = validIds;
        }
```
After:
```js
        if (recipientIds.length) {
            recipientIds = usersRepo.getValidActiveUserIds(recipientIds).map((r) => r.id);
        }
```

- [ ] **Step 6: `src/routes/intel.js` — add the import**

Alongside the file's existing repository imports:
```js
const usersRepo = require('../repositories/users');
```

- [ ] **Step 7: `src/routes/intel.js` — `GET /intel/members`**

Before:
```js
        const members = db.prepare(`SELECT game_name FROM app_users WHERE is_active = 1`).all();
```
After: `const members = usersRepo.getActiveMemberNames();`

- [ ] **Step 8: Verify no domain call sites were missed in any of the three files**

Run:
```bash
cd /root/awt-test && grep -n "db\.prepare" src/utils/interceptors.js src/routes/notes.js src/routes/intel.js
```
For every match across all three files, read its full SQL text and confirm its primary table is
NOT `app_users`/`discord_link_codes`.

- [ ] **Step 9: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
Check an active incoming-attack alert's interceptor list for real Discord mentions (if one is
active), the note-creation recipient picker (My Notes panel), and the intel members list
wherever it's consumed (autocomplete/filter dropdowns).

- [ ] **Step 10: Commit**

```bash
cd /root/awt-test
git add src/utils/interceptors.js src/routes/notes.js src/routes/intel.js
git commit -m "Migrate remaining app_users/discord_link_codes call sites to the repository layer"
```

---

### Task 6: Full regression pass and close out the domain

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /root/awt-test && npm test`
Expected: all suites pass (including the new `repositories/users.test.js`), exit code 0. If
anything fails, check first whether it's a source-text assertion broken by this domain's
refactor (the pattern that hit three of the four prior domains) before assuming a real behavior
regression — fix the assertion to check the new location if so, following the same approach those
fixes used.

- [ ] **Step 2: Confirm zero remaining raw call sites for this domain, codebase-wide — properly this time**

Do NOT rely on a single-line grep. Instead:
```bash
cd /root/awt-test && grep -rln "app_users\|discord_link_codes" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js"
```
For every file this lists, read each `db.prepare(...)`/`db.transaction(...)` block's actual SQL
text (not just the grep-matched line) and confirm none of them have `app_users`/
`discord_link_codes` as their primary `FROM`/`INTO`/`UPDATE`/`DELETE FROM` target. A hit that's
only a JOIN against this domain from an already-migrated or not-yet-migrated table's primary query
is fine to leave (e.g. `user_notes` LEFT JOINing `app_users`, `routes` LEFT JOINing `app_users`);
a hit where `app_users`/`discord_link_codes` IS the primary table is a missed call site — add a
step here migrating it before continuing.

- [ ] **Step 3: Final end-to-end pass on `awt-test`**

Run: `pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 30 --nostream`
Expected: clean boot, no errors, Discord bot reconnects. Spend a few minutes clicking through
login/logout, the user-management panel, the Discord-link flow (both the Hub side and the Discord
`!link` side), and the note-recipient picker one more time, now that every call site for this
domain has moved.
