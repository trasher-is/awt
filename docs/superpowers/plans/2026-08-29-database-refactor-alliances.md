# Database Refactor — alliances domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every raw `db.prepare()` call site touching the `alliances`, `alliance_member_stats`,
and `alliance_broadcasts` tables into a new `src/repositories/alliances.js` module, mirroring the
pattern established by `systems.js`/`fleets.js`/`plans.js`/`players.js` from the two prior domain plans.

**Architecture:** New `src/repositories/alliances.js`. Same conventions as before: module-level
`const` prepared statements, named exported functions, no error-handling changes, behavior-preserving
1:1 moves with zero sanctioned dedups this time (every function here maps to exactly one original call
site — two call sites look similar but have a real textual difference, documented below, and stay
separate). Where a route touches tables outside this domain in the same handler, only the
alliances/alliance_member_stats/alliance_broadcasts calls migrate — the rest stay raw `db.prepare()`
until their own domain's plan runs (`app_users`, `trade_agreements`, `rounds`/`round_players`/
`round_systems`, `battle_reports`, `starbase_order_audit`, `discord_timers`, `discord_link_codes`,
`user_notes`, `rz_plans`, `routes`/`route_legs`, `incoming_alerts`, `incoming_msgs`, `app_settings`).

**Context since the last domain plan:** between the players domain and this one, a separately-developed
"API integration" branch was merged into `main` (battle-report sync via the game's REST API, travel-calc
v2, map isochrones, live intel). It added two new tables (`battle_reports`, `starbase_order_audit`) and
substantially expanded `src/routes/sync.js`, including two genuine behavior fixes that had to be
integrated into the systems/players repositories during the merge: `is_sieged` fog-of-war handling
(now in `systemsRepo.upsertPlanet`/`getOldPlanet`) and a narrower player restart-reset that no longer
wipes intel-derived stats (now in `playersRepo.resetPlayerOnRestart`). Neither change affects this
domain's tables — noted here only so the history of `sync.js` makes sense when reading it.

**Tech Stack:** Node.js, better-sqlite3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Global Constraints

- No SQL text, parameter order, or return-shape changes for any migrated query. No sanctioned
  dedups in this domain — every exported function maps 1:1 to exactly one original call site.
- **Two call sites look like duplicates but are NOT** — verify carefully before assuming either can
  be merged with the other:
  1. `src/routes/sync.js`'s `/sync/system` handler's `upsertAlliance` (`ON CONFLICT(id) DO UPDATE SET
     tag=excluded.tag, updated_at=CURRENT_TIMESTAMP`) touches `updated_at` on conflict.
  2. `src/routes/sync.js`'s `/sync/player` handler's inline alliance upsert (`ON CONFLICT(id) DO
     UPDATE SET tag=excluded.tag`) does **not** touch `updated_at` on conflict.
  These become two separate functions, `upsertAllianceBasic` and `upsertAllianceTagOnly`.
- Prepared statements compiled once at module load, except one function with a variable-arity id
  array (`deleteStaleAllianceMembers`, matching the `getSystemsByIds` pattern from the first domain).
- No error-handling changes — try/catch and HTTP status codes stay in calling routes.
- `src/routes/sync.js` has FOUR separate transaction scopes that each mix this domain's calls with
  already-migrated domains (players, fleets, systems) or not-yet-migrated ones — only the
  alliances/alliance_member_stats statements move in each; nothing else in any of the four
  transactions changes position or content. See Task 3 for the exact composition each must retain.
- **Verification lesson from the first two domains**: a single-line grep (`db.prepare` and `FROM
  alliances` on the *same* line) misses multi-line queries — this caused real gaps in the first
  domain, caught only by that domain's final review. Every "verify no call sites were missed" step
  in this plan requires reading each remaining `db.prepare()`/`db.transaction()` block's actual SQL
  text, not just running the naive grep. Also **re-run the full test suite** (`npm test`) after each
  file's migration and watch for any test asserting against literal source text containing
  `alliances`/`alliance_member_stats`/`alliance_broadcasts` SQL — this exact failure mode hit both
  prior domains (`round-archive.test.js`, `vision-model.test.js`, `player-sync.test.js` all needed
  fixing after their respective migrations) and is likely to recur here, especially in
  `src/utils/round-archive.test.js` and `src/utils/battle-reports.test.js`, which are known to read
  `src/routes/admin.js`'s and `src/routes/sync.js`'s raw source text.
- After each task's migration step, restart `awt-test` (`pm2 restart awt-test`) and manually
  exercise the affected feature before moving to the next task.

## File Structure

- Create: `src/repositories/alliances.js`
- Create: `src/repositories/alliances.test.js`
- Modify: `src/routes/intel.js`, `src/routes/sync.js`, `src/routes/admin.js`, `src/routes/trade.js`,
  `src/discord_bot.js`

