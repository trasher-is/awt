# Players (Phase 3 of Game API Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up `Player` (bulk list), `Player/{id}` (detail), and `Player/search`, layered on top of — never replacing — the existing deep profile-scrape, plus a within-round player-name-history table the game's mid-round restart mechanic requires.

**Architecture:** Two new, narrowly-scoped upsert paths (`upsertPlayerFromApiList`, `upsertPlayerFromApiDetail`) sit alongside the existing scrape-driven `upsertPlayerFull` — neither touches the scrape-only columns (`home_planet_id`, `total_farms`, etc.) the API has no data for, and the detail path reuses the exact `has_intel`-gated CASE-guard pattern `upsertPlayerFull` already uses for intel-derived columns, rather than inventing a new merge rule. A background module (mirroring the existing `battle-sync.js`) drives a decaying-cadence `ListPlayer` pull and a staleness-ordered `Player/{id}` sweep; a manual "search live" fallback extends Plan 2's existing pattern to player search.

**Tech Stack:** Node.js, Express, better-sqlite3, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-08-29-game-api-integration-design.md` (section "3. Players")

## Global Constraints

- **No behavior change for existing callers.** `upsertPlayerFull`, `upsertPlayerBasic`,
  `resetPlayerOnRestart`, and every other existing `players` repository function are
  untouched by this plan. New API-sourced writes go through two brand-new, dedicated
  functions.
- **The API-detail upsert must NOT touch scrape-only columns.** `home_planet_id`,
  `home_system_id`, `home_planet_index`, `possible_homes`, `total_planets`,
  `total_population`, `total_farms`, `total_factories`, `total_labs`, `total_cybernetics`,
  `cv_used`, `cv_limit`, `idle_time`, and `eco_bonus` never appear in
  `upsertPlayerFromApiDetail`'s column list at all — not even a COALESCE — because the API
  has no data for them and a bulk API-driven upsert must never risk overwriting them.
- **Intel-preservation reuses the existing `has_intel` CASE-guard pattern, verbatim in
  spirit.** `upsertPlayerFromApiDetail` gates `biology`/`economy`/`energy`/`mathematics`/
  `physics`/`social`/`trade_revenue`/`artefact`/`race_*` behind `has_intel` exactly like
  `upsertPlayerFullStmt` already does (`src/repositories/players.js:163-215`) — the API's
  `intelligenceReport` presence maps to `has_intel = 1`, its absence to `has_intel = 0`
  (preserve). This is the SAME statement pattern, a separate prepared statement, not a
  shared one — do not attempt to merge the two upserts.
- **`joined` and `logins` are simple overwrite-with-API-value, no gap-fill needed.** Per
  the spec's Schema correction: a join date never changes and a login count only ever
  climbs, so the API's value (when present) is always at least as good as what's stored —
  a straight overwrite is correct, not a COALESCE.
- **Name-history hook lives in the route/caller, not inside the upsert SQL.** Exactly like
  the existing restart-detection logic already lives in `/sync/player`'s route body (not
  inside `upsertPlayerFull`'s SQL), the new `player_name_history` write happens as a
  pre-upsert check in each route that touches `players.name` — the scrape path
  (`/sync/player`, existing) AND both new API paths. Do not modify `upsertPlayerFull`'s
  SQL or its callers' existing behavior to add this.
- **The distributed-claim mechanism is a pragmatic simplification of the spec's design.**
  Rather than a separate claims table with a TTL, "claiming" a batch of stale players is a
  single `last_api_scan_at` timestamp bump at claim time (an optimistic claim) — if a
  browser fails to actually report results, that player simply waits one full staleness
  cycle before being offered again. This satisfies the spec's intent (avoid two members'
  browsers redundantly re-scanning the same player in the same short window) at much lower
  complexity than a dedicated claims table, and is a deliberate, documented trade-off — not
  a shortfall to fix later.
- **The per-account background-call budget ceiling is a hardcoded constant for this
  landing, not wired to `app_settings` yet.** The spec calls for it to be tunable via
  settings; building a new non-admin-gated settings-read endpoint for one number is more
  machinery than this phase's value justifies. Documented as a deliberate scope trim, not
  an oversight — flagged in a code comment at the constant's definition.

## File Structure

- Modify: `src/database.js` — new `players` columns, new `player_name_history` table.
- Modify: `src/repositories/players.js` — name-history helpers, `upsertPlayerFromApiList`,
  `upsertPlayerFromApiDetail`, `getStalePlayerIdsForApiScan`, `markPlayersApiScanned`.
- Modify: `src/repositories/players.test.js` — cover all new functions.
- Modify: `public/js/utils/aw-api.js` — `getPlayers`, `getPlayer`, `searchPlayers`.
- Modify: `src/utils/aw-api.test.js` — cover the 3 new functions.
- Modify: `src/routes/sync.js` — `GET /sync/player-scan-claim`, `POST /sync/player-list`,
  `POST /sync/player-detail`, `GET /round-age`; add the name-history hook to the existing
  `/sync/player` route.
- Create: `public/js/ui/player-api-sync.js` — the background `ListPlayer`/`Player/{id}`
  sync module (mirrors `battle-sync.js`).
- Modify: `public/js/ui/dashboard.js` — start the new background module.
- Modify: `public/js/ui/search.js` — extend the manual "search live" fallback to player
  search.

---

### Task 1: Schema — new player columns and `player_name_history`

**Files:**
- Modify: `src/database.js`

**Interfaces:**
- Produces: `players.is_active_player` (INTEGER), `players.last_activity_at` (DATETIME),
  `players.last_login_at` (DATETIME), `players.resigned_at` (DATETIME),
  `players.number_of_battles` (INTEGER), `players.battle_luckiness` (REAL),
  `players.multi_status` (TEXT), `players.is_top_permanent_ranker` (INTEGER),
  `players.has_supporter_badge` (INTEGER), `players.supporter_type` (TEXT),
  `players.last_api_scan_at` (DATETIME) — all nullable, all consumed by Task 2. New table
  `player_name_history` consumed by Task 2.

- [ ] **Step 1: Add the player column migrations**

Find where `addColumn('players', ...)` calls already exist in `src/database.js` (around
lines 119-133) and add these 11 new calls to the SAME block, right after the existing
`addColumn('players', 'possible_homes', 'TEXT');` line:

```js
    addColumn('players', 'is_active_player', 'INTEGER');
    addColumn('players', 'last_activity_at', 'DATETIME');
    addColumn('players', 'last_login_at', 'DATETIME');
    addColumn('players', 'resigned_at', 'DATETIME');
    addColumn('players', 'number_of_battles', 'INTEGER');
    addColumn('players', 'battle_luckiness', 'REAL');
    addColumn('players', 'multi_status', 'TEXT');
    addColumn('players', 'is_top_permanent_ranker', 'INTEGER');
    addColumn('players', 'has_supporter_badge', 'INTEGER');
    addColumn('players', 'supporter_type', 'TEXT');
    addColumn('players', 'last_api_scan_at', 'DATETIME');
