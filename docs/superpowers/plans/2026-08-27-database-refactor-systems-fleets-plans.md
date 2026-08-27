# Database Refactor — systems/fleets/plans domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every raw `db.prepare()` call site touching the `systems`, `best_guarded`, `planets`,
`planet_events`, `planet_takeovers`, `fleets`, and `planet_plans` tables into three new repository
modules (`systems.js`, `fleets.js`, `plans.js`), with prepared statements compiled once at module
load instead of per call.

**Architecture:** New `src/repositories/` directory. Each module exports named functions wrapping
module-level `db.prepare()` statements. Consuming files (`intel.js`, `sync.js`, `discord_bot.js`,
`admin.js`, `routes.js`, `search.js`, `interceptors.js`, `discord-commands.js`) import these
functions instead of calling `db.prepare()` directly. Where a route touches tables outside this
domain (e.g. `players`, `alliances`) in the same handler, only the calls for this domain's tables
are migrated — the rest stay as raw `db.prepare()` until their own domain's plan runs. Mixing
prepared statements from different repository modules inside one `db.transaction()` callback is
safe: better-sqlite3 transactions are scoped to the shared `db` connection, not to which module
compiled a given statement.

**Tech Stack:** Node.js, better-sqlite3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Global Constraints

- No SQL text, parameter order, or return-shape changes for any migrated query, with ONE
  documented exception: `systems.getSystemCoords(id)` consolidates 7 near-identical
  `SELECT [name,]x,y FROM systems WHERE id = ?` call sites (some select `name, x, y`, one
  selects `id, name, x, y`) into a single `SELECT id, name, x, y FROM systems WHERE id = ?` —
  every existing caller destructures only the fields it already used, so the extra `id` field
  present in some result objects that didn't have it before is inert. This is the only
  sanctioned consolidation in this plan; every other function is a 1:1 move.
- No error-handling changes. Repository functions throw whatever better-sqlite3 throws;
  try/catch and HTTP status codes stay in the calling route exactly as they are today.
- Every repository function takes plain arguments and returns plain values/rows — no request
  or response objects passed in.
- After each task's migration step, restart `awt-test` (`pm2 restart awt-test`) and manually
  exercise the affected feature before moving to the next task.

---

## File Structure

- Create: `src/repositories/systems.js` — systems, best_guarded, planets, planet_events,
  planet_takeovers
- Create: `src/repositories/fleets.js` — fleets
- Create: `src/repositories/plans.js` — planet_plans
- Create: `src/repositories/systems.test.js`, `src/repositories/fleets.test.js`,
  `src/repositories/plans.test.js`
- Modify: `src/database.js` (testability: path override — see Task 0)
- Modify: `src/routes/intel.js`, `src/routes/sync.js`, `src/discord_bot.js`,
  `src/routes/admin.js`, `src/routes/routes.js`, `src/routes/search.js`,
  `src/utils/interceptors.js`, `src/discord-commands.js`

---

### Task 0: Make the database path testable

The smoke tests need a throwaway SQLite file, but `src/database.js` hardcodes its path to
`awt.db` next to itself and runs `initDatabase()` immediately on `require`. Add an env override
so tests can point it elsewhere without touching production behavior.

**Files:**
- Modify: `src/database.js:1-6`

**Interfaces:**
- Produces: requiring `../database` with `process.env.AWT_DB_PATH` set uses that path instead
  of the default `awt.db`. Unset, behavior is unchanged.

- [ ] **Step 1: Change the hardcoded path to an overridable one**

In `src/database.js`, replace:

```js
const dbPath = path.join(__dirname, '..', 'awt.db');
const db = new Database(dbPath);
```

with:

```js
const dbPath = process.env.AWT_DB_PATH || path.join(__dirname, '..', 'awt.db');
const db = new Database(dbPath);
```

- [ ] **Step 2: Verify the app still boots normally**

Run: `cd /root/awt-test && pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 5 --nostream`
Expected: `[Core] Alliance Intelligence Hub v2 online on port 3001`, no new errors, and
`ls -la /root/awt-test/awt.db` shows the same file (unchanged mtime pattern — i.e. still the one
you copied earlier, not a new empty one).

- [ ] **Step 3: Commit**

```bash
cd /root/awt-test
git add src/database.js
git commit -m "Allow AWT_DB_PATH to override the database file, for tests"
```

---

### Task 1: `src/repositories/systems.js`

**Files:**
- Create: `src/repositories/systems.js`
- Test: `src/repositories/systems.test.js`

**Interfaces:**
- Consumes: `db` from `../database` (the shared better-sqlite3 connection)
- Produces (used by Tasks 4–7):
  - `countSystems(): number`
  - `countPlanets(): number`
  - `getSystemCoords(id): {id, name, x, y} | undefined`
  - `getFullSystem(id): object | undefined`
  - `listSystemIds(): number[]`
  - `getSystemsByIds(ids: number[]): Array<{id, name, x, y}>`
  - `listSystemsWithCoordsLimited(limit: number): Array<{id, name, x, y}>`
  - `searchSystemsByQueryPrefix(likeTerm: string, prefixTerm: string, limit: number): Array<{id, name, x, y}>`
  - `searchSystemsByNameOrId(likeTerm: string, exactTerm: string): Array<{id, name, x, y}>`
  - `getSystemsDbSummary(): Array<object>`
  - `getGalaxyMapSystems(): Array<{id, name, x, y, updated_at}>`
  - `getGalaxyMapOwnership(): Array<object>`
  - `upsertSystemStub(id: number): void`
  - `upsertSystemFull(id, name, x, y): void`
  - `deleteAllSystems(): void`
  - `countBestGuardedAt(lastUpdate: string): number`
  - `clearBestGuarded(): void`
  - `insertBestGuarded(planetId, cv, updatedAt): void`
  - `getSystemPlanetsWithIntel(sysId): Array<object>`
  - `getSystemPlanetsForBot(sysId): Array<object>`
  - `getPlanetsFullDb(): Array<object>`
  - `getDistinctSystemsForPlayer(playerId): Array<{id, name, x, y}>`
  - `getPlanetCoordsForPlayer(playerId): Array<{planet_index, x, y}>`
  - `getPlanetHistory(sysId): Array<object>`
  - `getOldPlanet(systemId, planetIndex): {owner_id, population} | undefined`
  - `upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet): void`
  - `clearMovedPlanet(gamePlanetId, systemId, planetIndex): void`
  - `logPlanetEvent(systemId, planetIndex, eventTypeId, oldValue, newValue): void`
  - `deleteAllPlanets(): void`
  - `deleteAllPlanetEvents(): void`
  - `getTakeoverBoard(sysId): Array<object>`
  - `upsertTakeover(systemId, planetIndex, assignedName, pipelineStatus, targetArrivalTime): void`

- [ ] **Step 1: Write the module**

Create `src/repositories/systems.js`:

```js
const db = require('../database');

// --- systems ---

const countSystemsStmt = db.prepare(`SELECT COUNT(*) as count FROM systems`);
function countSystems() {
    return countSystemsStmt.get().count;
}

const countPlanetsStmt = db.prepare(`SELECT COUNT(*) as count FROM planets`);
function countPlanets() {
    return countPlanetsStmt.get().count;
}

// Consolidates 7 near-identical lookups (discord_bot.js x5, sync.js announce x1,
// interceptors.js x1) into one shape: id, name, x, y. See Global Constraints.
const getSystemCoordsStmt = db.prepare(`SELECT id, name, x, y FROM systems WHERE id = ?`);
function getSystemCoords(id) {
    return getSystemCoordsStmt.get(id);
}

const getFullSystemStmt = db.prepare(`SELECT * FROM systems WHERE id = ?`);
function getFullSystem(id) {
    return getFullSystemStmt.get(id);
}

const listSystemIdsStmt = db.prepare(`SELECT id FROM systems ORDER BY id ASC`);
function listSystemIds() {
    return listSystemIdsStmt.all();
}

// Arity varies per call, so this statement is prepared fresh each call (matches the
// original behavior in routes/routes.js) rather than cached at module load.
function getSystemsByIds(ids) {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id, name, x, y FROM systems WHERE id IN (${marks})`).all(...ids);
}

const listSystemsWithCoordsLimitedStmt = db.prepare(
    `SELECT id, name, x, y FROM systems WHERE x IS NOT NULL ORDER BY id LIMIT ?`
);
function listSystemsWithCoordsLimited(limit) {
    return listSystemsWithCoordsLimitedStmt.all(limit);
}

const searchSystemsByQueryPrefixStmt = db.prepare(`
    SELECT id, name, x, y FROM systems
    WHERE name LIKE ? OR CAST(id AS TEXT) LIKE ?
    ORDER BY LENGTH(COALESCE(name, '')) ASC LIMIT ?
`);
function searchSystemsByQueryPrefix(likeTerm, prefixTerm, limit) {
    return searchSystemsByQueryPrefixStmt.all(likeTerm, prefixTerm, limit);
}