---

### Task 1: `src/repositories/alliances.js`

**Files:**
- Create: `src/repositories/alliances.js`
- Test: `src/repositories/alliances.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Tasks 2–4):
  - `getWarRoomAllianceIntelTags(): Array<{id, tag}>`
  - `countAlliances(): number`
  - `getAllianceMemberStatIds(): Array<{player_id}>`
  - `getTradeAnalysisRows(): Array<object>`
  - `getAllianceStatsForArchive(): Array<object>`
  - `getWarRoomAlliances(): Array<object>`
  - `upsertAllianceBasic(id, tag, name): void`
  - `upsertAllianceTagOnly(id, tag, name): void`
  - `upsertAllianceFull(alliance: object): void`
  - `deleteAllAlliances(): void`
  - `insertBroadcast(title, message, authorName, displayTime): void`
  - `getBroadcasts(): Array<object>`
  - `updateBroadcast(title, message, authorName, displayTime, id): void`
  - `deleteBroadcast(id): void`
  - `getTraders(): Array<{name}>`
  - `getMembersWithStats(): Array<object>`
  - `getCanonicalNameFromStats(name): {name} | undefined`
  - `upsertHoardedAu(playerId, value): void`
  - `upsertAllianceMemberStats(playerId, planetsText, nextCultureAt, scienceRate, cultureRate, productionRate, astroDollars, productionPoints, artefact, levelText, cvLimitText, economy, energy, mathematics, physics, population): void`
  - `deleteStaleAllianceMembers(ids: number[]): {changes: number}`

- [ ] **Step 1: Write the module**

Create `src/repositories/alliances.js`:

```js
const db = require('../database');

// --- alliances: read ---

const getWarRoomAllianceIntelTagsStmt = db.prepare(`
    SELECT DISTINCT a.id, a.tag
    FROM alliances a
    JOIN players p ON p.alliance_id = a.id
    WHERE p.has_intel = 1
    ORDER BY a.tag ASC
`);
function getWarRoomAllianceIntelTags() {
    return getWarRoomAllianceIntelTagsStmt.all();
}

const countAlliancesStmt = db.prepare(`SELECT COUNT(*) as count FROM alliances`);
function countAlliances() {
    return countAlliancesStmt.get().count;
}

const getWarRoomAlliancesStmt = db.prepare(`
    SELECT a.id, a.tag, a.name, COUNT(p.id) as active_members_count, MAX(p.updated_at) as last_scan_time
    FROM alliances a
    JOIN players p ON p.alliance_id = a.id
    GROUP BY a.id, a.tag, a.name
    HAVING COUNT(p.id) >= 1
    ORDER BY COUNT(p.id) DESC, a.tag ASC
`);
function getWarRoomAlliances() {
    return getWarRoomAlliancesStmt.all();
}

// --- alliances: write ---