```

- [ ] **Step 2: Add the `player_name_history` table**

Find the `CREATE TABLE IF NOT EXISTS players (...)` block's closing `` `); `` in
`src/database.js` and add this new table right after it (before whatever table comes
next):

```js
    db.exec(`
        CREATE TABLE IF NOT EXISTS player_name_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            old_name TEXT NOT NULL,
            changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
        )
    `);
```

- [ ] **Step 3: Verify the migration runs cleanly**

Run: `AWT_DB_PATH=/tmp/players-migration-check.db node -e "require('./src/database.js')"`
Expected: 11 `[DB] Added <column> column to players table.` log lines plus the schema
completing with no errors. Do NOT run against the real `awt.db`.

- [ ] **Step 4: Commit**

```bash
git add src/database.js
git commit -m "Add player API-integration columns and player_name_history table"
```

---

### Task 2: Extend `src/repositories/players.js`

**Files:**
- Modify: `src/repositories/players.js`
- Modify: `src/repositories/players.test.js`

**Interfaces:**
- Consumes: the columns/table from Task 1.
- Produces: `getPlayerName(id)` (new, returns `{name}` or `undefined`), `recordNameChange(playerId,
  oldName)` (new), `upsertPlayerFromApiList(id, name, allianceId, level, points, ranking,
  country, isActivePlayer, joined)` (new), `upsertPlayerFromApiDetail(player)` (new,
  named-parameter object like `upsertPlayerFull`), `getStalePlayerIdsForApiScan(limit)`
  (new, returns an array of ids), `markPlayersApiScanned(ids)` (new, variable-arity). All
  six consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `src/repositories/players.test.js` (match its existing `ok()`/`AWT_DB_PATH` style —
read the file's existing test blocks first to match conventions, e.g. how it seeds a
minimal player row):

```js
ok('getPlayerName returns undefined for an unknown id', players.getPlayerName(999999) === undefined);

players.upsertPlayerBasic(701, 'Original Name', null);
const before = players.getPlayerName(701);
ok('getPlayerName finds an existing player', before && before.name === 'Original Name', before);

players.recordNameChange(701, before.name);
// (verify via a direct query since there's no getter for this yet — that's fine, the
// route layer in Task 4 is the real consumer; a raw check here just confirms the write)
const db = require('../database');
const historyRow = db.prepare('SELECT old_name FROM player_name_history WHERE player_id = ?').get(701);
ok('recordNameChange writes the old name', historyRow.old_name === 'Original Name', historyRow);

players.upsertPlayerFromApiList(701, 'New From List', null, 42, 5000, 3, 'US', 1, '2026-08-01T00:00:00Z');
const afterList = players.getPlayerFullById(701);
ok('upsertPlayerFromApiList updates name/level/points/ranking/country/is_active_player/joined', 
    afterList.name === 'New From List' && afterList.level === 42 && afterList.points === 5000
    && afterList.ranking === 3 && afterList.country === 'US' && afterList.is_active_player === 1
    && afterList.joined === '2026-08-01T00:00:00Z', afterList);
ok('upsertPlayerFromApiList does not touch home_planet_id (never in its column list)', afterList.home_planet_id === null, afterList);

players.upsertPlayerFromApiDetail({
    id: 701, name: 'Detail Name', alliance_id: null, level: 50, points: 6000, ranking: 2,
    country: 'US', is_active_player: 1, joined: '2026-08-01T00:00:00Z', logins: 12,
    last_activity_at: '2026-08-29T10:00:00Z', last_login_at: '2026-08-29T09:00:00Z',
    resigned_at: null, number_of_battles: 4, battle_luckiness: 0.1, multi_status: 'clean',
    is_top_permanent_ranker: 0, has_supporter_badge: 1, supporter_type: 'gold',
    has_intel: 0, biology: 99, economy: 99, energy: 99, mathematics: 99, physics: 99, social: 99,
    trade_revenue: 99, artefact: 'fake',
    race_growth: 99, race_science: 99, race_culture: 99, race_production: 99, race_speed: 99,
    race_attack: 99, race_defense: 99, race_trader: 99, race_sul: 99,
});
const afterDetailNoIntel = players.getPlayerFullById(701);
ok('upsertPlayerFromApiDetail with has_intel=0 writes activity/status fields', 
    afterDetailNoIntel.last_activity_at === '2026-08-29T10:00:00Z' && afterDetailNoIntel.number_of_battles === 4
    && afterDetailNoIntel.has_supporter_badge === 1 && afterDetailNoIntel.supporter_type === 'gold', afterDetailNoIntel);
ok('upsertPlayerFromApiDetail with has_intel=0 does NOT overwrite intel columns (still null/unset from before)', 
    afterDetailNoIntel.biology !== 99, afterDetailNoIntel);

players.upsertPlayerFromApiDetail({
    id: 701, name: 'Detail Name 2', alliance_id: null, level: 51, points: 6100, ranking: 2,
    country: 'US', is_active_player: 1, joined: '2026-08-01T00:00:00Z', logins: 13,
    last_activity_at: '2026-08-29T11:00:00Z', last_login_at: '2026-08-29T10:00:00Z',
    resigned_at: null, number_of_battles: 5, battle_luckiness: 0.2, multi_status: 'clean',
    is_top_permanent_ranker: 0, has_supporter_badge: 1, supporter_type: 'gold',
    has_intel: 1, biology: 40, economy: 41, energy: 42, mathematics: 43, physics: 44, social: 45,
    trade_revenue: 46, artefact: 'real-artefact',
    race_growth: 1, race_science: 2, race_culture: 3, race_production: 4, race_speed: 5,
    race_attack: 6, race_defense: 7, race_trader: 8, race_sul: 9,
});
const afterDetailWithIntel = players.getPlayerFullById(701);
ok('upsertPlayerFromApiDetail with has_intel=1 DOES write intel columns', 
    afterDetailWithIntel.biology === 40 && afterDetailWithIntel.race_attack === 6
    && afterDetailWithIntel.artefact === 'real-artefact', afterDetailWithIntel);

players.upsertPlayerBasic(702, 'Second Player', null);
players.upsertPlayerBasic(703, 'Third Player', null);
const stale = players.getStalePlayerIdsForApiScan(10);
ok('getStalePlayerIdsForApiScan returns players never scanned, in some order', 
    stale.includes(701) && stale.includes(702) && stale.includes(703), stale);

players.markPlayersApiScanned([702, 703]);
const staleAfterMark = players.getStalePlayerIdsForApiScan(1);
ok('markPlayersApiScanned makes those ids less stale than 701 (never scanned)', 
    staleAfterMark[0] === 701, staleAfterMark);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node src/repositories/players.test.js`