const searchSystemsByNameOrIdStmt = db.prepare(`
    SELECT id, name, x, y
    FROM systems
    WHERE name LIKE ? OR CAST(id AS TEXT) = ?
    LIMIT 20
`);
function searchSystemsByNameOrId(likeTerm, exactTerm) {
    return searchSystemsByNameOrIdStmt.all(likeTerm, exactTerm);
}

const getSystemsDbSummaryStmt = db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM planets WHERE system_id = s.id) as planet_count,
           (SELECT COUNT(*) FROM fleets WHERE system_id = s.id) as fleet_count
    FROM systems s
`);
function getSystemsDbSummary() {
    return getSystemsDbSummaryStmt.all();
}

const getGalaxyMapSystemsStmt = db.prepare(`
    SELECT s.id, s.name, s.x, s.y, s.updated_at
    FROM systems s
    WHERE s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getGalaxyMapSystems() {
    return getGalaxyMapSystemsStmt.all();
}

const getGalaxyMapOwnershipStmt = db.prepare(`
    SELECT p.system_id,
           a.id  AS alliance_id,
           a.tag AS alliance_tag,
           COUNT(*) AS planets,
           SUM(CASE WHEN p.owner_id IS NULL OR p.owner_id = 0 THEN 1 ELSE 0 END) AS free_planets,
           SUM(CASE WHEN p.is_sieged = 1 THEN 1 ELSE 0 END) AS sieged_planets,
           MAX(p.updated_at) AS last_seen
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    GROUP BY p.system_id, a.id
`);
function getGalaxyMapOwnership() {
    return getGalaxyMapOwnershipStmt.all();
}

const upsertSystemStubStmt = db.prepare(`INSERT INTO systems (id) VALUES (?) ON CONFLICT(id) DO NOTHING`);
function upsertSystemStub(id) {
    upsertSystemStubStmt.run(id);
}

const upsertSystemFullStmt = db.prepare(`
    INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        x=excluded.x,
        y=excluded.y,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertSystemFull(id, name, x, y) {
    upsertSystemFullStmt.run(id, name, x, y);
}

const deleteAllSystemsStmt = db.prepare(`DELETE FROM systems`);
function deleteAllSystems() {
    deleteAllSystemsStmt.run();
}

// --- best_guarded ---

const countBestGuardedAtStmt = db.prepare(`SELECT COUNT(*) as count FROM best_guarded WHERE updated_at = ?`);
function countBestGuardedAt(lastUpdate) {
    return countBestGuardedAtStmt.get(lastUpdate).count;
}

const clearBestGuardedStmt = db.prepare(`DELETE FROM best_guarded`);
function clearBestGuarded() {
    clearBestGuardedStmt.run();
}

const insertBestGuardedStmt = db.prepare(`
    INSERT INTO best_guarded (game_planet_id, cv, updated_at)
    VALUES (?, ?, ?)
`);
function insertBestGuarded(planetId, cv, updatedAt) {
    insertBestGuardedStmt.run(planetId, cv, updatedAt);
}

// --- planets ---

const getSystemPlanetsWithIntelStmt = db.prepare(`
    SELECT p.planet_index, p.population, p.starbase, p.has_fleet, p.is_sieged, p.game_planet_id,
           u.name as owner_name, u.home_system_id, u.home_planet_index, u.possible_homes,
           a.tag as alliance_tag,
           bg.cv as guard_cv
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    LEFT JOIN best_guarded bg ON p.game_planet_id = bg.game_planet_id
    WHERE p.system_id = ?
    ORDER BY p.planet_index ASC
`);
function getSystemPlanetsWithIntel(sysId) {
    return getSystemPlanetsWithIntelStmt.all(sysId);
}

const getSystemPlanetsForBotStmt = db.prepare(`
    SELECT p.*, u.name as owner_name, a.tag as ally_tag
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE p.system_id = ? ORDER BY p.planet_index ASC
`);
function getSystemPlanetsForBot(sysId) {
    return getSystemPlanetsForBotStmt.all(sysId);
}

const getPlanetsFullDbStmt = db.prepare(`
    SELECT p.system_id, p.planet_index, p.population, p.starbase, p.is_sieged, p.updated_at,
           s.name as system_name, s.x, s.y,
           u.name as owner_name, a.tag as alliance_tag
    FROM planets p
    LEFT JOIN systems s ON p.system_id = s.id
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
`);
function getPlanetsFullDb() {
    return getPlanetsFullDbStmt.all();
}

const getDistinctSystemsForPlayerStmt = db.prepare(`
    SELECT DISTINCT s.id, s.name, s.x, s.y
    FROM planets p
    JOIN systems s ON p.system_id = s.id
    WHERE p.owner_id = ?
`);
function getDistinctSystemsForPlayer(playerId) {
    return getDistinctSystemsForPlayerStmt.all(playerId);
}

const getPlanetCoordsForPlayerStmt = db.prepare(`
    SELECT p.planet_index, s.x, s.y
    FROM planets p
    JOIN systems s ON p.system_id = s.id
    WHERE p.owner_id = ?
`);
function getPlanetCoordsForPlayer(playerId) {
    return getPlanetCoordsForPlayerStmt.all(playerId);
}

const getOldPlanetStmt = db.prepare(`SELECT owner_id, population FROM planets WHERE system_id = ? AND planet_index = ?`);
function getOldPlanet(systemId, planetIndex) {
    return getOldPlanetStmt.get(systemId, planetIndex);
}

const upsertPlanetStmt = db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        game_planet_id=excluded.game_planet_id,
        owner_id=excluded.owner_id,
        population=excluded.population,
        starbase=excluded.starbase,
        has_fleet=excluded.has_fleet,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet) {
    upsertPlanetStmt.run(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet);
}

const clearMovedPlanetStmt = db.prepare(`
    DELETE FROM planets WHERE game_planet_id = ? AND (system_id != ? OR planet_index != ?)
`);
function clearMovedPlanet(gamePlanetId, systemId, planetIndex) {
    clearMovedPlanetStmt.run(gamePlanetId, systemId, planetIndex);
}

const deleteAllPlanetsStmt = db.prepare(`DELETE FROM planets`);
function deleteAllPlanets() {
    deleteAllPlanetsStmt.run();
}

// --- planet_events ---

const logPlanetEventStmt = db.prepare(`
    INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
`);
function logPlanetEvent(systemId, planetIndex, eventTypeId, oldValue, newValue) {
    logPlanetEventStmt.run(systemId, planetIndex, eventTypeId, oldValue, newValue);
}

const getPlanetHistoryStmt = db.prepare(`
    SELECT e.id, e.planet_index, e.event_type_id, e.timestamp, e.old_value, e.new_value,
           o1.name as old_owner, o2.name as new_owner
    FROM planet_events e
    LEFT JOIN players o1 ON e.old_value = o1.id AND e.event_type_id = 1
    LEFT JOIN players o2 ON e.new_value = o2.id AND e.event_type_id = 1
    WHERE e.system_id = ?
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT 10
`);
function getPlanetHistory(sysId) {
    return getPlanetHistoryStmt.all(sysId);
}

const deleteAllPlanetEventsStmt = db.prepare(`DELETE FROM planet_events`);
function deleteAllPlanetEvents() {
    deleteAllPlanetEventsStmt.run();
}

// --- planet_takeovers ---

const getTakeoverBoardStmt = db.prepare(`
    SELECT p.planet_index, p.population, p.starbase, p.has_fleet,
           u.name as owner_name, a.tag as alliance_tag,
           t.assigned_name, t.pipeline_status, t.target_arrival_time,
           runner.energy as runner_energy, runner.race_speed as runner_speed,
           sys_target.x as target_x, sys_target.y as target_y,
           sys_origin.x as origin_x, sys_origin.y as origin_y
    FROM planets p
    LEFT JOIN players u ON p.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    LEFT JOIN planet_takeovers t ON p.system_id = t.system_id AND p.planet_index = t.planet_index
    LEFT JOIN players runner ON LOWER(t.assigned_name) = LOWER(runner.name)
    LEFT JOIN systems sys_target ON p.system_id = sys_target.id
    LEFT JOIN systems sys_origin ON runner.origin_system = sys_origin.id
    WHERE p.system_id = ?
    ORDER BY p.planet_index ASC
`);
function getTakeoverBoard(sysId) {
    return getTakeoverBoardStmt.all(sysId);
}

const upsertTakeoverStmt = db.prepare(`
    INSERT INTO planet_takeovers (system_id, planet_index, assigned_name, pipeline_status, target_arrival_time, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        assigned_name = CASE WHEN excluded.assigned_name = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.assigned_name, assigned_name) END,
        pipeline_status = COALESCE(excluded.pipeline_status, pipeline_status),
        target_arrival_time = CASE WHEN excluded.target_arrival_time = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.target_arrival_time, target_arrival_time) END,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertTakeover(systemId, planetIndex, assignedName, pipelineStatus, targetArrivalTime) {
    upsertTakeoverStmt.run(systemId, planetIndex, assignedName, pipelineStatus, targetArrivalTime);
}