// System-scan upsert: touches updated_at on conflict. NOT the same statement as
// upsertAllianceTagOnly below — see Global Constraints.
const upsertAllianceBasicStmt = db.prepare(`
    INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceBasic(id, tag, name) {
    upsertAllianceBasicStmt.run(id, tag, name);
}

// Player-profile-scan upsert: does NOT touch updated_at on conflict. NOT the same
// statement as upsertAllianceBasic above — see Global Constraints.
const upsertAllianceTagOnlyStmt = db.prepare(`
    INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag
`);
function upsertAllianceTagOnly(id, tag, name) {
    upsertAllianceTagOnlyStmt.run(id, tag, name);
}

const upsertAllianceFullStmt = db.prepare(`
    INSERT INTO alliances (id, name, tag, leader_id, ranking, points_current)
    VALUES (@id, @name, @tag, @leader_id, @ranking, @points)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        tag=excluded.tag,
        leader_id=excluded.leader_id,
        ranking=excluded.ranking,
        points_current=excluded.points_current,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceFull(alliance) {
    upsertAllianceFullStmt.run(alliance);
}

const deleteAllAlliancesStmt = db.prepare(`DELETE FROM alliances`);
function deleteAllAlliances() {
    deleteAllAlliancesStmt.run();
}

// --- alliance_broadcasts ---

const insertBroadcastStmt = db.prepare(`
    INSERT INTO alliance_broadcasts (title, message, author_name, display_time)
    VALUES (?, ?, ?, ?)
`);
function insertBroadcast(title, message, authorName, displayTime) {
    insertBroadcastStmt.run(title, message, authorName, displayTime);
}

const getBroadcastsStmt = db.prepare(`
    SELECT id, title, message, author_name, display_time
    FROM alliance_broadcasts
    ORDER BY id DESC
`);
function getBroadcasts() {
    return getBroadcastsStmt.all();
}

const updateBroadcastStmt = db.prepare(`
    UPDATE alliance_broadcasts
    SET title = ?, message = ?, author_name = ?, display_time = ?
    WHERE id = ?
`);
function updateBroadcast(title, message, authorName, displayTime, id) {
    updateBroadcastStmt.run(title, message, authorName, displayTime, id);
}

const deleteBroadcastStmt = db.prepare(`DELETE FROM alliance_broadcasts WHERE id = ?`);
function deleteBroadcast(id) {
    deleteBroadcastStmt.run(id);
}

// --- alliance_member_stats: read ---

const getAllianceMemberStatIdsStmt = db.prepare(`SELECT player_id FROM alliance_member_stats`);
function getAllianceMemberStatIds() {
    return getAllianceMemberStatIdsStmt.all();
}

const getTradeAnalysisRowsStmt = db.prepare(`
    SELECT p.name,
           ams.production_rate,
           ams.astro_dollars,
           ams.production_points,
           p.trade_partners
    FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
`);
function getTradeAnalysisRows() {
    return getTradeAnalysisRowsStmt.all();
}

const getAllianceStatsForArchiveStmt = db.prepare(`
    SELECT s.*, p.name as player_name
    FROM alliance_member_stats s
    LEFT JOIN players p ON s.player_id = p.id
    ORDER BY s.player_id ASC
`);
function getAllianceStatsForArchive() {
    return getAllianceStatsForArchiveStmt.all();
}

const getTradersStmt = db.prepare(`
    SELECT p.name
    FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
    WHERE p.has_intel = 1 AND p.race_trader > 0
`);
function getTraders() {
    return getTradersStmt.all();
}

const getMembersWithStatsStmt = db.prepare(`
    SELECT p.name, p.has_intel, p.race_trader,
           ams.hoarded_au, ams.astro_dollars, ams.production_points, ams.production_rate
    FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
    ORDER BY p.name COLLATE NOCASE ASC
`);
function getMembersWithStats() {
    return getMembersWithStatsStmt.all();
}

const getCanonicalNameFromStatsStmt = db.prepare(`
    SELECT p.name FROM alliance_member_stats ams
    JOIN players p ON p.id = ams.player_id
    WHERE p.name = ? COLLATE NOCASE LIMIT 1
`);
function getCanonicalNameFromStats(name) {
    return getCanonicalNameFromStatsStmt.get(name);
}

// --- alliance_member_stats: write ---

const upsertHoardedAuStmt = db.prepare(`
    INSERT INTO alliance_member_stats (player_id, hoarded_au, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET hoarded_au = excluded.hoarded_au, updated_at = CURRENT_TIMESTAMP
`);
function upsertHoardedAu(playerId, value) {
    upsertHoardedAuStmt.run(playerId, value);
}

const upsertAllianceMemberStatsStmt = db.prepare(`
    INSERT INTO alliance_member_stats (
        player_id, planets_text, next_culture_at, science_rate, culture_rate, production_rate,
        astro_dollars, production_points, artefact, level_text, cv_limit_text,
        economy, energy, mathematics, physics, population, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id) DO UPDATE SET
        planets_text=excluded.planets_text,
        next_culture_at=excluded.next_culture_at,
        science_rate=excluded.science_rate,
        culture_rate=excluded.culture_rate,
        production_rate=excluded.production_rate,
        astro_dollars=excluded.astro_dollars,
        production_points=excluded.production_points,
        artefact=excluded.artefact,
        level_text=excluded.level_text,
        cv_limit_text=excluded.cv_limit_text,
        economy=excluded.economy,
        energy=excluded.energy,
        mathematics=excluded.mathematics,
        physics=excluded.physics,
        population=excluded.population,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceMemberStats(playerId, planetsText, nextCultureAt, scienceRate, cultureRate, productionRate, astroDollars, productionPoints, artefact, levelText, cvLimitText, economy, energy, mathematics, physics, population) {
    upsertAllianceMemberStatsStmt.run(
        playerId, planetsText, nextCultureAt, scienceRate, cultureRate, productionRate,
        astroDollars, productionPoints, artefact, levelText, cvLimitText,
        economy, energy, mathematics, physics, population
    );
}

// Arity varies per call (ids length), so prepared fresh each call — same reasoning as
// systems.js's getSystemsByIds.
function deleteStaleAllianceMembers(ids) {
    if (!ids.length) return { changes: 0 };
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`DELETE FROM alliance_member_stats WHERE player_id NOT IN (${placeholders})`).run(...ids);
}

module.exports = {
    getWarRoomAllianceIntelTags, countAlliances, getWarRoomAlliances,
    upsertAllianceBasic, upsertAllianceTagOnly, upsertAllianceFull, deleteAllAlliances,
    insertBroadcast, getBroadcasts, updateBroadcast, deleteBroadcast,
    getAllianceMemberStatIds, getTradeAnalysisRows, getAllianceStatsForArchive,
    getTraders, getMembersWithStats, getCanonicalNameFromStats,
    upsertHoardedAu, upsertAllianceMemberStats, deleteStaleAllianceMembers,
};
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/alliances.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const alliances = require('./alliances');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('alliances.test.js');

ok('countAlliances starts at 0', alliances.countAlliances() === 0);

alliances.upsertAllianceBasic(1, 'RAID', 'Raiders');
ok('countAlliances is 1 after upsert', alliances.countAlliances() === 1);
ok('upsertAllianceBasic set the tag', db.prepare('SELECT tag FROM alliances WHERE id = ?').get(1).tag === 'RAID');

// upsertAllianceBasic touches updated_at on conflict; upsertAllianceTagOnly does not.
const afterBasic = db.prepare('SELECT updated_at FROM alliances WHERE id = ?').get(1).updated_at;
alliances.upsertAllianceTagOnly(1, 'RAID2', 'Raiders');
const afterTagOnly = db.prepare('SELECT tag, updated_at FROM alliances WHERE id = ?').get(1);
ok('upsertAllianceTagOnly updates the tag', afterTagOnly.tag === 'RAID2');
ok('upsertAllianceTagOnly does not touch updated_at, unlike upsertAllianceBasic', afterTagOnly.updated_at === afterBasic);

alliances.upsertAllianceFull({ id: 2, name: 'Allied Ops', tag: 'AO', leader_id: null, ranking: 5, points: 1000 });
ok('upsertAllianceFull created the alliance', alliances.countAlliances() === 2);
ok('upsertAllianceFull set points_current', db.prepare('SELECT points_current FROM alliances WHERE id = ?').get(2).points_current === 1000);

db.prepare(`INSERT INTO players (id, name, alliance_id, has_intel, race_trader) VALUES (1, 'caveman', 1, 1, 0)`).run();
db.prepare(`INSERT INTO players (id, name, alliance_id, has_intel, race_trader) VALUES (2, 'trader1', 2, 1, 3)`).run();

const intelTags = alliances.getWarRoomAllianceIntelTags();
ok('getWarRoomAllianceIntelTags finds both intel alliances', intelTags.length === 2);

const warRoom = alliances.getWarRoomAlliances();
ok('getWarRoomAlliances counts active members per alliance', warRoom.find(a => a.id === 1).active_members_count === 1);

alliances.upsertHoardedAu(2, 5000);
const traders = alliances.getTraders();
ok('getTraders finds the race_trader player', traders.length === 1 && traders[0].name === 'trader1');

const members = alliances.getMembersWithStats();
ok('getMembersWithStats joins hoarded_au from alliance_member_stats', members.find(m => m.name === 'trader1').hoarded_au === 5000);

const canonical = alliances.getCanonicalNameFromStats('TRADER1');
ok('getCanonicalNameFromStats is case-insensitive', canonical && canonical.name === 'trader1');

alliances.upsertAllianceMemberStats(1, '[]', null, '10', '5', '20', '1000', '500', 'None', 'Lvl 5', '100K', 1, 2, 3, 4, 50);
const statIds = alliances.getAllianceMemberStatIds();
ok('getAllianceMemberStatIds now includes both players', statIds.length === 2);

const tradeRows = alliances.getTradeAnalysisRows();
ok('getTradeAnalysisRows returns the stats-joined-to-player rows', tradeRows.length === 2);

const archiveStats = alliances.getAllianceStatsForArchive();
ok('getAllianceStatsForArchive returns full stats rows with player_name', archiveStats.find(s => s.player_id === 1).player_name === 'caveman');

const staleResult = alliances.deleteStaleAllianceMembers([1]);
ok('deleteStaleAllianceMembers removes player 2\'s stats row', staleResult.changes === 1);
ok('deleteStaleAllianceMembers returns {changes: 0} for an empty id list', alliances.deleteStaleAllianceMembers([]).changes === 0);

alliances.insertBroadcast('Attention!!!', 'Test message', 'admin', '2026-01-01 00:00:00');
const broadcasts = alliances.getBroadcasts();
ok('insertBroadcast/getBroadcasts round-trip', broadcasts.length === 1 && broadcasts[0].message === 'Test message');

alliances.updateBroadcast('Updated', 'Changed message', 'admin', '2026-01-02 00:00:00', broadcasts[0].id);
ok('updateBroadcast changes the message', alliances.getBroadcasts()[0].message === 'Changed message');

alliances.deleteBroadcast(broadcasts[0].id);
ok('deleteBroadcast empties the table', alliances.getBroadcasts().length === 0);

alliances.deleteAllAlliances();
ok('deleteAllAlliances empties the table', alliances.countAlliances() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `alliances.js`, run `node src/repositories/alliances.test.js`, confirm it
errors with `Cannot find module './alliances'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/alliances.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/alliances.js src/repositories/alliances.test.js
git commit -m "Add alliances repository module (alliances, alliance_member_stats, alliance_broadcasts)"
```

---

### Task 2: Migrate `src/routes/intel.js`

**Files:**
- Modify: `src/routes/intel.js`

**Interfaces:**
- Consumes: `alliances` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`plansRepo`/`playersRepo` imports, add:
```js
const alliancesRepo = require('../repositories/alliances');
```

- [ ] **Step 2: `/intel/summary`**

Before:
```js
        const alliances = db.prepare(`SELECT COUNT(*) as count FROM alliances`).get().count;
```
After: `const alliances = alliancesRepo.countAlliances();`

- [ ] **Step 3: `/intel/galaxy-map`'s memberIds lookup**

Before:
```js
        const memberIds = db.prepare(`SELECT player_id FROM alliance_member_stats`).all().map(r => r.player_id);
```
After:
```js
        const memberIds = alliancesRepo.getAllianceMemberStatIds().map(r => r.player_id);
```

- [ ] **Step 4: `/intel/trade-analysis`**

Before:
```js
        const rows = db.prepare(`
            SELECT p.name,
                   ams.production_rate,
                   ams.astro_dollars,
                   ams.production_points,
                   p.trade_partners
            FROM alliance_member_stats ams
            JOIN players p ON p.id = ams.player_id
        `).all();
```
After: `const rows = alliancesRepo.getTradeAnalysisRows();`

- [ ] **Step 5: `/intel/alliance-stats`**

Before:
```js
        const stats = db.prepare(`
            SELECT s.*, p.name as player_name
            FROM alliance_member_stats s
            LEFT JOIN players p ON s.player_id = p.id
            ORDER BY s.player_id ASC
        `).all();
```
After: `const stats = alliancesRepo.getAllianceStatsForArchive();`

- [ ] **Step 6: `/intel/war-room/alliances`**

Before:
```js
        const alliances = db.prepare(`
            SELECT a.id, a.tag, a.name, COUNT(p.id) as active_members_count, MAX(p.updated_at) as last_scan_time
            FROM alliances a
            JOIN players p ON p.alliance_id = a.id
            GROUP BY a.id, a.tag, a.name
            HAVING COUNT(p.id) >= 1
            ORDER BY COUNT(p.id) DESC, a.tag ASC
        `).all();
```
After: `const alliances = alliancesRepo.getWarRoomAlliances();`

- [ ] **Step 7: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/routes/intel.js`, and for every remaining
match, read its full SQL text and confirm its primary table is NOT
`alliances`/`alliance_member_stats`/`alliance_broadcasts` (should be `app_users`/
`round_players`/`rounds`/other not-yet-migrated tables).

- [ ] **Step 8: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
In a browser at `https://test.37.27.17.97.nip.io`: check the dashboard summary counts, the
galaxy archive map (own-alliance detection still works), the trade-analysis view, the alliance
archive stats panel, and the War Room alliances filter list.

- [ ] **Step 9: Commit**

```bash
cd /root/awt-test
git add src/routes/intel.js
git commit -m "Migrate intel.js alliances/alliance_member_stats queries to the repository layer"
```

---

### Task 3: Migrate `src/routes/sync.js`

Highest-risk file in this domain — alliances statements are interleaved with already-migrated
players/fleets/systems calls inside FOUR separate transaction scopes.

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `alliances` from Task 1

- [ ] **Step 1: Add the import**

```js
const alliancesRepo = require('../repositories/alliances');
```

- [ ] **Step 2: `/sync/system`'s alliance upsert (statement declaration + call site)**

Before (statement declaration, near the top of the handler):
```js
    const upsertAlliance = db.prepare(`
        INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, updated_at=CURRENT_TIMESTAMP
    `);
```
After: delete this declaration entirely.

Before (call site, inside `syncTransaction`'s planet loop, alongside the player upsert — leave
`playersRepo.upsertPlayerBasic` untouched, only the `upsertAlliance.run(...)` line changes):
```js
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                playersRepo.upsertPlayerBasic(p.owner.id, p.owner.name, p.owner.alliance_id || null);
```
After:
```js
                if (p.owner.alliance_id) alliancesRepo.upsertAllianceBasic(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                playersRepo.upsertPlayerBasic(p.owner.id, p.owner.name, p.owner.alliance_id || null);
```

- [ ] **Step 3: `/sync/player`'s alliance upsert, inside `syncTransaction`**

Before (this sits between the restart-reset block above it and `playersRepo.upsertPlayerFull`
below it — leave both of those untouched, only this block's `db.prepare(...).run(...)` changes):
```js
        if (player.alliance_id) {
            // As in the system scan above: seed name from the tag, `?? ''` because
            // alliances.name is NOT NULL and the tag may be missing.
            db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag=excluded.tag`)
                .run(player.alliance_id, player.alliance_tag ?? null, player.alliance_tag ?? '');
        }
```
After:
```js
        if (player.alliance_id) {
            // As in the system scan above: seed name from the tag, `?? ''` because
            // alliances.name is NOT NULL and the tag may be missing.
            alliancesRepo.upsertAllianceTagOnly(player.alliance_id, player.alliance_tag ?? null, player.alliance_tag ?? '');
        }
```

- [ ] **Step 4: `/sync/alliance`'s alliance upsert, inside its `syncTransaction`**

Before (leave the member-upsert loop below this — `playersRepo.upsertAllianceMemberBasic`,
already migrated — completely untouched; only the "1. Upsert Alliance Data" block changes):
```js
    const syncTransaction = db.transaction((a) => {
        // 1. Upsert Alliance Data
        db.prepare(`
            INSERT INTO alliances (id, name, tag, leader_id, ranking, points_current)
            VALUES (@id, @name, @tag, @leader_id, @ranking, @points)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                tag=excluded.tag,
                leader_id=excluded.leader_id,
                ranking=excluded.ranking,
                points_current=excluded.points_current,
                updated_at=CURRENT_TIMESTAMP
        `).run(a);

        // 2. Map all members to this Alliance
        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                playersRepo.upsertAllianceMemberBasic(member.id, member.name, a.id);
            }
        }
    });
