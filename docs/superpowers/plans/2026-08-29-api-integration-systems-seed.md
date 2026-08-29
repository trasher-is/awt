# Systems Seed (Phase 1 of Game API Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the game's `Map/sectors` and `SolarSystem` (bulk list) REST API endpoints so the hub can seed/refresh its systems and planets tables in bulk, instead of relying only on scraping one system at a time.

**Architecture:** Two independent data sources feed the same `systems`/`planets` tables through existing, already-tested write paths — `SolarSystem` (the plain list, no bounds needed) supplies system metadata via the existing `/sync/galaxy` route; `Map/sectors` (bounded by area) supplies bulk planet data by being fanned out, one system at a time, through the existing `/sync/system` route — reusing its battle-tested fog-of-war/owner-change/pop-drop logic rather than duplicating it. Both routes gain small, additive, backward-compatible extensions (new optional fields); no existing caller's behavior changes.

**Tech Stack:** Node.js, Express, better-sqlite3, plain browser JS (no framework) for `public/js/*`.

**Spec:** `docs/superpowers/specs/2026-08-29-game-api-integration-design.md` (section "1. Systems — `Map/sectors` seed")

## Global Constraints

- **No behavior change for existing callers.** Every schema/function/route change in this
  plan is additive (new nullable columns, new optional trailing function parameters, new
  optional payload fields). An existing caller that doesn't know about the new fields must
  behave exactly as it does today.
- **Reuse `/sync/system`'s existing fog-of-war logic — do not duplicate it.** The bulk
  planet seed from `Map/sectors` must go through the exact same merge transaction that
  scraping already uses (owner-change/pop-drop event logging, the "unknown owner" and
  "soft-unknown" guards). A system reported `isInVision: false` by `Map/sectors` is treated
  exactly like a DOM scraper reporting `is_unknown: true` for every one of its planets —
  same code path, same guards, no new merge logic.
- **`planets.name`, once set, must never be nulled out by a caller that doesn't know it.**
  Scraping never sends a planet name; the merge must preserve whatever name is already
  stored when the incoming payload's `name` is absent, via `COALESCE(excluded.name,
  planets.name)` — never a blind overwrite.
- **`systems.full_name`/`info`/`population_level` only ever come from one source** (the
  `SolarSystem` list endpoint) — there is exactly one caller of `upsertSystemFull` in the
  whole codebase (`src/routes/sync.js`'s `/sync/galaxy` route), so extending its SQL to
  always write these three columns is safe: no other caller exists that would send
  incomplete data and accidentally null them out.
- **The seed is safely re-runnable, not a strict one-time action.** The map grows in a
  (somewhat random) spiral as the round progresses; both the galaxy-index pull and the
  sectors pull must be idempotent upserts, callable again later to pick up newly-created
  regions.

## File Structure

- Modify: `src/database.js` — add `systems.full_name`/`info`/`population_level`/
  `is_in_vision` and `planets.name` columns.
- Modify: `src/repositories/systems.js` — extend `upsertSystemFull`, add
  `setSystemInVision`, extend `upsertPlanet`.
- Modify: `src/repositories/systems.test.js` — cover the extended/new functions.
- Modify: `src/routes/sync.js` — extend `/sync/galaxy`'s payload/upsert call; extend
  `/sync/system`'s merge transaction to pass `name` through; add a new
  `/sync/system-in-vision` route.
- Modify: `public/js/utils/aw-api.js` — add `getMapSectors`; extend
  `mapPlanetsToSyncPayload` to carry `name`.
- Modify: `public/js/utils/aw-api.test.js` — cover the `name` field.
- Modify: `public/js/ui/galaxy-map.js` — extend `seedFromApi` to also send system metadata;
  add a new `seedPlanetsFromSectors` action wired to a new button.

---

### Task 1: Schema — new columns

**Files:**
- Modify: `src/database.js:183` (right after the `planets` table's closing `` `); ``, before
  the `// 4.5 Alliance Meta-Data (Planning)` comment)