module.exports = {
    countSystems, countPlanets, getSystemCoords, getFullSystem, listSystemIds, getSystemsByIds,
    listSystemsWithCoordsLimited, searchSystemsByQueryPrefix, searchSystemsByNameOrId,
    getSystemsDbSummary, getGalaxyMapSystems, getGalaxyMapOwnership, upsertSystemStub,
    upsertSystemFull, deleteAllSystems, countBestGuardedAt, clearBestGuarded, insertBestGuarded,
    getSystemPlanetsWithIntel, getSystemPlanetsForBot, getPlanetsFullDb,
    getDistinctSystemsForPlayer, getPlanetCoordsForPlayer, getOldPlanet, upsertPlanet,
    clearMovedPlanet, deleteAllPlanets, logPlanetEvent, getPlanetHistory, deleteAllPlanetEvents,
    getTakeoverBoard, upsertTakeover,
};
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/systems.test.js`:

```js
// Smoke test: does the module load, do its statements compile, do the basic functions
// return the right shape? Not a full behavior suite — see the migration tasks for the
// manual verification that carries the real risk.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const systems = require('./systems');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('systems.test.js');

ok('countSystems starts at 0', systems.countSystems() === 0);

systems.upsertSystemFull(1, 'Rana', 10, 20);
ok('getSystemCoords returns the upserted row', () => true);
const coords = systems.getSystemCoords(1);
ok('getSystemCoords name matches', coords.name === 'Rana');
ok('getSystemCoords x matches', coords.x === 10);
ok('countSystems is 1 after upsert', systems.countSystems() === 1);

systems.upsertSystemStub(2);
ok('upsertSystemStub creates a bare row', systems.getFullSystem(2).id === 2);
ok('upsertSystemStub row has null name', systems.getFullSystem(2).name === null);

const byIds = systems.getSystemsByIds([1, 2, 999]);
ok('getSystemsByIds returns only existing ids', byIds.length === 2);

systems.upsertPlanet(500, 1, 1, null, 1000, 3, 0);
const planets = systems.getSystemPlanetsWithIntel(1);
ok('getSystemPlanetsWithIntel returns the planet', planets.length === 1 && planets[0].population === 1000);

ok('countPlanets is 1', systems.countPlanets() === 1);

systems.clearMovedPlanet(500, 2, 5);
ok('clearMovedPlanet does not remove a planet at its current location', systems.countPlanets() === 1);

systems.logPlanetEvent(1, 1, 1, null, 42);
const history = systems.getPlanetHistory(1);
ok('getPlanetHistory returns the logged event', history.length === 1 && history[0].new_value === 42);

systems.upsertTakeover(1, 1, 'caveman', 2, null);
const board = systems.getTakeoverBoard(1);
ok('getTakeoverBoard shows the assigned runner', board[0].assigned_name === 'caveman');

systems.insertBestGuarded(500, '10.5K', '2026-08-27');
ok('countBestGuardedAt finds the inserted row', systems.countBestGuardedAt('2026-08-27') === 1);
systems.clearBestGuarded();
ok('clearBestGuarded empties the table', systems.countBestGuardedAt('2026-08-27') === 0);