Expected: FAIL — `getPlayerName is not a function`.

- [ ] **Step 3: Implement**

Add these functions to `src/repositories/players.js`, grouped near the other player-write
functions (match the file's existing section style):

```js
const getPlayerNameStmt = db.prepare(`SELECT name FROM players WHERE id = ?`);
function getPlayerName(id) {
    return getPlayerNameStmt.get(id);
}

const recordNameChangeStmt = db.prepare(`INSERT INTO player_name_history (player_id, old_name) VALUES (?, ?)`);
function recordNameChange(playerId, oldName) {
    recordNameChangeStmt.run(playerId, oldName);
}
```

```js
// ListPlayer-sourced upsert: writes only the fields the bulk list actually returns. Never
// touches home_planet_id/total_*/idle_time/eco_bonus/intel columns — the bulk list has no
// data for them, and this must not risk nulling out what a deeper scrape already knows.
const upsertPlayerFromApiListStmt = db.prepare(`
    INSERT INTO players (id, name, alliance_id, level, points, ranking, country, is_active_player, joined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, alliance_id=excluded.alliance_id, level=excluded.level,
        points=excluded.points, ranking=excluded.ranking, country=excluded.country,
        is_active_player=excluded.is_active_player, joined=excluded.joined,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertPlayerFromApiList(id, name, allianceId, level, points, ranking, country, isActivePlayer, joined) {
    upsertPlayerFromApiListStmt.run(id, name, allianceId, level, points, ranking, country, isActivePlayer, joined);
}
```

```js
// Player/{id}-sourced upsert: same has_intel-CASE-guard shape as upsertPlayerFull above,
// a SEPARATE statement (not shared) that never touches home_planet_id/total_*/idle_time/
// eco_bonus — those are scrape-only, the API detail response has no data for them.
const upsertPlayerFromApiDetailStmt = db.prepare(`
    INSERT INTO players (
        id, name, alliance_id, level, points, ranking, country,
        is_active_player, joined, logins, last_activity_at, last_login_at, resigned_at,
        number_of_battles, battle_luckiness, multi_status, is_top_permanent_ranker,
        has_supporter_badge, supporter_type,
        biology, economy, energy, mathematics, physics, social, trade_revenue, artefact,
        race_growth, race_science, race_culture, race_production, race_speed, race_attack,
        race_defense, race_trader, race_sul, has_intel, intel_updated_at
    ) VALUES (
        @id, @name, @alliance_id, @level, @points, @ranking, @country,
        @is_active_player, @joined, @logins, @last_activity_at, @last_login_at, @resigned_at,
        @number_of_battles, @battle_luckiness, @multi_status, @is_top_permanent_ranker,
        @has_supporter_badge, @supporter_type,
        @biology, @economy, @energy, @mathematics, @physics, @social, @trade_revenue, @artefact,
        @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack,
        @race_defense, @race_trader, @race_sul, @has_intel,
        CASE WHEN @has_intel = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
    ) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, alliance_id=excluded.alliance_id, level=excluded.level,
        points=excluded.points, ranking=excluded.ranking, country=excluded.country,
        is_active_player=excluded.is_active_player, joined=excluded.joined, logins=excluded.logins,
        last_activity_at=excluded.last_activity_at, last_login_at=excluded.last_login_at,
        resigned_at=excluded.resigned_at, number_of_battles=excluded.number_of_battles,
        battle_luckiness=excluded.battle_luckiness, multi_status=excluded.multi_status,
        is_top_permanent_ranker=excluded.is_top_permanent_ranker,
        has_supporter_badge=excluded.has_supporter_badge, supporter_type=excluded.supporter_type,
        updated_at=CURRENT_TIMESTAMP,

        biology = CASE WHEN excluded.has_intel = 1 THEN excluded.biology ELSE players.biology END,
        economy = CASE WHEN excluded.has_intel = 1 THEN excluded.economy ELSE players.economy END,
        energy = CASE WHEN excluded.has_intel = 1 THEN excluded.energy ELSE players.energy END,
        mathematics = CASE WHEN excluded.has_intel = 1 THEN excluded.mathematics ELSE players.mathematics END,
        physics = CASE WHEN excluded.has_intel = 1 THEN excluded.physics ELSE players.physics END,
        social = CASE WHEN excluded.has_intel = 1 THEN excluded.social ELSE players.social END,
        trade_revenue = CASE WHEN excluded.has_intel = 1 THEN excluded.trade_revenue ELSE players.trade_revenue END,
        artefact = CASE WHEN excluded.has_intel = 1 THEN excluded.artefact ELSE players.artefact END,
        race_growth = CASE WHEN excluded.has_intel = 1 THEN excluded.race_growth ELSE players.race_growth END,
        race_science = CASE WHEN excluded.has_intel = 1 THEN excluded.race_science ELSE players.race_science END,
        race_culture = CASE WHEN excluded.has_intel = 1 THEN excluded.race_culture ELSE players.race_culture END,
        race_production = CASE WHEN excluded.has_intel = 1 THEN excluded.race_production ELSE players.race_production END,
        race_speed = CASE WHEN excluded.has_intel = 1 THEN excluded.race_speed ELSE players.race_speed END,
        race_attack = CASE WHEN excluded.has_intel = 1 THEN excluded.race_attack ELSE players.race_attack END,
        race_defense = CASE WHEN excluded.has_intel = 1 THEN excluded.race_defense ELSE players.race_defense END,
        race_trader = CASE WHEN excluded.has_intel = 1 THEN excluded.race_trader ELSE players.race_trader END,
        race_sul = CASE WHEN excluded.has_intel = 1 THEN excluded.race_sul ELSE players.race_sul END,
        intel_updated_at = CASE WHEN excluded.has_intel = 1 THEN CURRENT_TIMESTAMP ELSE players.intel_updated_at END,
        has_intel = CASE WHEN excluded.has_intel = 1 THEN 1 ELSE players.has_intel END
`);
function upsertPlayerFromApiDetail(player) {
    upsertPlayerFromApiDetailStmt.run(player);
}
```

```js
const getStalePlayerIdsForApiScanStmt = db.prepare(`
    SELECT id FROM players
    ORDER BY (last_api_scan_at IS NULL) DESC, last_api_scan_at ASC
    LIMIT ?
`);
function getStalePlayerIdsForApiScan(limit) {
    return getStalePlayerIdsForApiScanStmt.all(limit).map(r => r.id);
}

// Arity varies per call (ids length) — prepared fresh each call, same reasoning as
// systems.js's getSystemsByIds/alliances.js's deleteStaleAllianceMembers.
function markPlayersApiScanned(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE players SET last_api_scan_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
}
```

- [ ] **Step 4: Update `module.exports`**

Add `getPlayerName, recordNameChange, upsertPlayerFromApiList, upsertPlayerFromApiDetail,
getStalePlayerIdsForApiScan, markPlayersApiScanned,` to the existing `module.exports` list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node src/repositories/players.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/repositories/players.js src/repositories/players.test.js
git commit -m "Add API-sourced player upserts, name-history helpers, and staleness scan queue"
```

---

### Task 3: Extend `public/js/utils/aw-api.js`

**Files:**
- Modify: `public/js/utils/aw-api.js`
- Modify: `src/utils/aw-api.test.js`

**Interfaces:**
- Produces: `getPlayers()` (new, `GET /api/v1/Player`), `getPlayer(id)` (new, `GET
  /api/v1/Player/{id}`), `searchPlayers({q, limit})` (new, `GET /api/v1/Player/search`).
  All resolve with the standard `{ok, data}` shape. Consumed by Task 5 (background sync)
  and Task 6 (search UI).

- [ ] **Step 1: Write the failing test**

Following the exact `calls`/`nextResponse`/`jsonRes` harness already used in this file
(see Plan 1/Plan 2's equivalent tasks for the pattern):

```js
console.log('\n── getPlayers / getPlayer / searchPlayers ' + '─'.repeat(30));
nextResponse = jsonRes([]);
calls.length = 0;
const listRes = await AWApi.getPlayers();
ok('getPlayers resolves ok', listRes.ok === true, listRes);
ok('the request path is plain /api/v1/Player, no query string', calls[0].url === '/api/v1/Player', calls[0].url);

nextResponse = jsonRes({ id: 701 });
calls.length = 0;
const detailRes = await AWApi.getPlayer(701);
ok('getPlayer resolves ok', detailRes.ok === true, detailRes);
ok('the request path includes the id', calls[0].url === '/api/v1/Player/701', calls[0].url);

nextResponse = jsonRes([]);
calls.length = 0;
const searchRes = await AWApi.searchPlayers({ q: 'Cave', limit: 15 });
ok('searchPlayers resolves ok', searchRes.ok === true, searchRes);
ok('the request path is Player/search with q and limit', /\/api\/v1\/Player\/search\?/.test(calls[0].url)
    && /q=Cave/.test(calls[0].url) && /limit=15/.test(calls[0].url), calls[0].url);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node src/utils/aw-api.test.js`
Expected: FAIL — `AWApi.getPlayers is not a function`.

- [ ] **Step 3: Implement**

Add immediately after `getSystemPlanets` / before `getMapSectors` (or anywhere in the
`// ─── ENDPOINTS ───` section — match the file's existing ordering/comment style):

```js
    // All active players (no filter): [{id, allianceId, isActivePlayer, name, allianceTag,
    // joinedAt, playerLevel, playsFromCountryCode, pointsScored, rank}].
    function getPlayers() {
        return requestJson('/api/v1/Player');
    }

    // One player's full detail, including intelligenceReport when the caller has vision.
    function getPlayer(id) {
        return requestJson('/api/v1/Player/' + encodeURIComponent(id));
    }

    // Player name/id search: same ListPlayer shape as getPlayers(), just filtered by q.
    function searchPlayers({ q, limit } = {}) {
        return requestJson('/api/v1/Player/search' + query({ q, limit }));
    }
```

- [ ] **Step 4: Update the exported functions list**

Add `getPlayers, getPlayer, searchPlayers,` to the file's single returned object.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node src/utils/aw-api.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add public/js/utils/aw-api.js src/utils/aw-api.test.js
git commit -m "Add getPlayers, getPlayer, and searchPlayers to the game API client"
```

---

### Task 4: New routes in `src/routes/sync.js`

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: all six new `playersRepo` functions from Task 2.
- Produces: `GET /sync/player-scan-claim?limit=N` (returns `{success, ids: [...]}`), `POST
  /sync/player-list` (accepts `{players: [...]}`, returns `{success, count}`), `POST
  /sync/player-detail` (accepts a single mapped player object, returns `{success}`), `GET
  /round-age` (returns `{days_since: N|null}`). All consumed by Task 5 (background sync)
  and Task 6 (search UI, for `/sync/player-list`'s shape only).

- [ ] **Step 1: Add the name-history hook to the EXISTING `/sync/player` route**

Find `/sync/player`'s handler (`router.post('/sync/player', requireAuth, (req, res) => {`)
and its existing `const oldPlayer = playersRepo.getPlayerRestartCheck(p.id);` line. Add,
immediately after that line:

```js
    const oldName = playersRepo.getPlayerName(p.id);
    if (oldName && oldName.name && safePlayer.name && oldName.name !== safePlayer.name) {
        playersRepo.recordNameChange(p.id, oldName.name);
    }
```

(Place this after `safePlayer` is constructed, since it reads `safePlayer.name` — check the
exact line ordering in the file and insert at the correct point relative to where
`safePlayer` is built vs where `oldPlayer` is read; do not reorder any EXISTING lines,
only insert this new block.)

- [ ] **Step 2: Add `GET /sync/player-scan-claim`**

Add this new route anywhere convenient near the other player-related sync routes (e.g.
right after `/sync/player`'s closing `});`):

```js
// --- PLAYER API-SCAN CLAIM ---
// Hands out the next batch of stale player ids for the background Player/{id} sweep. A
// "claim" here is just bumping last_api_scan_at now — an optimistic claim, not a locked
// reservation. If the caller's browser fails to actually scan them, they simply become
// stale again after one full sweep cycle and get offered to whoever asks next. See this
// plan's Global Constraints for why a full claims table wasn't built.
router.get('/sync/player-scan-claim', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    const ids = playersRepo.getStalePlayerIdsForApiScan(limit);
    if (ids.length) playersRepo.markPlayersApiScanned(ids);
    res.json({ success: true, ids });
});
```

- [ ] **Step 3: Add `POST /sync/player-list`**

```js
// --- PLAYER LIST RECEIVER (ListPlayer bulk sync) ---
router.post('/sync/player-list', requireAuth, (req, res) => {
    const { players } = req.body;
    if (!Array.isArray(players) || players.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let stored = 0;
    for (const p of players) {
        if (!Number.isInteger(p.id) || p.id <= 0) continue;
        const oldName = playersRepo.getPlayerName(p.id);
        const newName = typeof p.name === 'string' ? p.name : null;
        if (oldName && oldName.name && newName && oldName.name !== newName) {
            playersRepo.recordNameChange(p.id, oldName.name);
        }
        playersRepo.upsertPlayerFromApiList(
            p.id, newName,
            Number.isInteger(p.alliance_id) ? p.alliance_id : null,
            Number.isInteger(p.level) ? p.level : null,
            Number.isInteger(p.points) ? p.points : null,
            Number.isInteger(p.rank) ? p.rank : null,
            typeof p.country === 'string' ? p.country : null,
            p.is_active_player ? 1 : 0,
            typeof p.joined === 'string' ? p.joined : null
        );
        stored++;
    }
    res.json({ success: true, count: stored });
});
```

- [ ] **Step 4: Add `POST /sync/player-detail`**

```js
// --- PLAYER DETAIL RECEIVER (Player/{id} sync) ---
router.post('/sync/player-detail', requireAuth, (req, res) => {
    const p = req.body && req.body.player;
    if (!p || !Number.isInteger(p.id) || p.id <= 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const oldName = playersRepo.getPlayerName(p.id);
    const newName = typeof p.name === 'string' ? p.name : null;
    if (oldName && oldName.name && newName && oldName.name !== newName) {
        playersRepo.recordNameChange(p.id, oldName.name);
    }
    try {
        playersRepo.upsertPlayerFromApiDetail(p);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync player detail ${p.id}:`, err);
        res.status(500).json({ error: 'Database sync failed' });
    }
});
```

- [ ] **Step 5: Add `GET /round-age`**

A tiny, non-admin-gated endpoint the background sync module uses to pick its `ListPlayer`
cadence (see Task 5). Add it anywhere in `sync.js`:

```js
// --- ROUND AGE (for client-side cadence decisions, e.g. ListPlayer pull frequency) ---
router.get('/round-age', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT MAX(archived_at) as last_archived FROM rounds`).get();
    if (!row || !row.last_archived) return res.json({ success: true, days_since: null });
    const days = Math.floor((Date.now() - Date.parse(row.last_archived)) / (24 * 3600 * 1000));
    res.json({ success: true, days_since: days });
});
```

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass — confirm `utils/guest-role.test.js` still passes. It maintains a
`writePaths` array (`src/utils/guest-role.test.js:49-51`) that already includes
`/sync/alliance-search` from Plan 2's final-fix wave. Add `/sync/player-list` and
`/sync/player-detail` to it — but append them at the END of the array, not in the middle:
the same file later does `writePaths.slice(0, 6)` (line 85) to test a specific subset, so
inserting new entries before index 6 would silently change what that slice covers. Do NOT
add `/sync/player-scan-claim` or `/round-age` to this list — they're `GET` routes, and
`writePaths` is specifically for write (POST) routes; check the file's own usage to
confirm this distinction before adding anything.

- [ ] **Step 7: Commit**

```bash
git add src/routes/sync.js
git commit -m "Add player-list, player-detail, player-scan-claim, and round-age sync routes"
```

---

### Task 5: Background sync module — `public/js/ui/player-api-sync.js`

**Files:**
- Create: `public/js/ui/player-api-sync.js`
- Modify: `public/js/ui/dashboard.js`

**Interfaces:**
- Consumes: `AWApi.getPlayers()`, `AWApi.getPlayer(id)` (Task 3), `POST
  /hub-api/sync/player-list`, `POST /hub-api/sync/player-detail`, `GET
  /hub-api/sync/player-scan-claim`, `GET /hub-api/round-age` (Task 4).

This task has no automated test — DOM/browser background-sync code, matching
`battle-sync.js`'s existing precedent (also untested). Verify per Step 4 below.

- [ ] **Step 1: Write the module**

```js
// Player API background sync — wrapper realm only, mirrors battle-sync.js's shape.
//
// Two independent jobs on two independent clocks:
//   1. ListPlayer pull: the full active-roster list, cheap (one API call), kept fresh.
//      Cadence decays with round age — frequent early (most members join in the first two
//      weeks, not day one, waiting for a better starting location), relaxed later.
//   2. Player/{id} sweep: a slow, staleness-ordered background scan filling in the
//      activity/status fields ListPlayer doesn't have. Claims a batch via
//      /hub-api/sync/player-scan-claim (see that route's comment for what "claim" means
//      here), then calls Player/{id} once per claimed id, respecting a local per-account
//      budget (game admin's 200-calls-per-5-minutes limit, of which this background job
//      may use up to BACKGROUND_BUDGET — the rest is reserved for a member's own deliberate
//      lookups elsewhere in the hub).
//
// Cross-tab dedup follows battle-sync.js's localStorage-lock pattern exactly.

import '../utils/game-rate-limit.js'; // must load before aw-api resolves the gate
import '../utils/aw-api.js';

const AWApi = globalThis.AWApi;

const LIST_LOCK_KEY = 'awt.playerListSync.lock.v1';
const LIST_LOCK_TTL_MS = 4 * 60 * 1000; // shorter than even the frequent 5-min cadence
const LIST_INTERVAL_FREQUENT_MS = 5 * 60 * 1000;   // first ~2 weeks of a round
const LIST_INTERVAL_RELAXED_MS = 6 * 60 * 60 * 1000; // after that
const FREQUENT_PHASE_DAYS = 14;

const SWEEP_LOCK_KEY = 'awt.playerSweepSync.lock.v1';
const SWEEP_LOCK_TTL_MS = 50 * 1000; // shorter than the 60s sweep interval
const SWEEP_INTERVAL_MS = 60 * 1000;
// Hardcoded for this landing — see this plan's Global Constraints re: not wiring this to
// app_settings yet. Tune here directly if the 150-of-200 split needs adjusting.
const SWEEP_BATCH_SIZE = 15; // 15 calls/minute ≈ well under the 150-of-200-per-5-min reserve

function claimLock(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ttlMs) return false;
        localStorage.setItem(key, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage (private mode etc.) — degrade to "always run", same as game-rate-limit.js's fallback philosophy
    }
}

let listIntervalHandle = null;

async function pickListCadence() {
    try {
        const res = await fetch('/hub-api/round-age');
        const data = await res.json().catch(() => ({}));
        if (data && Number.isInteger(data.days_since) && data.days_since > FREQUENT_PHASE_DAYS) {
            return LIST_INTERVAL_RELAXED_MS;
        }
    } catch (err) { /* default to frequent on any failure — safer than under-syncing early */ }
    return LIST_INTERVAL_FREQUENT_MS;
}

async function runListPull() {
    if (!claimLock(LIST_LOCK_KEY, LIST_LOCK_TTL_MS)) return;
    try {
        const res = await AWApi.getPlayers();
        if (!res.ok || !Array.isArray(res.data) || !res.data.length) return;
        const players = res.data.map(p => ({
            id: p.id,
            name: typeof p.name === 'string' ? p.name : null,
            alliance_id: Number.isInteger(p.allianceId) ? p.allianceId : null,
            level: Number.isInteger(p.playerLevel) ? p.playerLevel : null,
            points: Number.isInteger(p.pointsScored) ? p.pointsScored : null,
            rank: Number.isInteger(p.rank) ? p.rank : null,
            country: typeof p.playsFromCountryCode === 'string' ? p.playsFromCountryCode : null,
            is_active_player: !!p.isActivePlayer,
            joined: typeof p.joinedAt === 'string' ? p.joinedAt : null,
        }));
        await fetch('/hub-api/sync/player-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ players }),
        });
    } catch (err) {
        console.warn('[PlayerApiSync] list pull failed:', err.message);
    }
}

async function scheduleNextListPull() {
    if (listIntervalHandle) clearTimeout(listIntervalHandle);
    const cadence = await pickListCadence();
    listIntervalHandle = setTimeout(async () => {
        await runListPull();
        scheduleNextListPull();
    }, cadence);
}

async function runSweepTick() {
    if (!claimLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)) return;
    try {
        const claimRes = await fetch(`/hub-api/sync/player-scan-claim?limit=${SWEEP_BATCH_SIZE}`);
        const claimed = await claimRes.json().catch(() => ({}));
        const ids = Array.isArray(claimed.ids) ? claimed.ids : [];
        for (const id of ids) {
            const res = await AWApi.getPlayer(id);
            if (!res.ok || !res.data) continue;
            const d = res.data;
            const intel = d.intelligenceReport;
            const player = {
                id: d.id, name: typeof d.name === 'string' ? d.name : null,
                alliance_id: Number.isInteger(d.allianceId) ? d.allianceId : null,
                level: Number.isInteger(d.playerLevel) ? d.playerLevel : null,
                points: Number.isInteger(d.pointsScored) ? d.pointsScored : null,
                ranking: Number.isInteger(d.rank) ? d.rank : null,
                country: typeof d.playsFromCountryCode === 'string' ? d.playsFromCountryCode : null,
                is_active_player: d.isActivePlayer ? 1 : 0,
                joined: typeof d.joinedAt === 'string' ? d.joinedAt : null,
                logins: Number.isInteger(d.numberOfLogins) ? d.numberOfLogins : null,
                last_activity_at: typeof d.lastActivityAt === 'string' ? d.lastActivityAt : null,
                last_login_at: typeof d.lastLoginAt === 'string' ? d.lastLoginAt : null,
                resigned_at: typeof d.resignedAt === 'string' ? d.resignedAt : null,
                number_of_battles: Number.isInteger(d.numberOfBattles) ? d.numberOfBattles : null,
                battle_luckiness: typeof d.battleLuckiness === 'number' ? d.battleLuckiness : null,
                multi_status: typeof d.multiStatus === 'string' ? d.multiStatus : null,
                is_top_permanent_ranker: d.isTopPermanentRanker ? 1 : 0,
                has_supporter_badge: d.hasSupporterBadge ? 1 : 0,
                supporter_type: typeof d.supporterType === 'string' ? d.supporterType : null,
                has_intel: intel ? 1 : 0,
                biology: intel ? intel.biologyLevel : null,
                economy: intel ? intel.economyLevel : null,
                energy: intel ? intel.energyLevel : null,
                mathematics: intel ? intel.mathematicsLevel : null,
                physics: intel ? intel.physicsLevel : null,
                social: intel ? intel.socialLevel : null,
                trade_revenue: intel ? intel.tradeBonus : null,
                artefact: intel && intel.activeArtefact ? JSON.stringify(intel.activeArtefact) : null,
                race_growth: intel && intel.race ? intel.race.growth : null,
                race_science: intel && intel.race ? intel.race.science : null,
                race_culture: intel && intel.race ? intel.race.culture : null,
                race_production: intel && intel.race ? intel.race.production : null,
                race_speed: intel && intel.race ? intel.race.speed : null,
                race_attack: intel && intel.race ? intel.race.attack : null,
                race_defense: intel && intel.race ? intel.race.defense : null,
                race_trader: intel && intel.race ? intel.race.trader : null,
                race_sul: intel && intel.race ? intel.race.sul : null,
            };
            await fetch('/hub-api/sync/player-detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player }),
            });
        }
    } catch (err) {
        console.warn('[PlayerApiSync] sweep tick failed:', err.message);
    }
}

let started = false;
export function initPlayerApiSync() {
    if (started) return;
    started = true;
    scheduleNextListPull();
    setInterval(runSweepTick, SWEEP_INTERVAL_MS);
}
```

Note on the `Race` schema mapping (`intel.race.growth` etc.): the exact field names inside
the API's `Race` object were not independently re-confirmed against a live response during
this plan's design (only its parent `IntelligenceReport` schema was checked) — if these
field names turn out to differ once tested against a live game session, only this one
mapping block needs correcting; everything else in this task is unaffected.

- [ ] **Step 2: Wire it into `dashboard.js`**

Before (`public/js/ui/dashboard.js:114-118`):
```js
    // Background battle-report sync (first pull 10 s after load, then every 30 min).
    // Loaded on demand like the galaxy map: the dashboard shell never blocks on it.
    import('./battle-sync.js')
        .then(({ initBattleSync }) => initBattleSync())
        .catch(err => console.warn('[BattleSync] failed to start:', err));
```
After (add the new module's start right after, same pattern):
```js
    // Background battle-report sync (first pull 10 s after load, then every 30 min).
    // Loaded on demand like the galaxy map: the dashboard shell never blocks on it.
    import('./battle-sync.js')
        .then(({ initBattleSync }) => initBattleSync())
        .catch(err => console.warn('[BattleSync] failed to start:', err));

    // Background player API sync (ListPlayer roster refresh + staleness-ordered Player/{id}
    // detail sweep). Same on-demand-load pattern as battle-sync above.
    import('./player-api-sync.js')
        .then(({ initPlayerApiSync }) => initPlayerApiSync())
        .catch(err => console.warn('[PlayerApiSync] failed to start:', err));
```

- [ ] **Step 3: Confirm syntax**

Run: `node --input-type=module --check < public/js/ui/player-api-sync.js` (or the
project's established equivalent — check what Plan 1/2's Task 5 used) and confirm no
syntax errors.

- [ ] **Step 4: Manual verification (deferred, same as Plans 1 and 2)**

Requires a real logged-in game session, not available today. When available: confirm the
`ListPlayer` pull actually populates new players into the roster; confirm the sweep claims
and scans a batch every ~60s without exceeding the local budget; confirm two open dashboard
tabs don't double-pull (check the lock behavior in the network tab).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add public/js/ui/player-api-sync.js public/js/ui/dashboard.js
git commit -m "Add background ListPlayer/Player-detail sync module"
```

---

### Task 6: Player search — extend the manual "search live" fallback

**Files:**
- Modify: `public/js/ui/search.js`

**Interfaces:**
- Consumes: `AWApi.searchPlayers({q, limit})` (Task 3), `POST /hub-api/sync/player-list`
  (Task 4, reused — `Player/search`'s response shape is the same `ListPlayer` shape, so no
  new sync route is needed here, matching Plan 2's precedent of reusing `/sync/galaxy` for
  `SolarSystem/search`).

- [ ] **Step 1: Extend the empty-results branch to include `player`**

Player search already has its own former-round fallback (`searchFormerNamesWithCurrentPlayer`)
layered in BEFORE the empty-results check even fires — that stays completely untouched.
This adds the LIVE-API option for the case where even the former-round search finds
nothing (a genuinely new player, never seen under any name).

Before (from Plan 2's Task 5, now in `search.js`):
```js
        if (!data.success || data.results.length === 0) {
            if (type === 'alliance' || type === 'system') {
```
After:
```js
        if (!data.success || data.results.length === 0) {
            if (type === 'alliance' || type === 'system' || type === 'player') {
```

- [ ] **Step 2: Add the player case to `searchLiveViaApi`**

Add a new `else if (type === 'player')` branch inside `searchLiveViaApi` (alongside the
existing `alliance`/`system` branches from Plan 2), reusing `/sync/player-list`'s payload
shape (same field names `upsertPlayerFromApiList` expects, same as what
`player-api-sync.js`'s `runListPull` already builds — mirror that exact mapping, don't
invent a second one):

```js
        } else if (type === 'player') {
            const res = await AWApi.searchPlayers({ q, limit: 20 });
            if (!res.ok) {
                resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">${res.reason === 'session' ? 'Log into the game first, then try again.' : 'The game did not answer.'}</div>`;
                return;
            }
            const players = (Array.isArray(res.data) ? res.data : []).map(p => ({
                id: p.id,
                name: typeof p.name === 'string' ? p.name : null,
                alliance_id: Number.isInteger(p.allianceId) ? p.allianceId : null,
                level: Number.isInteger(p.playerLevel) ? p.playerLevel : null,
                points: Number.isInteger(p.pointsScored) ? p.pointsScored : null,
                rank: Number.isInteger(p.rank) ? p.rank : null,
                country: typeof p.playsFromCountryCode === 'string' ? p.playsFromCountryCode : null,
                is_active_player: !!p.isActivePlayer,
                joined: typeof p.joinedAt === 'string' ? p.joinedAt : null,
            }));
            if (players.length) {
                const syncRes = await fetch('/hub-api/sync/player-list', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ players }),
                });
                const syncBody = await syncRes.json().catch(() => ({}));
                if (!syncRes.ok || !syncBody.success) {
                    resultsContainer.innerHTML = '<div class="text-s text-red-500 text-center py-2">Sync failed after search.</div>';
                    return;
                }
            }
        }