```
After:
```js
    const syncTransaction = db.transaction((a) => {
        // 1. Upsert Alliance Data
        alliancesRepo.upsertAllianceFull(a);

        // 2. Map all members to this Alliance
        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                playersRepo.upsertAllianceMemberBasic(member.id, member.name, a.id);
            }
        }
    });
```

- [ ] **Step 5: `/sync/alliance-stats`'s member-stats upsert, inside its `tx`**

Before (leave `playersRepo.upsertPlayerNameOnly` and the conditional `fleetsRepo` block that
follow this completely untouched — only the `INSERT INTO alliance_member_stats` block changes):
```js
            db.prepare(`
                INSERT INTO alliance_member_stats (
                    player_id, planets_text, next_culture_at, science_rate, culture_rate, production_rate,
                    astro_dollars, production_points, artefact, level_text, cv_limit_text,
                    economy, energy, mathematics, physics, population, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(player_id) DO UPDATE SET
                    planets_text=excluded.planets_text,
                    next_culture_at=excluded.next_culture_at,
                    science_rate=excluded.science_rate,
                    culture_rate=excluded.culture_rate,
                    production_rate=excluded.production_rate,
                    astro_dollars=excluded.astro_dollars,
                    production_points=excluded.production_points,
                    artefact=excluded.artefact,
                    level_text=excluded.level_text,
                    cv_limit_text=excluded.cv_limit_text,
                    economy=excluded.economy,
                    energy=excluded.energy,
                    mathematics=excluded.mathematics,
                    physics=excluded.physics,
                    population=excluded.population,
                    updated_at=CURRENT_TIMESTAMP
            `).run(
                s.player_id, s.planets_text, nextCultureAt, s.science_rate, s.culture_rate, s.production_rate,
                s.astro_dollars, s.production_points, s.artefact, s.level_text, s.cv_limit_text,
                s.economy, s.energy, s.mathematics, s.physics, s.population
            );

            playersRepo.upsertPlayerNameOnly(s.player_id, s.name);