systems.deleteAllPlanets();
ok('deleteAllPlanets empties planets', systems.countPlanets() === 0);
systems.deleteAllSystems();
ok('deleteAllSystems empties systems', systems.countSystems() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first (module doesn't exist yet)**

If you wrote Step 1 before Step 2, skip this — the point is to see a real failure before the
real pass. Otherwise: temporarily rename `systems.js` and run:

Run: `cd /root/awt-test && node src/repositories/systems.test.js`
Expected: `Error: Cannot find module './systems'`

Restore the filename before continuing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/systems.test.js`
Expected: every line prints `ok -`, ends with `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/systems.js src/repositories/systems.test.js
git commit -m "Add systems repository module (systems, best_guarded, planets, planet_events, planet_takeovers)"
```

---

### Task 2: `src/repositories/fleets.js`

**Files:**
- Create: `src/repositories/fleets.js`
- Test: `src/repositories/fleets.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Tasks 4–7):
  - `countFleets(): number`
  - `getFleetsForSystem(sysId): Array<object>`
  - `getFleetsForSystemFull(sysId): Array<object>`
  - `getFleetsFullDb(): Array<object>`
  - `getFleetsForTimeline(): Array<object>`
  - `deleteFleetsOlderThan10Days(): {changes: number}`
  - `deleteAllFleets(): void`
  - `deleteFleetsByOwner(ownerId): void`
  - `insertFleetForAllianceStats(ownerId, systemId, planetIndex, transports, colonyShips, destroyers, cruisers, battleships, arrivalAt): void`
  - `updateFleetGameId(gameFleetId, ownerId, systemId, planetIndex): {changes: number}`
  - `getInterceptFleetsByAlliance(allianceId): Array<object>`
  - `getInterceptFleetsByActiveUsers(): Array<object>`

- [ ] **Step 1: Write the module**

Create `src/repositories/fleets.js`:

```js
const db = require('../database');

const countFleetsStmt = db.prepare(`SELECT COUNT(*) as count FROM fleets`);
function countFleets() {
    return countFleetsStmt.get().count;
}

const getFleetsForSystemStmt = db.prepare(`
    SELECT f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships,
           u.name as owner_name, a.tag as alliance_tag
    FROM fleets f
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE f.system_id = ?
`);
function getFleetsForSystem(sysId) {
    return getFleetsForSystemStmt.all(sysId);
}

const getFleetsForSystemFullStmt = db.prepare(`
    SELECT f.*, u.name as owner_name, a.tag as ally_tag
    FROM fleets f
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
    WHERE f.system_id = ?
`);
function getFleetsForSystemFull(sysId) {
    return getFleetsForSystemFullStmt.all(sysId);
}

const getFleetsFullDbStmt = db.prepare(`
    SELECT f.*,
           s.name as system_name, s.x, s.y,
           u.name as owner_name, a.tag as alliance_tag
    FROM fleets f
    LEFT JOIN systems s ON f.system_id = s.id
    LEFT JOIN players u ON f.owner_id = u.id
    LEFT JOIN alliances a ON u.alliance_id = a.id
`);
function getFleetsFullDb() {
    return getFleetsFullDbStmt.all();
}

const getFleetsForTimelineStmt = db.prepare(`
    SELECT f.*,
           s.name as system_name, s.x, s.y,
           p.name as owner_name, a.tag as alliance_tag,
           pl.note as plan_note, u.game_name as plan_author
    FROM fleets f
    LEFT JOIN systems s ON f.system_id = s.id
    LEFT JOIN players p ON f.owner_id = p.id
    LEFT JOIN alliances a ON p.alliance_id = a.id
    LEFT JOIN planet_plans pl ON f.system_id = pl.system_id AND f.planet_index = pl.planet_index
    LEFT JOIN app_users u ON pl.author_id = u.id
    WHERE f.arrival_time IS NOT NULL AND f.arrival_time != '-'
    ORDER BY f.arrival_time ASC
`);
function getFleetsForTimeline() {
    return getFleetsForTimelineStmt.all();
}

const deleteFleetsOlderThan10DaysStmt = db.prepare(`DELETE FROM fleets WHERE updated_at <= datetime('now', '-10 days')`);
function deleteFleetsOlderThan10Days() {
    return deleteFleetsOlderThan10DaysStmt.run();
}

const deleteAllFleetsStmt = db.prepare(`DELETE FROM fleets`);
function deleteAllFleets() {
    deleteAllFleetsStmt.run();
}

const deleteFleetsByOwnerStmt = db.prepare(`DELETE FROM fleets WHERE owner_id = ?`);
function deleteFleetsByOwner(ownerId) {
    deleteFleetsByOwnerStmt.run(ownerId);
}

const insertFleetForAllianceStatsStmt = db.prepare(`
    INSERT INTO fleets (owner_id, system_id, planet_index, transports, colony_ships, destroyers, cruisers, battleships, arrival_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function insertFleetForAllianceStats(ownerId, systemId, planetIndex, transports, colonyShips, destroyers, cruisers, battleships, arrivalAt) {
    insertFleetForAllianceStatsStmt.run(ownerId, systemId, planetIndex, transports, colonyShips, destroyers, cruisers, battleships, arrivalAt);
}

const updateFleetGameIdStmt = db.prepare(`
    UPDATE fleets SET game_fleet_id = ?
    WHERE owner_id = ? AND system_id = ? AND planet_index = ?
`);
function updateFleetGameId(gameFleetId, ownerId, systemId, planetIndex) {
    return updateFleetGameIdStmt.run(gameFleetId, ownerId, systemId, planetIndex);
}

// Two fixed variants of interceptors.js's dynamic WHERE clause, so both stay
// module-level prepared statements instead of being rebuilt from a string per call.
const getInterceptFleetsByAllianceStmt = db.prepare(`
    SELECT f.system_id AS origin_sys, f.planet_index, f.game_fleet_id,
           f.destroyers, f.cruisers, f.battleships, f.arrival_at,
           p.id AS owner_id, p.name AS owner_name, p.energy, p.race_speed,
           s.x AS sx, s.y AS sy
    FROM fleets f
    JOIN players p ON f.owner_id = p.id
    JOIN systems s ON f.system_id = s.id
    WHERE p.alliance_id = @aid AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptFleetsByAlliance(allianceId) {
    return getInterceptFleetsByAllianceStmt.all({ aid: allianceId });
}

const getInterceptFleetsByActiveUsersStmt = db.prepare(`
    SELECT f.system_id AS origin_sys, f.planet_index, f.game_fleet_id,
           f.destroyers, f.cruisers, f.battleships, f.arrival_at,
           p.id AS owner_id, p.name AS owner_name, p.energy, p.race_speed,
           s.x AS sx, s.y AS sy
    FROM fleets f
    JOIN players p ON f.owner_id = p.id
    JOIN systems s ON f.system_id = s.id
    WHERE LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1) AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptFleetsByActiveUsers() {
    return getInterceptFleetsByActiveUsersStmt.all();
}

module.exports = {
    countFleets, getFleetsForSystem, getFleetsForSystemFull, getFleetsFullDb,
    getFleetsForTimeline, deleteFleetsOlderThan10Days, deleteAllFleets, deleteFleetsByOwner,
    insertFleetForAllianceStats, updateFleetGameId,
    getInterceptFleetsByAlliance, getInterceptFleetsByActiveUsers,
};
```

Note: `p.energy` appears in the original `interceptors.js` query but the `players` schema (see
`src/database.js`) has no `energy` column — this is a pre-existing bug (the column is silently
`undefined` in every result row today). Out of scope per Global Constraints: moved as-is, flagged
here rather than fixed.

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/fleets.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const fleets = require('./fleets');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('fleets.test.js');

db.prepare(`INSERT INTO players (id, name) VALUES (1, 'caveman')`).run();

ok('countFleets starts at 0', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
ok('countFleets is 1 after insert', fleets.countFleets() === 1);

const forSystem = fleets.getFleetsForSystem(10);
ok('getFleetsForSystem returns the fleet', forSystem.length === 1 && forSystem[0].owner_name === 'caveman');

const upd = fleets.updateFleetGameId(999, 1, 10, 1);
ok('updateFleetGameId updates one row', upd.changes === 1);

fleets.deleteFleetsByOwner(1);
ok('deleteFleetsByOwner removes the fleet', fleets.countFleets() === 0);

fleets.insertFleetForAllianceStats(1, 10, 1, 5, 0, 2, 1, 0, null);
fleets.deleteAllFleets();
ok('deleteAllFleets empties the table', fleets.countFleets() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `fleets.js`, run `node src/repositories/fleets.test.js`, confirm it errors
with `Cannot find module './fleets'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/fleets.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/fleets.js src/repositories/fleets.test.js
git commit -m "Add fleets repository module"
```

---

### Task 3: `src/repositories/plans.js`

**Files:**
- Create: `src/repositories/plans.js`
- Test: `src/repositories/plans.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Tasks 4–7):
  - `getPlansForSystem(sysId): Array<{planet_index, note, author}>`
  - `getPlansForSystemDetailed(sysId): Array<{planet_index, note, updated_at, author}>`
  - `getPlansForSystemForBot(sysId): Array<object>`
  - `getAllPlanIndex(): Array<{system_id, planet_index}>`
  - `createPlan(systemId, planetIndex, authorId, note): void`
  - `deletePlanAsAdmin(systemId, planetIndex): {changes: number}`
  - `deletePlanAsAuthor(systemId, planetIndex, authorId): {changes: number}`
  - `planExists(systemId, planetIndex): boolean`
  - `deleteAllPlans(): void`

- [ ] **Step 1: Write the module**

Create `src/repositories/plans.js`:

```js
const db = require('../database');

// Shape used by intel.js's system-intel panel (no updated_at).
const getPlansForSystemStmt = db.prepare(`
    SELECT p.planet_index, p.note, u.game_name as author
    FROM planet_plans p
    LEFT JOIN app_users u ON p.author_id = u.id
    WHERE p.system_id = ?
`);
function getPlansForSystem(sysId) {
    return getPlansForSystemStmt.all(sysId);
}

// Shape used by search.js's GET /plans/:systemId (includes updated_at). Kept separate from
// getPlansForSystem per Global Constraints — same query, different column list.
const getPlansForSystemDetailedStmt = db.prepare(`
    SELECT p.planet_index, p.note, p.updated_at, u.game_name as author
    FROM planet_plans p
    LEFT JOIN app_users u ON p.author_id = u.id
    WHERE p.system_id = ?
`);
function getPlansForSystemDetailed(sysId) {
    return getPlansForSystemDetailedStmt.all(sysId);
}

const getPlansForSystemForBotStmt = db.prepare(`
    SELECT pp.*, u.game_name as author_name
    FROM planet_plans pp
    LEFT JOIN app_users u ON pp.author_id = u.id
    WHERE pp.system_id = ?
`);
function getPlansForSystemForBot(sysId) {
    return getPlansForSystemForBotStmt.all(sysId);
}

const getAllPlanIndexStmt = db.prepare(`SELECT system_id, planet_index FROM planet_plans`);
function getAllPlanIndex() {
    return getAllPlanIndexStmt.all();
}

// Used by both search.js's POST /plans and discord_bot.js's !plan command — a genuine
// duplicate in the original code, safe to share (identical SQL and parameter order in both
// call sites).
const createPlanStmt = db.prepare(`
    INSERT INTO planet_plans (system_id, planet_index, author_id, note)
    VALUES (?, ?, ?, ?)
`);
function createPlan(systemId, planetIndex, authorId, note) {
    createPlanStmt.run(systemId, planetIndex, authorId, note);
}

const deletePlanAsAdminStmt = db.prepare(`DELETE FROM planet_plans WHERE system_id = ? AND planet_index = ?`);
function deletePlanAsAdmin(systemId, planetIndex) {
    return deletePlanAsAdminStmt.run(systemId, planetIndex);
}

const deletePlanAsAuthorStmt = db.prepare(`
    DELETE FROM planet_plans
    WHERE system_id = ? AND planet_index = ? AND (author_id = ? OR author_id IS NULL)
`);
function deletePlanAsAuthor(systemId, planetIndex, authorId) {
    return deletePlanAsAuthorStmt.run(systemId, planetIndex, authorId);
}

const planExistsStmt = db.prepare(`SELECT 1 FROM planet_plans WHERE system_id = ? AND planet_index = ?`);
function planExists(systemId, planetIndex) {
    return !!planExistsStmt.get(systemId, planetIndex);
}

const deleteAllPlansStmt = db.prepare(`DELETE FROM planet_plans`);
function deleteAllPlans() {
    deleteAllPlansStmt.run();
}

module.exports = {
    getPlansForSystem, getPlansForSystemDetailed, getPlansForSystemForBot, getAllPlanIndex,
    createPlan, deletePlanAsAdmin, deletePlanAsAuthor, planExists, deleteAllPlans,
};
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/plans.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const plans = require('./plans');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('plans.test.js');

db.prepare(`INSERT INTO app_users (id, game_name, password_hash) VALUES (1, 'caveman', 'x')`).run();

ok('planExists is false before creation', plans.planExists(10, 1) === false);

plans.createPlan(10, 1, 1, 'siege this');
ok('planExists is true after creation', plans.planExists(10, 1) === true);

const forSystem = plans.getPlansForSystem(10);
ok('getPlansForSystem returns the plan with author name', forSystem[0].author === 'caveman');

const detailed = plans.getPlansForSystemDetailed(10);
ok('getPlansForSystemDetailed includes updated_at', 'updated_at' in detailed[0]);

const index = plans.getAllPlanIndex();
ok('getAllPlanIndex lists the pair', index.length === 1 && index[0].system_id === 10);

const asAuthor = plans.deletePlanAsAuthor(10, 1, 999);
ok('deletePlanAsAuthor does not delete for a different author', asAuthor.changes === 0);

const asAdmin = plans.deletePlanAsAdmin(10, 1);
ok('deletePlanAsAdmin deletes regardless of author', asAdmin.changes === 1);
ok('planExists is false after admin delete', plans.planExists(10, 1) === false);

plans.createPlan(11, 2, 1, 'note');
plans.deleteAllPlans();
ok('deleteAllPlans empties the table', plans.getAllPlanIndex().length === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `plans.js`, run `node src/repositories/plans.test.js`, confirm
`Cannot find module './plans'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/plans.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/plans.js src/repositories/plans.test.js
git commit -m "Add plans repository module"
```

---

### Task 4: Migrate `src/routes/intel.js`

**Files:**
- Modify: `src/routes/intel.js`

**Interfaces:**
- Consumes: `systems`, `fleets`, `plans` from Tasks 1–3

- [ ] **Step 1: Add the imports**

At the top of `src/routes/intel.js`, alongside the existing `const db = require('../database');`,
add:

```js
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const plansRepo = require('../repositories/plans');
```

- [ ] **Step 2: Replace `/intel/summary` (lines 68, 69, 72)**

Before:
```js
        const systems = db.prepare(`SELECT COUNT(*) as count FROM systems`).get().count;
        const planets = db.prepare(`SELECT COUNT(*) as count FROM planets`).get().count;
        const players = db.prepare(`SELECT COUNT(*) as count FROM players`).get().count;
        const alliances = db.prepare(`SELECT COUNT(*) as count FROM alliances`).get().count;
        const fleets = db.prepare(`SELECT COUNT(*) as count FROM fleets`).get().count; // <-- Added fleets
```

After (only the systems/planets/fleets counts move — `players`/`alliances` stay raw `db.prepare`
here until their own domain plan runs):
```js
        const systems = systemsRepo.countSystems();
        const planets = systemsRepo.countPlanets();
        const players = db.prepare(`SELECT COUNT(*) as count FROM players`).get().count;
        const alliances = db.prepare(`SELECT COUNT(*) as count FROM alliances`).get().count;
        const fleets = fleetsRepo.countFleets();
```

- [ ] **Step 3: Replace `/systems` (line 84)**

Before: `const systems = db.prepare(\`SELECT id FROM systems ORDER BY id ASC\`).all();`
After: `const systems = systemsRepo.listSystemIds();`

- [ ] **Step 4: Replace `/intel/system/:id` (lines 110–151)**

Before (the four `db.prepare(...).all(sysId)` blocks for planets/fleets/history/plans):
```js
        const planets = db.prepare(`
            SELECT p.planet_index, p.population, p.starbase, p.has_fleet, p.is_sieged, p.game_planet_id,
                   u.name as owner_name, u.home_system_id, u.home_planet_index, u.possible_homes,
                   a.tag as alliance_tag,
                   bg.cv as guard_cv
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            LEFT JOIN best_guarded bg ON p.game_planet_id = bg.game_planet_id
            WHERE p.system_id = ?
            ORDER BY p.planet_index ASC
        `).all(sysId);

        const fleets = db.prepare(`
            SELECT f.planet_index, f.transports, f.colony_ships, f.destroyers, f.cruisers, f.battleships,
                   u.name as owner_name, a.tag as alliance_tag
            FROM fleets f
            LEFT JOIN players u ON f.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE f.system_id = ?
        `).all(sysId);

        const history = db.prepare(`
            SELECT e.id, e.planet_index, e.event_type_id, e.timestamp, e.old_value, e.new_value,
                   o1.name as old_owner, o2.name as new_owner
            FROM planet_events e
            LEFT JOIN players o1 ON e.old_value = o1.id AND e.event_type_id = 1
            LEFT JOIN players o2 ON e.new_value = o2.id AND e.event_type_id = 1
            WHERE e.system_id = ?
            ORDER BY e.timestamp DESC, e.id DESC
            LIMIT 10
        `).all(sysId);

        const plans = db.prepare(`
            SELECT p.planet_index, p.note, u.game_name as author
            FROM planet_plans p
            LEFT JOIN app_users u ON p.author_id = u.id
            WHERE p.system_id = ?
        `).all(sysId);
```

After:
```js
        const planets = systemsRepo.getSystemPlanetsWithIntel(sysId);
        const fleets = fleetsRepo.getFleetsForSystem(sysId);
        const history = systemsRepo.getPlanetHistory(sysId);
        const plans = plansRepo.getPlansForSystem(sysId);
```

- [ ] **Step 5: Replace `/intel/systems_db` (lines 181–186)**

Before:
```js
        const systems = db.prepare(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM planets WHERE system_id = s.id) as planet_count,
                   (SELECT COUNT(*) FROM fleets WHERE system_id = s.id) as fleet_count
            FROM systems s
        `).all();
```
After: `const systems = systemsRepo.getSystemsDbSummary();`

- [ ] **Step 6: Replace `/intel/galaxy-map`'s `systems` and `ownership` queries (lines 218–239)**

Before:
```js
        const systems = db.prepare(`
            SELECT s.id, s.name, s.x, s.y, s.updated_at
            FROM systems s
            WHERE s.x IS NOT NULL AND s.y IS NOT NULL
        `).all();

        // One row per (system, owning alliance). owner_id is NULL for a planet seen to be
        // unowned, and also for one whose owner has never been scraped — those are counted
        // separately as `free` and `unknown` rather than merged into "nobody".
        const ownership = db.prepare(`
            SELECT p.system_id,
                   a.id  AS alliance_id,
                   a.tag AS alliance_tag,
                   COUNT(*) AS planets,
                   SUM(CASE WHEN p.owner_id IS NULL OR p.owner_id = 0 THEN 1 ELSE 0 END) AS free_planets,
                   SUM(CASE WHEN p.is_sieged = 1 THEN 1 ELSE 0 END) AS sieged_planets,
                   MAX(p.updated_at) AS last_seen
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            GROUP BY p.system_id, a.id
        `).all();
```
After (keep the comment; only the two queries change, `memberIds`/`ownTag`/`observers` below
them stay untouched — those touch `alliance_member_stats`/`players`, migrated in the alliances
and players domain plans):
```js
        const systems = systemsRepo.getGalaxyMapSystems();

        // One row per (system, owning alliance). owner_id is NULL for a planet seen to be
        // unowned, and also for one whose owner has never been scraped — those are counted
        // separately as `free` and `unknown` rather than merged into "nobody".
        const ownership = systemsRepo.getGalaxyMapOwnership();
```

- [ ] **Step 7: Replace `/intel/planets_db` (lines 336–344)**

Before:
```js
        const planets = db.prepare(`
            SELECT p.system_id, p.planet_index, p.population, p.starbase, p.is_sieged, p.updated_at,
                   s.name as system_name, s.x, s.y,
                   u.name as owner_name, a.tag as alliance_tag
            FROM planets p
            LEFT JOIN systems s ON p.system_id = s.id
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
        `).all();
```
After: `const planets = systemsRepo.getPlanetsFullDb();`

- [ ] **Step 8: Replace `/intel/fleets_db` (lines 356–364)**

Before:
```js
        const fleets = db.prepare(`
            SELECT f.*,
                   s.name as system_name, s.x, s.y,
                   u.name as owner_name, a.tag as alliance_tag
            FROM fleets f
            LEFT JOIN systems s ON f.system_id = s.id
            LEFT JOIN players u ON f.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
        `).all();
```
After: `const fleets = fleetsRepo.getFleetsFullDb();`

- [ ] **Step 9: Replace `/intel/player/:id`'s `systems` query (lines 403–408)**

Before:
```js
        const systems = db.prepare(`
            SELECT DISTINCT s.id, s.name, s.x, s.y
            FROM planets p
            JOIN systems s ON p.system_id = s.id
            WHERE p.owner_id = ?
        `).all(playerId);
```
After: `const systems = systemsRepo.getDistinctSystemsForPlayer(playerId);`

- [ ] **Step 10: Replace `/intel/timeline` (lines 569–583)**

Before:
```js
        const timeline = db.prepare(`
            SELECT f.*,
                   s.name as system_name, s.x, s.y,
                   p.name as owner_name, a.tag as alliance_tag,
                   pl.note as plan_note, u.game_name as plan_author
            FROM fleets f
            LEFT JOIN systems s ON f.system_id = s.id
            LEFT JOIN players p ON f.owner_id = p.id
            LEFT JOIN alliances a ON p.alliance_id = a.id
            -- Correlate tactical plan logs to matching destinations
            LEFT JOIN planet_plans pl ON f.system_id = pl.system_id AND f.planet_index = pl.planet_index
            LEFT JOIN app_users u ON pl.author_id = u.id
            WHERE f.arrival_time IS NOT NULL AND f.arrival_time != '-'
            ORDER BY f.arrival_time ASC
        `).all();
```
After: `const timeline = fleetsRepo.getFleetsForTimeline();`

- [ ] **Step 11: Replace `/intel/takeover/:systemId` (lines 596–612)**

Before:
```js
        const board = db.prepare(`
            SELECT p.planet_index, p.population, p.starbase, p.has_fleet,
                   u.name as owner_name, a.tag as alliance_tag,
                   t.assigned_name, t.pipeline_status, t.target_arrival_time,
                   runner.energy as runner_energy, runner.race_speed as runner_speed,
                   sys_target.x as target_x, sys_target.y as target_y,
                   sys_origin.x as origin_x, sys_origin.y as origin_y
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            LEFT JOIN planet_takeovers t ON p.system_id = t.system_id AND p.planet_index = t.planet_index
            LEFT JOIN players runner ON LOWER(t.assigned_name) = LOWER(runner.name)
            LEFT JOIN systems sys_target ON p.system_id = sys_target.id
            LEFT JOIN systems sys_origin ON runner.origin_system = sys_origin.id
            WHERE p.system_id = ?
            ORDER BY p.planet_index ASC
        `).all(sysId);
```
After: `const board = systemsRepo.getTakeoverBoard(sysId);`

- [ ] **Step 12: Replace `POST /intel/takeover` (lines 634–642)**

Before:
```js
        db.prepare(`
            INSERT INTO planet_takeovers (system_id, planet_index, assigned_name, pipeline_status, target_arrival_time, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(system_id, planet_index) DO UPDATE SET
                assigned_name = CASE WHEN excluded.assigned_name = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.assigned_name, assigned_name) END,
                pipeline_status = COALESCE(excluded.pipeline_status, pipeline_status),
                target_arrival_time = CASE WHEN excluded.target_arrival_time = '__REMOVE__' THEN NULL ELSE COALESCE(excluded.target_arrival_time, target_arrival_time) END,
                updated_at = CURRENT_TIMESTAMP
        `).run(system_id, planet_index, assigned_name || null, pipeline_status || null, target_arrival_time || null);
```
After:
```js
        systemsRepo.upsertTakeover(system_id, planet_index, assigned_name || null, pipeline_status || null, target_arrival_time || null);
```

- [ ] **Step 13: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/routes/intel.js | grep -iE "FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|INTO (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|DELETE FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)"`
Expected: no output (every call touching this domain's tables in this file has been replaced;
remaining `db.prepare` lines in the file, if any, belong to other domains).

- [ ] **Step 14: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
In a browser at `https://test.37.27.17.97.nip.io`, log in and check: the dashboard summary
counts load, a system's intel panel shows planets/fleets/history/plans, the galaxy archive map
renders, the War Room takeover board loads and an assignment can be saved, the operations
timeline loads.

- [ ] **Step 15: Commit**

```bash
cd /root/awt-test
git add src/routes/intel.js
git commit -m "Migrate intel.js systems/fleets/plans queries to the repository layer"
```

---

### Task 5: Migrate `src/routes/sync.js`

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `systems`, `fleets` from Tasks 1–2 (this file has no `plans`-domain call sites)

- [ ] **Step 1: Add the imports**

```js
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
```

- [ ] **Step 2: Replace `/sync/system`'s statement setup (lines 15, 30–63)**

Before:
```js
    db.prepare(`INSERT INTO systems (id) VALUES (?) ON CONFLICT(id) DO NOTHING`).run(system_id);
```
...
```js
    const upsertPlanet = db.prepare(`
        INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(system_id, planet_index) DO UPDATE SET
            game_planet_id=excluded.game_planet_id,
            owner_id=excluded.owner_id,
            population=excluded.population,
            starbase=excluded.starbase,
            has_fleet=excluded.has_fleet,
            updated_at=CURRENT_TIMESTAMP
    `);
```
...
```js
    const clearMovedPlanet = db.prepare(`
        DELETE FROM planets WHERE game_planet_id = ? AND (system_id != ? OR planet_index != ?)
    `);

    // --- NEW: History Logging Prep ---
    const getOldPlanet = db.prepare(`SELECT owner_id, population FROM planets WHERE system_id = ? AND planet_index = ?`);
    const getPlayerName = db.prepare(`
        SELECT p.name, a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id = ?
    `);
    const logEvent = db.prepare(`
        INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value)
        VALUES (?, ?, ?, ?, ?)
    `);
```