**Interfaces:**
- Produces: `systems.full_name` (TEXT), `systems.info` (TEXT), `systems.population_level`
  (INTEGER), `systems.is_in_vision` (INTEGER), `planets.name` (TEXT) — all nullable, all
  consumed by Task 2's repository functions.

- [ ] **Step 1: Add the migration calls**

Insert this block immediately after line 183 (the planets table's closing `` `); ``):

```js
    addColumn('systems', 'full_name', 'TEXT');
    addColumn('systems', 'info', 'TEXT');
    addColumn('systems', 'population_level', 'INTEGER');
    addColumn('systems', 'is_in_vision', 'INTEGER');
    addColumn('planets', 'name', 'TEXT');
```

- [ ] **Step 2: Verify the migration runs cleanly**

Run: `node -e "require('./src/database.js')"` from the repo root (or delete/rename a scratch
copy of `awt.db` first if testing against a real file — do NOT touch the real `awt.db`;
better to just run `AWT_DB_PATH=/tmp/migration-check.db node -e "require('./src/database.js')"`
and inspect the output).

Expected: five `[DB] Added <column> column to <table> table.` log lines, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/database.js
git commit -m "Add systems full_name/info/population_level/is_in_vision and planets.name columns"
```

---

### Task 2: Extend `src/repositories/systems.js`

**Files:**
- Modify: `src/repositories/systems.js`
- Modify: `src/repositories/systems.test.js`

**Interfaces:**
- Consumes: the 5 new columns from Task 1.
- Produces: `upsertSystemFull(id, name, x, y, fullName, info, populationLevel)` (extended
  signature, 3 new optional trailing params, all defaulting to `null`), `setSystemInVision(id,
  isInVision)` (new), `upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population,
  starbase, hasFleet, isSieged, name)` (extended signature, 1 new optional trailing param
  defaulting to `null`). All three consumed by Task 3.

- [ ] **Step 1: Write the failing/updated tests first**

In `src/repositories/systems.test.js`, add these lines right after the existing
`upsertSystemFull`/`getSystemCoords` block (after the line `ok('countSystems is 1 after
upsert', systems.countSystems() === 1);`):

```js
systems.upsertSystemFull(3, 'Ceginus', 5, -5, 'Ceginus Prime', 'A quiet frontier system', 42);
const detailed = systems.getFullSystem(3);
ok('upsertSystemFull stores full_name', detailed.full_name === 'Ceginus Prime');
ok('upsertSystemFull stores info', detailed.info === 'A quiet frontier system');
ok('upsertSystemFull stores population_level', detailed.population_level === 42);

ok('setSystemInVision defaults to null (unknown) before any call', systems.getFullSystem(3).is_in_vision == null);
systems.setSystemInVision(3, true);
ok('setSystemInVision(true) stores 1', systems.getFullSystem(3).is_in_vision === 1);
systems.setSystemInVision(3, false);
ok('setSystemInVision(false) stores 0', systems.getFullSystem(3).is_in_vision === 0);
```

And add these lines right after the existing `upsertPlanet`/`getSystemPlanetsWithIntel`
block (after `ok('countPlanets is 1', systems.countPlanets() === 1);`). `systems.js` has no
"get one planet by id" function, so these assertions query directly via `db` (add `const db
= require('../database');` once, near the top of the test file alongside the other
requires):

```js
systems.upsertPlanet(501, 1, 2, null, 500, 1, 0, 0, 'Named Planet');
const namedPlanet = db.prepare('SELECT name FROM planets WHERE system_id = 1 AND planet_index = 2').get();
ok('upsertPlanet with a name stores it', namedPlanet.name === 'Named Planet');

systems.upsertPlanet(501, 1, 2, null, 500, 1, 0, 0); // no name arg this time
const afterNoNameCall = db.prepare('SELECT name FROM planets WHERE system_id = 1 AND planet_index = 2').get();
ok('a later call with no name preserves the previously-stored name', afterNoNameCall.name === 'Named Planet');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node src/repositories/systems.test.js`
Expected: FAIL — `full_name`/`info`/`population_level`/`is_in_vision` are `undefined` (not
yet written), `setSystemInVision is not a function`, and the planet-name assertions fail
since `upsertPlanet` doesn't accept/store a name yet.

- [ ] **Step 3: Implement — extend `upsertSystemFull`**

Before (`src/repositories/systems.js:110-120`):
```js
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
```
After:
```js
const upsertSystemFullStmt = db.prepare(`
    INSERT INTO systems (id, name, x, y, full_name, info, population_level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        x=excluded.x,
        y=excluded.y,
        full_name=excluded.full_name,
        info=excluded.info,
        population_level=excluded.population_level,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertSystemFull(id, name, x, y, fullName = null, info = null, populationLevel = null) {
    upsertSystemFullStmt.run(id, name, x, y, fullName, info, populationLevel);
}
```

- [ ] **Step 4: Implement — add `setSystemInVision`**

Add immediately after the `upsertSystemFull` function:
```js
const setSystemInVisionStmt = db.prepare(`UPDATE systems SET is_in_vision = ? WHERE id = ?`);
function setSystemInVision(id, isInVision) {
    setSystemInVisionStmt.run(isInVision ? 1 : 0, id);
}
```

- [ ] **Step 5: Implement — extend `upsertPlanet`**

Before (`src/repositories/systems.js:244-258`):
```js
const upsertPlanetStmt = db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet, is_sieged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        game_planet_id=excluded.game_planet_id,
        owner_id=excluded.owner_id,
        population=excluded.population,
        starbase=excluded.starbase,
        has_fleet=excluded.has_fleet,
        is_sieged=excluded.is_sieged,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet, isSieged) {
    upsertPlanetStmt.run(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet, isSieged);
}
```
After:
```js
const upsertPlanetStmt = db.prepare(`
    INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, has_fleet, is_sieged, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(system_id, planet_index) DO UPDATE SET
        game_planet_id=excluded.game_planet_id,
        owner_id=excluded.owner_id,
        population=excluded.population,
        starbase=excluded.starbase,
        has_fleet=excluded.has_fleet,
        is_sieged=excluded.is_sieged,
        name=COALESCE(excluded.name, planets.name),
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlanet(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet, isSieged, name = null) {
    upsertPlanetStmt.run(gamePlanetId, systemId, planetIndex, ownerId, population, starbase, hasFleet, isSieged, name);
}
```

- [ ] **Step 6: Update `module.exports`**

Add `setSystemInVision` to the `module.exports` list at the bottom of the file (the
existing `upsertSystemFull`/`upsertPlanet` entries already cover the extended functions —
same names, no export-list change needed for those two).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node src/repositories/systems.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `npm test` (from repo root)
Expected: all suites pass, including `repositories/systems.test.js`.

- [ ] **Step 9: Commit**

```bash
git add src/repositories/systems.js src/repositories/systems.test.js
git commit -m "Extend systems repository: system metadata, is_in_vision, planet names"
```

---

### Task 3: Extend `/sync/galaxy` (system metadata) and `/sync/system` (planet names)

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `systemsRepo.upsertSystemFull(id, name, x, y, fullName, info, populationLevel)`,
  `systemsRepo.upsertPlanet(...9 args, name)` from Task 2.
- Produces: `/sync/galaxy` now accepts an optional `full_name`/`info`/`population_level` per
  system in its `systems[]` array; `/sync/system` now accepts an optional `name` per planet
  in its `planets[]` array. Both consumed by Task 4/6 (the client-side callers).

- [ ] **Step 1: Extend `/sync/galaxy`'s upsert call**

Before (`src/routes/sync.js:379`):
```js
            systemsRepo.upsertSystemFull(s.id, typeof s.name === 'string' ? s.name : null, x, y);
```
After:
```js
            systemsRepo.upsertSystemFull(
                s.id,
                typeof s.name === 'string' ? s.name : null,
                x, y,
                typeof s.full_name === 'string' ? s.full_name : null,
                typeof s.info === 'string' ? s.info : null,
                Number.isInteger(s.population_level) ? s.population_level : null
            );
```

- [ ] **Step 2: Pass `name` through in `/sync/system`'s merge transaction**

Before (`src/routes/sync.js:136`):
```js
            systemsRepo.upsertPlanet(p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation, finalStarbase, finalHasFleet, finalIsSieged);
```
After:
```js
            systemsRepo.upsertPlanet(
                p.game_planet_id, system_id, p.planet_index, finalOwnerId, finalPopulation,
                finalStarbase, finalHasFleet, finalIsSieged,
                typeof p.name === 'string' ? p.name : null
            );
```

- [ ] **Step 3: Add a new `/sync/system-in-vision` route**

Add this new route right after the existing `/sync/galaxy` route (after its closing `});`,
before the `// --- RANKING: BEST GUARDED DATA INGESTION SYNC LAYER ---` comment):

```js
// --- SYSTEM VISIBILITY FLAG RECEIVER ---
// Map/sectors reports isInVision per system: whether the returned planet data is live or
// the game's last-known cache for territory outside anyone's current vision. This is
// purely a staleness signal for later UI use — it does not affect the fog-of-war merge in
// /sync/system (the client marks affected planets is_unknown before calling that route);
// this route only records the flag itself for display.
router.post('/sync/system-in-vision', requireAuth, (req, res) => {
    const { systems } = req.body;
    if (!Array.isArray(systems) || systems.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let updated = 0;
    for (const s of systems) {
        if (!Number.isInteger(s.id) || s.id <= 0) continue;
        systemsRepo.setSystemInVision(s.id, !!s.is_in_vision);
        updated++;
    }
    res.json({ success: true, updated });
});
```

- [ ] **Step 4: Manual verification**

Since this route has no dedicated test file today (confirmed: no `sync.test.js` exists;
`/sync/galaxy` and `/sync/system` are covered indirectly by `aw-api.test.js`'s mapper tests
and `request-hygiene.test.js`'s auth-guard scan), verify manually:

```bash
node -e "
const http = require('http');
require('./src/database.js'); // ensure schema exists
console.log('sync.js loads without syntax errors:', !!require('./src/routes/sync.js'));
"
```
Expected: prints `sync.js loads without syntax errors: true`, no thrown errors.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass — in particular `utils/request-hygiene.test.js` (which scans
`/sync/*` routes for the `requireAuth` guard) must still pass, since the new route
correctly includes `requireAuth`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/sync.js
git commit -m "Extend /sync/galaxy and /sync/system for API-sourced metadata, add /sync/system-in-vision"
```

---

### Task 4: Extend `public/js/utils/aw-api.js` — `getMapSectors` and planet names

**Files:**
- Modify: `public/js/utils/aw-api.js`
- Modify: `public/js/utils/aw-api.test.js`

**Interfaces:**
- Produces: `getMapSectors({x1, y1, x2, y2})` (new, returns the raw `{ok, data}` shape like
  every other `aw-api.js` function — `data` is the array of sector objects), extended
  `mapPlanetsToSyncPayload` (each mapped planet now also carries `name: p.name ?? null`).
  Both consumed by Task 5 (`galaxy-map.js`).

- [ ] **Step 1: Write the failing test**

Add to `public/js/utils/aw-api.test.js`, right after the existing
`mapPlanetsToSyncPayload` test block (after the `degenerate` assertions, before whatever
comes next):

```js
console.log('\n── getMapSectors: builds the right query string ' + '─'.repeat(28));
calls.length = 0;
const sectorsRes = await AWApi.getMapSectors({ x1: -30, y1: -30, x2: 30, y2: 30 });
ok('getMapSectors resolves ok', sectorsRes.ok === true, sectorsRes);
ok('the request path carries all four bounds', /\/api\/v1\/Map\/sectors\?/.test(calls[0].path)
    && /x1=-30/.test(calls[0].path) && /y1=-30/.test(calls[0].path)
    && /x2=30/.test(calls[0].path) && /y2=30/.test(calls[0].path), calls[0].path);

console.log('\n── mapPlanetsToSyncPayload also carries planet name ' + '─'.repeat(23));
const withName = AWApi.mapPlanetsToSyncPayload('1', [
    { id: 1, index: 1, name: 'Rana', ownerId: null, ownerName: null, allianceId: null,
      allianceTag: null, populationLevel: 0, starbaseLevel: 0, isUnknownOwner: false,
      hasSiege: false, starbaseOrders: [] },
]);
ok('name is carried through to the mapped planet', withName.planets[0].name === 'Rana', withName.planets[0]);
```

Check how the existing test file's `calls`/fake-network setup works (read the top of
`public/js/utils/aw-api.test.js` before writing this — it already has a `calls` array and a
fetch override from the earlier tests in the same file; reuse that exact same harness,
don't invent a new one).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node src/utils/aw-api.test.js`
Expected: FAIL — `AWApi.getMapSectors is not a function`, and `withName.planets[0].name` is
`undefined`.

- [ ] **Step 3: Implement `getMapSectors`**

Add immediately after `getSystemPlanets` (`public/js/utils/aw-api.js:129-131`):
```js
    // A rectangular area of the map: [{id, rectangle, alliances, players, solarSystems}].
    // Each solarSystems[] entry additionally carries {capturedAt, format, isInVision,
    // planets[]} on top of the base SolarSystem shape.
    function getMapSectors({ x1, y1, x2, y2 } = {}) {
        return requestJson('/api/v1/Map/sectors' + query({ x1, y1, x2, y2 }));
    }
```

- [ ] **Step 4: Implement the `name` field in `mapPlanetsToSyncPayload`**

Before (`public/js/utils/aw-api.js:174-190`):
```js
            .map(p => ({
                game_planet_id: p.id,
                planet_index: p.index,
                population: p.populationLevel,
                starbase: p.starbaseLevel,
                owner: p.ownerId != null
```
After (add one line, `name`, right after `planet_index`):
```js
            .map(p => ({
                game_planet_id: p.id,
                planet_index: p.index,
                name: typeof p.name === 'string' ? p.name : null,
                population: p.populationLevel,
                starbase: p.starbaseLevel,
                owner: p.ownerId != null
```

- [ ] **Step 5: Update the exported functions list**

Before (`public/js/utils/aw-api.js:194-199`):
```js
    return {
        getSolarSystems, getSolarSystem, getSystemPlanets,
        getTravelTime, searchBattleReports, putOrderGeometry,
        mapPlanetsToSyncPayload,
        _setFetch,
    };
```
After:
```js
    return {
        getSolarSystems, getSolarSystem, getSystemPlanets, getMapSectors,
        getTravelTime, searchBattleReports, putOrderGeometry,
        mapPlanetsToSyncPayload,
        _setFetch,
    };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node src/utils/aw-api.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 8: Commit**

```bash
git add public/js/utils/aw-api.js public/js/utils/aw-api.test.js
git commit -m "Add getMapSectors and carry planet name through mapPlanetsToSyncPayload"
```

---

### Task 5: `galaxy-map.js` — extend the galaxy-index seed, add the sectors planet seed

**Files:**
- Modify: `public/js/ui/galaxy-map.js`

**Interfaces:**
- Consumes: `AWApi.getSolarSystems()` (existing), `AWApi.getMapSectors({x1,y1,x2,y2})`
  (Task 4), `AWApi.mapPlanetsToSyncPayload(systemId, planets)` (Task 4, extended),
  `/hub-api/sync/galaxy` (Task 3, extended), `/hub-api/sync/system` (Task 3, extended),
  `/hub-api/sync/system-in-vision` (Task 3, new).

This task has no automated test (this file has none today — it's DOM/browser-only UI code,
consistent with the rest of `public/js/ui/*.js`). Verify manually per Step 4 below.

- [ ] **Step 1: Extend `seedFromApi` to also send system metadata**

Before (`public/js/ui/galaxy-map.js:665-667`):
```js
        const systems = (Array.isArray(res.data) ? res.data : [])
            .filter(s => s && s.x != null && s.y != null)
            .map(s => ({ id: s.id, name: s.name, x: s.x, y: s.y }));
```
After:
```js
        const systems = (Array.isArray(res.data) ? res.data : [])
            .filter(s => s && s.x != null && s.y != null)
            .map(s => ({
                id: s.id, name: s.name, x: s.x, y: s.y,
                full_name: typeof s.fullName === 'string' ? s.fullName : null,
                info: typeof s.info === 'string' ? s.info : null,
                population_level: Number.isInteger(s.populationLevel) ? s.populationLevel : null,
            }));
```

- [ ] **Step 2: Add the sectors-based planet seed function**

Add this new function immediately after `seedFromApi` (after its closing `}` on the line
before `// ─── SETUP ───────────────────────────────────────────────────────────────────`):

```js
// Seeds planets in bulk from Map/sectors, one system at a time, through the EXISTING
// /hub-api/sync/system endpoint — same fog-of-war/owner-change/pop-drop logic a live scrape
// already goes through, just driven from a bulk API response instead of one page. A system
// the API marks isInVision:false gets every one of its planets marked is_unknown so the
// merge preserves whatever was last actually seen there, exactly like a DOM scraper would.
let seedingSectors = false;
const SECTOR_BOUNDS = { x1: -40, y1: -40, x2: 40, y2: 40 }; // known map bounds ~-32..32, padded

async function seedPlanetsFromSectors() {
    if (seedingSectors) return;
    seedingSectors = true;
    const button = document.getElementById('gm-seed-sectors');
    if (button) button.disabled = true;
    const status = document.getElementById('gm-status');
    const say = (msg) => { if (status) { status.classList.remove('hidden'); status.textContent = msg; } };
    try {
        say('Asking the game for the map sectors…');
        const res = await AWApi.getMapSectors(SECTOR_BOUNDS);
        if (!res.ok) {
            say(res.reason === 'session'
                ? 'Seeding needs your game session — log into the game first, then try again.'
                : `The game API did not answer (${res.reason}${res.status ? `, HTTP ${res.status}` : ''}).`);
            return;
        }
        const sectors = Array.isArray(res.data) ? res.data : [];
        const allSystems = sectors.flatMap(sec => Array.isArray(sec.solarSystems) ? sec.solarSystems : []);
        if (!allSystems.length) {
            say('The game returned no systems in that area — nothing to seed.');
            return;
        }

        let systemsProcessed = 0;
        let planetsProcessed = 0;
        const visionFlags = [];
        for (const sys of allSystems) {
            if (!sys || !Number.isInteger(sys.id)) continue;
            const isInVision = !!sys.isInVision;
            visionFlags.push({ id: sys.id, is_in_vision: isInVision });

            const planets = Array.isArray(sys.planets) ? sys.planets : [];
            const payload = AWApi.mapPlanetsToSyncPayload(sys.id, planets);
            if (!isInVision) {
                // Out-of-vision: the game's cache may be stale, so route every planet
                // through the SAME "unknown" guard a live scraper uses for fog of war.
                payload.planets = payload.planets.map(p => ({ ...p, is_unknown: true }));
            }
            if (!payload.planets.length) continue;

            const syncRes = await fetch('/hub-api/sync/system', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (syncRes.ok) {
                systemsProcessed++;
                planetsProcessed += payload.planets.length;
            }
            say(`Seeding planets… ${systemsProcessed}/${allSystems.length} systems (${planetsProcessed} planets)`);
        }

        if (visionFlags.length) {
            await fetch('/hub-api/sync/system-in-vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ systems: visionFlags }),
            });
        }

        if (typeof window.showToast === 'function') {
            window.showToast(`Seeded ${planetsProcessed} planets across ${systemsProcessed} systems`);
        }
        await loadData();
    } catch (err) {
        console.error('[GalaxyMap] Sector seed failed:', err);
        say(`Sector seed failed: ${err.message}`);
    } finally {
        seedingSectors = false;
        if (button) button.disabled = false;
    }
}
```

- [ ] **Step 3: Wire up a button for the new action**

Before (`public/js/ui/galaxy-map.js:751`):
```js
    document.getElementById('gm-seed-api')?.addEventListener('click', seedFromApi);
```
After (add the new listener right after the existing one):
```js
    document.getElementById('gm-seed-api')?.addEventListener('click', seedFromApi);
    document.getElementById('gm-seed-sectors')?.addEventListener('click', seedPlanetsFromSectors);
```

Find the existing `gm-seed-api` button's HTML (search this file for `id="gm-seed-api"` — it
is defined near line 618-ish alongside the `.gm-seed-inline` button markup, in a template
string). Add a sibling button with `id="gm-seed-sectors"` right next to it, matching the
existing button's classes/styling exactly (copy the class list verbatim from the
`gm-seed-api` button), with label text `"Seed planets (sectors)"`.

- [ ] **Step 4: Manual verification**

This requires a real logged-in game session to test end-to-end (the game API only responds
to an authenticated proxy request), so full verification happens on `awt-test` with a real
member account, not in an automated test:

1. Deploy to `awt-test`, open the galaxy map panel, click "Seed from API" (existing button)
   — confirm the map now shows `full_name`/`info`/`population_level` somewhere reachable
   (even if not yet rendered in the UI, confirm via `sqlite3 awt-test/awt.db "SELECT id,
   full_name, info, population_level FROM systems LIMIT 5"` that the columns are populated).
2. Click the new "Seed planets (sectors)" button — confirm the status line shows progress,
   confirm via `sqlite3 awt-test/awt.db "SELECT id, name FROM planets WHERE name IS NOT NULL
   LIMIT 5"` that planet names appear, and `sqlite3 awt-test/awt.db "SELECT id, is_in_vision
   FROM systems WHERE is_in_vision IS NOT NULL LIMIT 5"` that vision flags appear.
3. Confirm re-clicking either button doesn't error or duplicate rows (re-run the same
   `SELECT COUNT(*)` before/after a second click — count should be stable, not doubled).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass (this task touches no server-side test-covered code, but this
confirms Tasks 1-4 are still intact).

- [ ] **Step 6: Commit**

```bash
git add public/js/ui/galaxy-map.js
git commit -m "Add sectors-based bulk planet seed to the galaxy map panel"
```

---

## Self-Review Notes (completed during writing, not a separate pass)

- **Spec coverage:** every element of spec section "1. Systems — `Map/sectors` seed" is
  covered: the padded-bounds single call (Task 5, `SECTOR_BOUNDS`), idempotent/re-runnable
  upserts (Tasks 2-3, all `ON CONFLICT` upserts), reuse of `/sync/system`'s existing
  fog-of-war logic instead of new merge logic (Task 5), the `full_name`/`info`/
  `population_level`/`is_in_vision`/`planets.name` columns (Task 1), and explicitly no
  `starbase_orders` column (never added anywhere in this plan) and no `is_unknown_owner`
  column (the merge reuses the existing transient `is_unknown` payload field instead,
  confirmed in Task 3/5).
- **Type consistency check:** `upsertSystemFull`'s new parameter names
  (`fullName`/`info`/`populationLevel`) match what Task 3's route code destructures
  (`s.full_name`/`s.info`/`s.population_level` — the DB/repo-layer convention throughout
  this codebase is snake_case at the HTTP/DB boundary, camelCase as JS function parameter
  names, matching every other repository in `src/repositories/`). `upsertPlanet`'s new
  `name` parameter matches `p.name` in the route and `payload.planets[].name` from the
  client mapper. `setSystemInVision(id, isInVision)` matches the call site in Task 3's new
  route (`systemsRepo.setSystemInVision(s.id, !!s.is_in_vision)`).