```
After:
```js
            alliancesRepo.upsertAllianceMemberStats(
                s.player_id, s.planets_text, nextCultureAt, s.science_rate, s.culture_rate, s.production_rate,
                s.astro_dollars, s.production_points, s.artefact, s.level_text, s.cv_limit_text,
                s.economy, s.energy, s.mathematics, s.physics, s.population
            );

            playersRepo.upsertPlayerNameOnly(s.player_id, s.name);
```

- [ ] **Step 6: `/sync/alliance-roster`'s stale-member delete**

Before:
```js
        const placeholders = ids.map(() => '?').join(',');
        const info = db.prepare(
            `DELETE FROM alliance_member_stats WHERE player_id NOT IN (${placeholders})`
        ).run(...ids);
```
After:
```js
        const info = alliancesRepo.deleteStaleAllianceMembers(ids);
```
(The `ids.length === 0` guard a few lines above this already returns early, so
`deleteStaleAllianceMembers` is never called with an empty array here in practice — its internal
empty-array guard exists for callers that don't already guard, same reasoning as
`getSystemsByIds` in the first domain.)

- [ ] **Step 7: Verify no domain call sites were missed, and all four transaction scopes are intact**

Run: `cd /root/awt-test && grep -n "db\.prepare\|db\.transaction" src/routes/sync.js`, and for
every remaining match, read its full SQL text and confirm its primary table is NOT
`alliances`/`alliance_member_stats`/`alliance_broadcasts`. Specifically confirm the final
composition of all four transactions:
1. `syncTransaction` in `/sync/system`: `systemsRepo`/`fleetsRepo` calls (from the first domain,
   including `systemsRepo.logPlanetEvent`) → conditional `alliancesRepo.upsertAllianceBasic` →
   `playersRepo.upsertPlayerBasic` → `systemsRepo.clearMovedPlanet` → `systemsRepo.upsertPlanet` —
   in that relative order.
2. `syncTransaction` in `/sync/player`: `fleetsRepo.deleteFleetsByOwner` → `playersRepo.resetPlayerOnRestart`
   → conditional `alliancesRepo.upsertAllianceTagOnly` → `playersRepo.upsertPlayerFull` →
   conditional `playersRepo.insertPlayerLogin` — in that relative order.
3. `syncTransaction` in `/sync/alliance`: `alliancesRepo.upsertAllianceFull` → loop of
   `playersRepo.upsertAllianceMemberBasic` — in that relative order.
4. `tx` in `/sync/alliance-stats`: `alliancesRepo.upsertAllianceMemberStats` →
   `playersRepo.upsertPlayerNameOnly` → conditional `fleetsRepo.deleteFleetsByOwner` + loop of
   `fleetsRepo.insertFleetForAllianceStats` — in that relative order.

- [ ] **Step 8: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
Browse a system in-game through the proxy to trigger `/sync/system` and confirm alliance tags
still populate correctly on planet ownership. If you can trigger a player-profile visit, an
alliance-profile scan, an alliance-stats scan, or a roster reconcile, confirm no errors in
`pm2 logs awt-test --lines 50 --nostream` and that alliance data updates as expected afterward.

- [ ] **Step 9: Commit**

```bash
cd /root/awt-test
git add src/routes/sync.js
git commit -m "Migrate sync.js alliances/alliance_member_stats queries to the repository layer"
```

---

### Task 4: Migrate the remaining files (admin.js, trade.js, discord_bot.js)

**Files:**
- Modify: `src/routes/admin.js`, `src/routes/trade.js`, `src/discord_bot.js`

**Interfaces:**
- Consumes: `alliances` from Task 1

- [ ] **Step 1: `src/routes/admin.js` — add the import**

Alongside the file's existing repository imports:
```js
const alliancesRepo = require('../repositories/alliances');
```

- [ ] **Step 2: `src/routes/admin.js` — nuke transaction**

Before (leave `archiveRound`, the `battle_reports` delete, and every other call in this
transaction — plus their relative order — completely untouched; only the `alliances` DELETE
moves):
```js
            db.prepare(`DELETE FROM alliances`).run();