```

Place this as an additional `else if` branch in the same `if/else if` chain as the
existing `alliance`/`system` branches (check the exact structure Plan 2 left this function
in before inserting — match its indentation/style exactly).

- [ ] **Step 3: Confirm syntax and run the full suite**

Run: `node --input-type=module --check < public/js/ui/search.js` and `npm test`.
Expected: syntax check passes, all 31+ suites pass.

- [ ] **Step 4: Commit**

```bash
git add public/js/ui/search.js
git commit -m "Extend manual live-search fallback to player search"
```

---

## Self-Review Notes

- **Spec coverage:** spec section "3. Players" is covered: `ListPlayer` decaying-cadence
  pull (Task 5), `Player/{id}` claim-coordinated sweep (Task 5), within-round name-history
  (Tasks 2 + 4's hooks in all three write paths: existing scrape route, new list route, new
  detail route), the intel-preservation rule reused verbatim from `upsertPlayerFull`'s
  existing pattern (Task 2), the corrected player-column list from the spec's Schema
  section (Task 1 — `joined`/`logins`/`eco_bonus` correctly NOT duplicated). `Player/search`
  (Task 6) was folded in from the original full endpoint list even though the initial
  3-way phase split didn't name it explicitly — it belongs with the other player work and
  follows Plan 2's exact established pattern.
- **Deliberate scope trims, both flagged in Global Constraints, not silent:** the
  claims-table simplified to an optimistic timestamp bump; the background-call budget
  ceiling hardcoded rather than wired to `app_settings`.
- **Type consistency check:** `upsertPlayerFromApiList(id, name, allianceId, level, points,
  ranking, country, isActivePlayer, joined)`'s param order matches both call sites (Task
  4's `/sync/player-list` route and Task 6's `search.js` reuse of the same route — the
  route is the single point of truth, `search.js` never calls the repo function directly).
  `upsertPlayerFromApiDetail(player)`'s named-parameter object keys match exactly between
  Task 2's SQL (`@id, @name, ...`), Task 4's route (`playersRepo.upsertPlayerFromApiDetail(p)`
  passing the request body through directly), and Task 5's client-side object construction
  in `runSweepTick` (every key the SQL references is present in the object `player-api-sync.js`
  builds).
- **Flagged uncertainty, not silently assumed:** the `IntelligenceReport.race` sub-object's
  exact field names (`growth`/`science`/`culture`/etc.) were not independently verified
  against a live API response — noted directly in Task 5 as a single, isolated correction
  point if wrong, rather than presented as certain.