After (the systems/planets/planet_events statements move to the repository; `getPlayerName`
stays — it's a `players`/`alliances` query, migrated in a later domain plan):
```js
    systemsRepo.upsertSystemStub(system_id);
```
...delete the `upsertPlanet`, `clearMovedPlanet`, `getOldPlanet`, `logEvent` local `const`
declarations entirely (their call sites move to repository calls below).
```js
    const getPlayerName = db.prepare(`
        SELECT p.name, a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id = ?
    `);
```
(unchanged, kept)

Note: these statements were being **re-prepared on every `/sync/system` request** (they lived
inside the route handler, not at module scope) — moving them into `systemsRepo` also fixes that,
as a natural consequence of the module-level-preparation pattern, not a special-cased behavior
change.

- [ ] **Step 3: Replace the call sites inside `syncTransaction` (lines 85, 161–164)**

Before:
```js
            const oldP = getOldPlanet.get(system_id, p.planet_index);
```
After: `const oldP = systemsRepo.getOldPlanet(system_id, p.planet_index);`

Before:
```js
            if (p.game_planet_id != null) {
                clearMovedPlanet.run(p.game_planet_id, system_id, p.planet_index);
            }
            upsertPlanet.run(p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation, finalStarbase, finalHasFleet);
```
After:
```js
            if (p.game_planet_id != null) {
                systemsRepo.clearMovedPlanet(p.game_planet_id, system_id, p.planet_index);
            }
            systemsRepo.upsertPlanet(p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation, finalStarbase, finalHasFleet);
```

The `logEvent`/`announceEvents` history-logging block sits between the two edits above (lines
110–147 in the original file). It has two call sites — leave everything else in this block
(the fog-of-war guards, `announceEvents.push`, `nameOf`) exactly as-is, only replace the two
`logEvent.run(...)` lines:

Before:
```js
                if (oldP.owner_id !== finalOwnerId) {
                    // OWNER CHANGE — takes precedence; a pop drop that comes with a new
                    // owner is really just the conquest, already captured here.
                    logEvent.run(system_id, p.planet_index, 1, oldP.owner_id, finalOwnerId); // 1 = OWNER_CHANGE (history)
```
After:
```js
                if (oldP.owner_id !== finalOwnerId) {
                    // OWNER CHANGE — takes precedence; a pop drop that comes with a new
                    // owner is really just the conquest, already captured here.
                    systemsRepo.logPlanetEvent(system_id, p.planet_index, 1, oldP.owner_id, finalOwnerId); // 1 = OWNER_CHANGE (history)
```

Before:
```js
                    if (Number.isFinite(oldPop) && Number.isFinite(newPop) && newPop < oldPop) {
                        logEvent.run(system_id, p.planet_index, 2, oldPop, newPop); // 2 = POP_DROP
```
After:
```js
                    if (Number.isFinite(oldPop) && Number.isFinite(newPop) && newPop < oldPop) {
                        systemsRepo.logPlanetEvent(system_id, p.planet_index, 2, oldPop, newPop); // 2 = POP_DROP
```

- [ ] **Step 4: Replace the announce lookup (line 180)**

Before:
```js
            const sys = db.prepare(`SELECT id, name, x, y FROM systems WHERE id = ?`).get(system_id) || { id: system_id };
```
After:
```js
            const sys = systemsRepo.getSystemCoords(system_id) || { id: system_id };
```

- [ ] **Step 5: Replace the restart-detection fleet wipe (line 284)**

Before: `db.prepare(\`DELETE FROM fleets WHERE owner_id = ?\`).run(player.id);`
After: `fleetsRepo.deleteFleetsByOwner(player.id);`

- [ ] **Step 6: Replace `/sync/galaxy`'s upsert (lines 475–487)**

Before:
```js
    const upsertSystem = db.prepare(`
        INSERT INTO systems (id, name, x, y) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            x=excluded.x,
            y=excluded.y,
            updated_at=CURRENT_TIMESTAMP
    `);

    const syncTransaction = db.transaction((sysList) => {
        for (const s of sysList) {
            upsertSystem.run(s.id, s.name, s.x, s.y);
        }
    });
```
After:
```js
    const syncTransaction = db.transaction((sysList) => {
        for (const s of sysList) {
            systemsRepo.upsertSystemFull(s.id, s.name, s.x, s.y);
        }
    });
```

- [ ] **Step 7: Replace `/sync/best-guarded` (lines 507, 515–520)**

Before:
```js
    const existingCheck = db.prepare("SELECT COUNT(*) as count FROM best_guarded WHERE updated_at = ?").get(last_update);
```
After: `const existingCheck = { count: systemsRepo.countBestGuardedAt(last_update) };`

Before:
```js
    const syncTx = db.transaction((rows) => {
        db.prepare("DELETE FROM best_guarded").run(); // Clear stale indices safely

        const insertStmt = db.prepare(`
            INSERT INTO best_guarded (game_planet_id, cv, updated_at)
            VALUES (?, ?, ?)
        `);

        for (const row of rows) {
            insertStmt.run(row.planet_id, row.cv, last_update);
        }
    });
```
After:
```js
    const syncTx = db.transaction((rows) => {
        systemsRepo.clearBestGuarded(); // Clear stale indices safely

        for (const row of rows) {
            systemsRepo.insertBestGuarded(row.planet_id, row.cv, last_update);
        }
    });
```

- [ ] **Step 8: Replace `/sync/alliance-stats`'s fleet replacement (lines 588–599)**

Before:
```js
            if (fleets) {
                db.prepare(`DELETE FROM fleets WHERE owner_id = ?`).run(s.player_id);
                const ins = db.prepare(`
                    INSERT INTO fleets (owner_id, system_id, planet_index, transports, colony_ships, destroyers, cruisers, battleships, arrival_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                for (const f of fleets) {
                    if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                    ins.run(
                        s.player_id, f.system_id, f.planet_index,
                        f.transports || 0, f.colony_ships || 0, f.destroyers || 0, f.cruisers || 0, f.battleships || 0,
                        f.arrival_at || null
                    );
```
After:
```js
            if (fleets) {
                fleetsRepo.deleteFleetsByOwner(s.player_id);
                for (const f of fleets) {
                    if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                    fleetsRepo.insertFleetForAllianceStats(
                        s.player_id, f.system_id, f.planet_index,
                        f.transports || 0, f.colony_ships || 0, f.destroyers || 0, f.cruisers || 0, f.battleships || 0,
                        f.arrival_at || null
                    );
```
(the closing `}` two lines below stays as-is — this only replaces the `db.prepare(...).run(` call
pattern with the repository call)

- [ ] **Step 9: Replace `/sync/fleet-ids` (lines 445–448)**

Before:
```js
        const upd = db.prepare(`
            UPDATE fleets SET game_fleet_id = ?
            WHERE owner_id = ? AND system_id = ? AND planet_index = ?
        `);
        let updated = 0;
        const tx = db.transaction((rows) => {
            for (const f of rows) {
                if (!Number.isInteger(f.game_fleet_id) || !Number.isInteger(f.owner_id)) continue;
                if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                updated += upd.run(f.game_fleet_id, f.owner_id, f.system_id, f.planet_index).changes;
            }
        });
```
After:
```js
        let updated = 0;
        const tx = db.transaction((rows) => {
            for (const f of rows) {
                if (!Number.isInteger(f.game_fleet_id) || !Number.isInteger(f.owner_id)) continue;
                if (!Number.isInteger(f.system_id) || !Number.isInteger(f.planet_index)) continue;
                updated += fleetsRepo.updateFleetGameId(f.game_fleet_id, f.owner_id, f.system_id, f.planet_index).changes;
            }
        });
```

- [ ] **Step 10: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare\|db\.exec" src/routes/sync.js | grep -iE "FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|INTO (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|DELETE FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|UPDATE (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)"`
Expected: no output.

- [ ] **Step 11: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
Browse a system in-game through the proxy to trigger `/sync/system`, check its planets/fleets
show up correctly in the hub's system intel panel afterward. If you can trigger a galaxy scan or
alliance-stats scan (or just wait for the next scheduled one), confirm no errors appear in
`pm2 logs awt-test --lines 50 --nostream`.

- [ ] **Step 12: Commit**

```bash
cd /root/awt-test
git add src/routes/sync.js
git commit -m "Migrate sync.js systems/fleets queries to the repository layer"
```

---

### Task 6: Migrate `src/discord_bot.js`

**Files:**
- Modify: `src/discord_bot.js`

**Interfaces:**
- Consumes: `systems`, `fleets`, `plans` from Tasks 1–3

- [ ] **Step 1: Add the imports**

Near the top of `src/discord_bot.js`, alongside its existing `const db = require('./database');`:
```js
const systemsRepo = require('./repositories/systems');
const fleetsRepo = require('./repositories/fleets');
const plansRepo = require('./repositories/plans');
```

- [ ] **Step 2: Replace the `!sys` command block (lines 675–699)**

Before:
```js
        const sys = db.prepare(`SELECT * FROM systems WHERE id = ?`).get(sysId);
        if (!sys) return message.reply(`❌ System #${sysId} is not in the Hub database. Scan it in-game first.`);

        const planets = db.prepare(`
            SELECT p.*, u.name as owner_name, a.tag as ally_tag
            FROM planets p
            LEFT JOIN players u ON p.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE p.system_id = ? ORDER BY p.planet_index ASC
        `).all(sysId);

        const plans = db.prepare(`
            SELECT pp.*, u.game_name as author_name 
            FROM planet_plans pp
            LEFT JOIN app_users u ON pp.author_id = u.id
            WHERE pp.system_id = ?
        `).all(sysId);

        const fleets = db.prepare(`
            SELECT f.*, u.name as owner_name, a.tag as ally_tag
            FROM fleets f
            LEFT JOIN players u ON f.owner_id = u.id
            LEFT JOIN alliances a ON u.alliance_id = a.id
            WHERE f.system_id = ?
        `).all(sysId);
```
After:
```js
        const sys = systemsRepo.getFullSystem(sysId);
        if (!sys) return message.reply(`❌ System #${sysId} is not in the Hub database. Scan it in-game first.`);

        const planets = systemsRepo.getSystemPlanetsForBot(sysId);
        const plans = plansRepo.getPlansForSystemForBot(sysId);
        const fleets = fleetsRepo.getFleetsForSystemFull(sysId);
```

- [ ] **Step 3: Replace the four system-coordinate lookups (lines 458–459, 882–883, 949, 1139)**

At line 458-459:
Before:
```js
        const sys1 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(sysA);
        const sys2 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(sysB);
```
After:
```js
        const sys1 = systemsRepo.getSystemCoords(sysA);
        const sys2 = systemsRepo.getSystemCoords(sysB);
```

At line 882-883, the identical pattern with `id1`/`id2`:
Before:
```js
        const sys1 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(id1);
        const sys2 = db.prepare(`SELECT name, x, y FROM systems WHERE id = ?`).get(id2);
```
After:
```js
        const sys1 = systemsRepo.getSystemCoords(id1);
        const sys2 = systemsRepo.getSystemCoords(id2);
```

At line 949:
Before: `const targetSys = db.prepare("SELECT name, x, y FROM systems WHERE id = ?").get(targetSysId);`
After: `const targetSys = systemsRepo.getSystemCoords(targetSysId);`

At line 1139:
Before: `const targetSys = db.prepare("SELECT name, x, y FROM systems WHERE id = ?").get(sysId);`
After: `const targetSys = systemsRepo.getSystemCoords(sysId);`

- [ ] **Step 4: Replace the plan-index lookup (line 1040)**

Before: `const planRows = db.prepare(\`SELECT system_id, planet_index FROM planet_plans\`).all();`
After: `const planRows = plansRepo.getAllPlanIndex();`

- [ ] **Step 5: Replace the `!plan` command's insert (lines 926–929)**

Before:
```js
            db.prepare(`
                INSERT INTO planet_plans (system_id, planet_index, author_id, note) 
                VALUES (?, ?, ?, ?)
            `).run(sysId, pIdx, user.id, note);
```
After:
```js
            plansRepo.createPlan(sysId, pIdx, user.id, note);
```

- [ ] **Step 6: Replace the vision-scan planet-coordinates lookup (lines 1172–1177)**

Before:
```js
            const scrapedPlanets = db.prepare(`
                SELECT p.planet_index, s.x, s.y
                FROM planets p
                JOIN systems s ON p.system_id = s.id
                WHERE p.owner_id = ?
            `).all(p.id);
```
After:
```js
            const scrapedPlanets = systemsRepo.getPlanetCoordsForPlayer(p.id);
```

- [ ] **Step 7: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/discord_bot.js | grep -iE "FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|INTO (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)"`
Expected: no output.

- [ ] **Step 8: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
In the Discord server the test bot was added to (kombat#2933), run `!sys <a known system id>`,
`!vision <system id>`, and `!plan <system id> <planet> test note`, confirm each responds
correctly and the plan shows up via `!sys` afterward.

- [ ] **Step 9: Commit**

```bash
cd /root/awt-test
git add src/discord_bot.js
git commit -m "Migrate discord_bot.js systems/fleets/plans queries to the repository layer"
```

---

### Task 7: Migrate the remaining files (admin.js, routes.js, search.js, interceptors.js, discord-commands.js)

**Files:**
- Modify: `src/routes/admin.js`, `src/routes/routes.js`, `src/routes/search.js`,
  `src/utils/interceptors.js`, `src/discord-commands.js`

**Interfaces:**
- Consumes: `systems`, `fleets`, `plans` from Tasks 1–3

- [ ] **Step 1: `src/routes/admin.js` — add the import**

```js
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
const plansRepo = require('../repositories/plans');
```

- [ ] **Step 2: `src/routes/admin.js` — `/admin/status` (lines 226, 227, 229)**

Before:
```js
            systems: db.prepare(`SELECT COUNT(*) as count FROM systems`).get().count,
            planets: db.prepare(`SELECT COUNT(*) as count FROM planets`).get().count,
            players: db.prepare(`SELECT COUNT(*) as count FROM players`).get().count,
            fleets: db.prepare(`SELECT COUNT(*) as count FROM fleets`).get().count,
```
After (only `systems`/`planets`/`fleets` move; `players` stays raw until its own domain plan):
```js
            systems: systemsRepo.countSystems(),
            planets: systemsRepo.countPlanets(),
            players: db.prepare(`SELECT COUNT(*) as count FROM players`).get().count,
            fleets: fleetsRepo.countFleets(),
```

- [ ] **Step 3: `src/routes/admin.js` — `/admin/clear-fleets` (line 241)**

Before: `const result = db.prepare(\`DELETE FROM fleets WHERE updated_at <= datetime('now', '-10 days')\`).run();`
After: `const result = fleetsRepo.deleteFleetsOlderThan10Days();`

- [ ] **Step 4: `src/routes/admin.js` — nuke transaction (lines 306–312)**

Before:
```js
            db.prepare(`DELETE FROM fleets`).run();
            db.prepare(`DELETE FROM planet_plans`).run();
            db.prepare(`DELETE FROM planet_events`).run();
            db.prepare(`DELETE FROM planets`).run();
            db.prepare(`DELETE FROM players`).run();
            db.prepare(`DELETE FROM alliances`).run();
            db.prepare(`DELETE FROM systems`).run();
```
After (only the five tables in this domain move; `players`/`alliances` stay raw until their own
domain plans, in the same order relative to them so foreign-key delete order is unchanged):
```js
            fleetsRepo.deleteAllFleets();
            plansRepo.deleteAllPlans();
            systemsRepo.deleteAllPlanetEvents();
            systemsRepo.deleteAllPlanets();
            db.prepare(`DELETE FROM players`).run();
            db.prepare(`DELETE FROM alliances`).run();
            systemsRepo.deleteAllSystems();
```

- [ ] **Step 5: `src/routes/routes.js` — `loadSystems` (line 20–24)**

Before:
```js
function loadSystems(ids) {
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, name, x, y FROM systems WHERE id IN (${marks})`).all(...ids);
    return new Map(rows.map(r => [r.id, r]));
}
```
After (add `const systemsRepo = require('../repositories/systems');` near this file's other
requires):
```js
function loadSystems(ids) {
    if (!ids.length) return new Map();
    const rows = systemsRepo.getSystemsByIds(ids);
    return new Map(rows.map(r => [r.id, r]));
}
```

- [ ] **Step 6: `src/routes/search.js` — add the import**

```js
const plansRepo = require('../repositories/plans');
const systemsRepo = require('../repositories/systems');
```

- [ ] **Step 7: `src/routes/search.js` — `GET /plans/:systemId` (lines 11–16)**

Before:
```js
        const plans = db.prepare(`
            SELECT p.planet_index, p.note, p.updated_at, u.game_name as author
            FROM planet_plans p
            LEFT JOIN app_users u ON p.author_id = u.id
            WHERE p.system_id = ?
        `).all(req.params.systemId);
```
After: `const plans = plansRepo.getPlansForSystemDetailed(req.params.systemId);`

- [ ] **Step 8: `src/routes/search.js` — `POST /plans` (lines 35–38)**

Before:
```js
        db.prepare(`
            INSERT INTO planet_plans (system_id, planet_index, author_id, note)
            VALUES (?, ?, ?, ?)
        `).run(system_id, planet_index, author_id, note);
```
After: `plansRepo.createPlan(system_id, planet_index, author_id, note);`

- [ ] **Step 9: `src/routes/search.js` — `DELETE /plans/:systemId/:planetIndex` (lines 58–69)**

Before:
```js
        const result = isAdmin
            ? db.prepare(`DELETE FROM planet_plans WHERE system_id = ? AND planet_index = ?`)
                .run(systemId, planetIndex)
            : db.prepare(`
                DELETE FROM planet_plans
                WHERE system_id = ? AND planet_index = ? AND (author_id = ? OR author_id IS NULL)
              `).run(systemId, planetIndex, req.session.userId);

        if (result.changes === 0) {
            const stillThere = db.prepare(
                `SELECT 1 FROM planet_plans WHERE system_id = ? AND planet_index = ?`
            ).get(systemId, planetIndex);
            if (stillThere) {
```
After:
```js
        const result = isAdmin
            ? plansRepo.deletePlanAsAdmin(systemId, planetIndex)
            : plansRepo.deletePlanAsAuthor(systemId, planetIndex, req.session.userId);

        if (result.changes === 0) {
            const stillThere = plansRepo.planExists(systemId, planetIndex);
            if (stillThere) {
```

- [ ] **Step 10: `src/routes/search.js` — `GET /search/system` (lines 140–148)**

Before:
```js
        const searchTerm = `%${q}%`;
        const query = db.prepare(`
            SELECT id, name, x, y
            FROM systems
            WHERE name LIKE ? OR CAST(id AS TEXT) = ?
            LIMIT 20
        `);

        const results = query.all(searchTerm, q);
```
After:
```js
        const searchTerm = `%${q}%`;
        const results = systemsRepo.searchSystemsByNameOrId(searchTerm, q);
```

- [ ] **Step 11: `src/utils/interceptors.js` — add the imports**

```js
const systemsRepo = require('../repositories/systems');
const fleetsRepo = require('../repositories/fleets');
```

- [ ] **Step 12: `src/utils/interceptors.js` — `computeInterceptors` (lines 48, 60–69)**

Before:
```js
    const target = db.prepare(`SELECT x, y FROM systems WHERE id = ?`).get(attack.systemId);
```
After: `const target = systemsRepo.getSystemCoords(attack.systemId);`
(the caller only reads `target.x`/`target.y`, so the extra `id`/`name` fields from the
consolidated `getSystemCoords` are unused and harmless — see Global Constraints)

Before:
```js
    const whereClause = allianceId
        ? `p.alliance_id = @aid`
        : `LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1)`;

    const fleets = db.prepare(`
        SELECT f.system_id AS origin_sys, f.planet_index, f.game_fleet_id,
               f.destroyers, f.cruisers, f.battleships, f.arrival_at,
               p.id AS owner_id, p.name AS owner_name, p.energy, p.race_speed,
               s.x AS sx, s.y AS sy
        FROM fleets f
        JOIN players p ON f.owner_id = p.id
        JOIN systems s ON f.system_id = s.id
        WHERE ${whereClause} AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(allianceId ? { aid: allianceId } : {});
```
After:
```js
    const fleets = allianceId
        ? fleetsRepo.getInterceptFleetsByAlliance(allianceId)
        : fleetsRepo.getInterceptFleetsByActiveUsers();
```

- [ ] **Step 13: `src/discord-commands.js` — add the import**

```js
const systemsRepo = require('./repositories/systems');
```

- [ ] **Step 14: `src/discord-commands.js` — `suggestSystems` (lines 64–69)**

Before:
```js
        const rows = q
            ? db.prepare(`
                SELECT id, name, x, y FROM systems
                WHERE name LIKE ? OR CAST(id AS TEXT) LIKE ?
                ORDER BY LENGTH(COALESCE(name, '')) ASC LIMIT ?
              `).all(`%${q}%`, `${q}%`, MAX_CHOICES)
            : db.prepare(`SELECT id, name, x, y FROM systems WHERE x IS NOT NULL ORDER BY id LIMIT ?`).all(MAX_CHOICES);
```
After:
```js
        const rows = q
            ? systemsRepo.searchSystemsByQueryPrefix(`%${q}%`, `${q}%`, MAX_CHOICES)
            : systemsRepo.listSystemsWithCoordsLimited(MAX_CHOICES);
```

- [ ] **Step 15: Verify no domain call sites were missed in any of the five files**

Run:
```bash
cd /root/awt-test && grep -n "db\.prepare" src/routes/admin.js src/routes/routes.js src/routes/search.js src/utils/interceptors.js src/discord-commands.js | grep -iE "FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|INTO (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)|DELETE FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)"
```
Expected: no output.

- [ ] **Step 16: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
As admin: check `/admin` status counts, clear-fleets button, and (carefully — this wipes the
test DB's round data) the nuke button if you're comfortable re-seeding afterward. As a regular
user: try the route planner (exercises `loadSystems`), the shared plans list/create/delete on a
system page, and the system-name autocomplete search box. If incoming-attack alerts are active,
confirm an interceptor-eligible alert still lists the right defending fleets.

- [ ] **Step 17: Commit**

```bash
cd /root/awt-test
git add src/routes/admin.js src/routes/routes.js src/routes/search.js src/utils/interceptors.js src/discord-commands.js
git commit -m "Migrate remaining systems/fleets/plans call sites to the repository layer"
```

---

### Task 8: Full regression pass and close out the domain

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /root/awt-test && npm test`
Expected: all existing `*.test.js` files pass (including the three new repository smoke tests),
exit code 0.

- [ ] **Step 2: Confirm zero remaining raw call sites for this domain, codebase-wide**

Run:
```bash
cd /root/awt-test && grep -rn "db\.prepare\|db\.exec" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js" | grep -iE "FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)\b|INTO (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)\b|DELETE FROM (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)\b|UPDATE (systems|planets|fleets|planet_events|planet_takeovers|planet_plans)\b"
```
Expected: no output. If anything remains, add a Step here migrating it before continuing —
don't leave a known stray call site for a "later cleanup."

- [ ] **Step 3: Final end-to-end pass on `awt-test`**

Run: `pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 30 --nostream`
Expected: clean boot, no errors. Spend a few minutes clicking through the hub's main pages
(dashboard, galaxy archive, a system page, War Room, route planner) and the `!sys`/`!plan`
Discord commands one more time, now that every call site for this domain has moved.

- [ ] **Step 4: Update the spec's status note**

This isn't a code change — just confirm in your own tracking (or the next domain's plan intro)
that the systems/fleets/plans domain is done, so the next plan (players) starts from a known-good
state. No commit needed for this step.