```
After:
```js
            alliancesRepo.deleteAllAlliances();
```

- [ ] **Step 3: `src/routes/admin.js` — broadcasts CRUD (4 call sites)**

Before (`POST /admin/broadcasts`):
```js
        db.prepare(`
            INSERT INTO alliance_broadcasts (title, message, author_name, display_time)
            VALUES (?, ?, ?, ?)
        `).run(title || 'Attention!!!', message, author_name, display_time);
```
After: `alliancesRepo.insertBroadcast(title || 'Attention!!!', message, author_name, display_time);`

Before (`GET /broadcasts`):
```js
        const activeAlerts = db.prepare(`
            SELECT id, title, message, author_name, display_time
            FROM alliance_broadcasts
            ORDER BY id DESC
        `).all();
```
After: `const activeAlerts = alliancesRepo.getBroadcasts();`

Before (`PUT /admin/broadcasts/:id`):
```js
        db.prepare(`
            UPDATE alliance_broadcasts
            SET title = ?, message = ?, author_name = ?, display_time = ?
            WHERE id = ?
        `).run(title || 'Attention!!!', message, author_name, display_time, req.params.id);
```
After: `alliancesRepo.updateBroadcast(title || 'Attention!!!', message, author_name, display_time, req.params.id);`

Before (`DELETE /admin/broadcasts/:id`):
```js
        db.prepare(`DELETE FROM alliance_broadcasts WHERE id = ?`).run(req.params.id);
```
After: `alliancesRepo.deleteBroadcast(req.params.id);`

- [ ] **Step 4: `src/routes/trade.js` — add the import**

Alongside the file's existing `playersRepo` import:
```js
const alliancesRepo = require('../repositories/alliances');
```

- [ ] **Step 5: `src/routes/trade.js` — `getTraders()`**

Before:
```js
function getTraders() {
    const rows = db.prepare(`
        SELECT p.name
        FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        WHERE p.has_intel = 1 AND p.race_trader > 0
    `).all();
    return rows.map(r => r.name.toLowerCase());
}
```
After:
```js
function getTraders() {
    const rows = alliancesRepo.getTraders();
    return rows.map(r => r.name.toLowerCase());
}
```

- [ ] **Step 6: `src/routes/trade.js` — `getMembers()`**

Before:
```js
    const rows = db.prepare(`
        SELECT p.name, p.has_intel, p.race_trader,
               ams.hoarded_au, ams.astro_dollars, ams.production_points, ams.production_rate
        FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        ORDER BY p.name COLLATE NOCASE ASC
    `).all();
```
After: `const rows = alliancesRepo.getMembersWithStats();`

- [ ] **Step 7: `src/routes/trade.js` — `canonicalName()`**

Before:
```js
function canonicalName(name) {
    const row = db.prepare(`
        SELECT p.name FROM alliance_member_stats ams
        JOIN players p ON p.id = ams.player_id
        WHERE p.name = ? COLLATE NOCASE LIMIT 1
    `).get(name);
    return row ? row.name : name;
}
```
After:
```js
function canonicalName(name) {
    const row = alliancesRepo.getCanonicalNameFromStats(name);
    return row ? row.name : name;
}
```

- [ ] **Step 8: `src/routes/trade.js` — `/sync/trade-inventory`**

Before:
```js
        db.prepare(`
            INSERT INTO alliance_member_stats (player_id, hoarded_au, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET hoarded_au = excluded.hoarded_au, updated_at = CURRENT_TIMESTAMP
        `).run(row.id, value);
```
After: `alliancesRepo.upsertHoardedAu(row.id, value);`

- [ ] **Step 9: `src/discord_bot.js` — add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`plansRepo`/`playersRepo` imports:
```js
const alliancesRepo = require('./repositories/alliances');
```

- [ ] **Step 10: `src/discord_bot.js` — `!intels` command's alliance-intel list**

Before:
```js
        const alliancesWithIntel = db.prepare(`
            SELECT DISTINCT a.id, a.tag
            FROM alliances a
            JOIN players p ON p.alliance_id = a.id
            WHERE p.has_intel = 1
            ORDER BY a.tag ASC
        `).all();
```
After: `const alliancesWithIntel = alliancesRepo.getWarRoomAllianceIntelTags();`

- [ ] **Step 11: Verify no domain call sites were missed in any of the three files**

Run:
```bash
cd /root/awt-test && grep -n "db\.prepare" src/routes/admin.js src/routes/trade.js src/discord_bot.js
```
For every match across all three files, read its full SQL text and confirm its primary table is
NOT `alliances`/`alliance_member_stats`/`alliance_broadcasts`.

- [ ] **Step 12: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`, confirm the Discord bot reconnects. As admin: check the
broadcast create/edit/delete flow and (carefully) the nuke button if comfortable re-seeding
afterward. As a regular user: check the trade page's traders list, members list, and canonical
name resolution in the trade-agreement flow, and the hoarded-AU save. In Discord: run `!intels`
through an alliance group.

- [ ] **Step 13: Commit**

```bash
cd /root/awt-test
git add src/routes/admin.js src/routes/trade.js src/discord_bot.js
git commit -m "Migrate remaining alliances/alliance_member_stats/alliance_broadcasts call sites to the repository layer"
```

---

### Task 5: Full regression pass and close out the domain

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /root/awt-test && npm test`
Expected: all suites pass (including the new `repositories/alliances.test.js`), exit code 0. If
anything fails, check first whether it's a source-text assertion broken by this domain's
refactor (the pattern that hit `round-archive.test.js`, `vision-model.test.js`, and
`player-sync.test.js` in the prior two domains) before assuming a real behavior regression — fix
the assertion to check the new location if so, following the same approach those three fixes used
(point the regex at the repository file where the logic now lives, verify it still checks the
same real property, don't weaken it).

- [ ] **Step 2: Confirm zero remaining raw call sites for this domain, codebase-wide — properly this time**

Do NOT rely on a single-line grep. Instead:
```bash
cd /root/awt-test && grep -rln "alliance" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js"
```
For every file this lists, read each `db.prepare(...)`/`db.transaction(...)` block's actual SQL
text (not just the grep-matched line) and confirm none of them have
`alliances`/`alliance_member_stats`/`alliance_broadcasts` as their primary `FROM`/`INTO`/
`UPDATE`/`DELETE FROM` target. A hit that's only a JOIN against an already-migrated or
not-yet-migrated table is fine to leave; a hit where this domain's table IS the primary table is
a missed call site — add a step here migrating it before continuing.

- [ ] **Step 3: Final end-to-end pass on `awt-test`**

Run: `pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 30 --nostream`
Expected: clean boot, no errors, Discord bot reconnects. Spend a few minutes clicking through
the hub's alliance-related pages (War Room alliance filter, trade page, admin broadcasts, the
alliance archive stats panel) and the `!intels` Discord command one more time, now that every
call site for this domain has moved.
