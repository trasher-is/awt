# Database Refactor — players domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every raw `db.prepare()` call site touching the `players` and `player_logins`
tables into a new `src/repositories/players.js` module, mirroring the pattern established by
`src/repositories/systems.js`/`fleets.js`/`plans.js` in the prior (systems/fleets/plans) domain
plan.

**Architecture:** New `src/repositories/players.js`. Same conventions as the first domain:
module-level `const` prepared statements, named exported functions, no error-handling changes,
behavior-preserving 1:1 moves with two sanctioned exceptions (documented below). Where a route
touches tables outside this domain (alliances, alliance_member_stats, app_users, fleets,
planets, systems, etc.) in the same handler, only the players/player_logins calls migrate — the
rest stay raw `db.prepare()` until their own domain's plan runs. Mixing prepared statements from
different repository modules (or raw SQL) inside one `db.transaction()` callback remains safe —
same reasoning as the first domain plan.

**Tech Stack:** Node.js, better-sqlite3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Design note: `src/utils/round-archive.js` is explicitly OUT OF SCOPE

`round-archive.js`'s `archiveRound(db, {...})` function contains one query whose driving `FROM`
table is `players` (`INSERT INTO round_players (...) SELECT ... FROM players p LEFT JOIN
alliances a ...`, lines 51-57). By the "driving FROM table" rule used to place every other
function in this plan, that would put it in `players.js`. It is deliberately excluded anyway:

- `round-archive.js` doesn't `require('../database')` at module scope like every other file in
  this codebase — it takes `db` as a function parameter (`archiveRound(db, opts)`), specifically
  so `round-archive.test.js` can pass in a fresh throwaway database per test. Routing its query
  through a `players.js` that imports the shared `db` singleton would break that pattern for no
  benefit.
- The query's *output* table (`round_players`) belongs to the not-yet-planned `rounds` domain,
  not this one — it happens to read `players` as a source, but conceptually it's "archive a
  round," not "read player data."

Leave `round-archive.js` completely untouched by this plan. Revisit only if/when a `rounds`
domain plan is written, and even then, only if there's a concrete reason to change its
already-clean, already-tested DI pattern — there may not be.

## Global Constraints

- No SQL text, parameter order, or return-shape changes for any migrated query, with exactly
  TWO documented exceptions:
  1. `players.getPlayerCombatStats(name)` consolidates two byte-identical queries in
     `discord_bot.js` (`!battlecalc`'s `--def`/`--atk` lookups, currently two separate
     `db.prepare()` calls with the exact same SQL text) into one shared function.
  2. `players.getPlayerCombatStatsByName(name)` consolidates two byte-identical queries in
     `incoming.js` (`attachWinChances`'s enemy-by-name fallback and the per-defender loop's
     `statStmt`, both `` SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ? `` with the same
     five-column `STAT_COLS` string) into one shared function, with `STAT_COLS`'s column list
     inlined directly into the module-level SQL (the repository module cannot depend on a
     `const` defined in `incoming.js`).
  Every other function is an exact 1:1 move of SQL text already present elsewhere.
- No error-handling changes — try/catch and HTTP status codes stay in calling routes.
- Prepared statements compiled once at module load (module-level const), except where call
  arity varies per call (`getAllianceTagForMembers`, `getVisionObservers`,
  `getPlayerStatsByIds` — all take a variable-length id array, same pattern as the first
  domain's `getSystemsByIds`).
- Two functions have two fixed variants each instead of one dynamic-WHERE-clause query, mirroring
  the first domain's `getInterceptFleetsByAlliance`/`getInterceptFleetsByActiveUsers` pattern:
  `getInterceptHomesByAlliance`/`getInterceptHomesByActiveUsers` (interceptors.js's `homes`
  query).
- `src/utils/round-archive.js` is out of scope — see the Design Note above. Do not touch it in
  any task of this plan.
- After each task's migration step, restart `awt-test` (`pm2 restart awt-test`) and manually
  exercise the affected feature before moving to the next task.
- **Verification lesson from the systems/fleets/plans domain**: a single-line grep
  (`db.prepare` and `FROM players` on the *same* line) misses every multi-line query — this
  caused two real call sites to be missed in the first domain, caught only by the final
  whole-branch review. Every "verify no call sites were missed" step in this plan requires
  reading each remaining `db.prepare()`/`db.transaction()` block's actual SQL text, not just
  running the naive grep. Also **re-run the full test suite** (`npm test`) after each file's
  migration and watch for any test that asserts against literal source text containing
  `players`/`player_logins` SQL (like `round-archive.test.js`'s regex did for `fleets` in the
  first domain) — a manual check confirmed no such test exists today (see below), but this can
  change as tests are added, so don't skip re-checking.

## File Structure

- Create: `src/repositories/players.js`
- Create: `src/repositories/players.test.js`
- Modify: `src/routes/intel.js`, `src/routes/sync.js`, `src/discord_bot.js`,
  `src/routes/admin.js`, `src/routes/trade.js`, `src/routes/search.js`,
  `src/routes/incoming.js`, `src/utils/interceptors.js`, `src/discord-commands.js`

---

### Task 1: `src/repositories/players.js`

**Files:**
- Create: `src/repositories/players.js`
- Test: `src/repositories/players.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Tasks 2–6):
  - `getWarRoomPlayers(allianceId): Array<object>`
  - `getAllianceIntelPlayerIds(allianceId): Array<{id}>`
  - `countPlayers(): number`
  - `listPlayerIds(): Array<{id}>`
  - `getFullPlayersDb(): Array<object>`
  - `getAllianceTagForMembers(memberIds: number[]): {tag, n} | undefined`
  - `getVisionObservers(memberIds: number[]): Array<object>`
  - `getPlayerWithPlanetCount(playerId): object | undefined`
  - `getPlayerLoginHistory(playerId): Array<{timestamp, total_logins}>`
  - `getPlayerLoginHeatmap(playerId): Array<{hour, count}>`
  - `upsertPlayerBasic(id, name, allianceId): void`
  - `getPlayerNameWithTag(id): {name, alliance_tag} | undefined`
  - `getPlayerRestartCheck(id): {logins, points, origin_system} | undefined`
  - `resetPlayerOnRestart(id): void`
  - `upsertPlayerFull(player: object): void`
  - `insertPlayerLogin(playerId, totalLogins): void`
  - `upsertAllianceMemberBasic(id, name, allianceId): void`
  - `upsertPlayerNameOnly(id, name): void`
  - `getPlayerBiologyByName(name): {id, biology} | undefined`
  - `getThreatPlayersByBiology(threshold, excludeId): Array<object>`
  - `getThreatPlayersByScience(threshold, excludeId): Array<object>`
  - `getPlayerTravelStatsByName(name): {name, race_speed, energy} | undefined`
  - `countUnaffiliatedIntelPlayers(): number`
  - `listUnaffiliatedIntelPlayers(): Array<{id, name}>`
  - `listAllianceIntelPlayers(allianceId): Array<{id, name}>`
  - `getPlayerFullById(id): object | undefined`
  - `getPlayerFullByName(name): object | undefined`
  - `getAllianceOriginPlayersBrief(tag): Array<object>`
  - `getAllianceOriginPlayersDetailed(tag): Array<object>`
  - `getPlayerCombatStats(name): object | undefined`
  - `deleteAllPlayers(): void`
  - `getPlayerIdByName(name): {id} | undefined`
  - `searchPlayersByNameOrId(likeTerm, exactId): Array<object>`
  - `getPlayerStatsByIds(ids: number[]): Array<object>`
  - `getPlayerCombatStatsById(id): object | undefined`
  - `getPlayerCombatStatsByName(name): object | undefined`
  - `getPlayerWithAllianceByNameLower(name): object | undefined`
  - `getPlayerAllianceIdByName(name): {alliance_id} | undefined`
  - `getInterceptHomesByAlliance(allianceId): Array<object>`
  - `getInterceptHomesByActiveUsers(): Array<object>`
  - `suggestPlayersByQuery(likeTerm, limit): Array<{name, tag}>`
  - `suggestPlayersTopByPoints(limit): Array<{name, tag}>`

- [ ] **Step 1: Write the module**

Create `src/repositories/players.js`:

```js
const db = require('../database');

// --- players: read (intel.js) ---

const getWarRoomPlayersStmt = db.prepare(`
    SELECT p.id, p.name, p.economy, p.social, p.physics, p.mathematics, p.energy, p.biology, p.idle_time,
           p.race_attack, p.race_defense, p.race_speed, p.race_production, p.race_science,
           p.updated_at as player_scan_time, p.intel_updated_at,
           p.total_population, p.total_factories, p.total_farms, p.total_cybernetics, p.total_labs,
           p.trade_revenue, p.artefact,
           p.level, p.culture_level, p.has_intel,
           a.tag as alliance_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as total_planets
    FROM players p
    JOIN alliances a ON p.alliance_id = a.id
    WHERE p.alliance_id = ?
`);
function getWarRoomPlayers(allianceId) {
    return getWarRoomPlayersStmt.all(allianceId);
}

const getAllianceIntelPlayerIdsStmt = db.prepare(`
    SELECT id FROM players
    WHERE alliance_id = ? AND has_intel = 1
`);
function getAllianceIntelPlayerIds(allianceId) {
    return getAllianceIntelPlayerIdsStmt.all(allianceId);
}

const countPlayersStmt = db.prepare(`SELECT COUNT(*) as count FROM players`);
function countPlayers() {
    return countPlayersStmt.get().count;
}

const listPlayerIdsStmt = db.prepare(`SELECT id FROM players ORDER BY id ASC`);
function listPlayerIds() {
    return listPlayerIdsStmt.all();
}

const getFullPlayersDbStmt = db.prepare(`
    SELECT p.*, a.tag as alliance_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as planet_count
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
`);
function getFullPlayersDb() {
    return getFullPlayersDbStmt.all();
}

// Arity varies per call (memberIds length), so prepared fresh each call — same reasoning as
// systems.js's getSystemsByIds.
function getAllianceTagForMembers(memberIds) {
    if (!memberIds.length) return undefined;
    const marks = memberIds.map(() => '?').join(',');
    return db.prepare(`
        SELECT a.tag, COUNT(*) AS n
        FROM players p JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id IN (${marks})
        GROUP BY a.tag ORDER BY n DESC LIMIT 1
    `).get(...memberIds);
}

function getVisionObservers(memberIds) {
    if (!memberIds.length) return [];
    const marks = memberIds.map(() => '?').join(',');
    return db.prepare(`
        SELECT p.id AS playerId, p.name, p.biology, p.science_level,
               s.id AS originSystemId, s.x, s.y
        FROM players p
        JOIN systems s ON p.origin_system = s.id
        WHERE p.id IN (${marks})
          AND p.origin_system IS NOT NULL AND p.origin_system > 0
          AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(...memberIds);
}

const getPlayerWithPlanetCountStmt = db.prepare(`
    SELECT p.*,
           a.tag as alliance_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = ?) as planet_count
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.id = ?
`);
function getPlayerWithPlanetCount(playerId) {
    return getPlayerWithPlanetCountStmt.get(playerId, playerId);
}

// --- player_logins: read (intel.js) ---

const getPlayerLoginHistoryStmt = db.prepare(`
    SELECT timestamp, total_logins
    FROM player_logins
    WHERE player_id = ?
    ORDER BY timestamp ASC
    LIMIT 30
`);
function getPlayerLoginHistory(playerId) {
    return getPlayerLoginHistoryStmt.all(playerId);
}

const getPlayerLoginHeatmapStmt = db.prepare(`
    SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
    FROM player_logins
    WHERE player_id = ?
    GROUP BY hour
`);
function getPlayerLoginHeatmap(playerId) {
    return getPlayerLoginHeatmapStmt.all(playerId);
}

// --- players / player_logins: write (sync.js) ---

// System-scan upsert: preserves existing alliance_id when the new value is null.
const upsertPlayerBasicStmt = db.prepare(`
    INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        alliance_id = CASE WHEN excluded.alliance_id IS NOT NULL THEN excluded.alliance_id ELSE players.alliance_id END,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertPlayerBasic(id, name, allianceId) {
    upsertPlayerBasicStmt.run(id, name, allianceId);
}

const getPlayerNameWithTagStmt = db.prepare(`
    SELECT p.name, a.tag AS alliance_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.id = ?
`);
function getPlayerNameWithTag(id) {
    return getPlayerNameWithTagStmt.get(id);
}

const getPlayerRestartCheckStmt = db.prepare(`SELECT logins, points, origin_system FROM players WHERE id = ?`);
function getPlayerRestartCheck(id) {
    return getPlayerRestartCheckStmt.get(id);
}

const resetPlayerOnRestartStmt = db.prepare(`
    UPDATE players SET
        level=0, points=0, ranking=NULL, science_level=0, culture_level=0,
        biology=0, economy=0, energy=0, mathematics=0, physics=0, social=0,
        trade_revenue=0, artefact=NULL, eco_bonus=0,
        race_growth=0, race_science=0, race_culture=0, race_production=0, race_speed=0, race_attack=0, race_defense=0,
        race_trader=0, race_sul=0, origin_system=NULL, has_intel=0, intel_updated_at=NULL,
        home_planet_id=NULL, home_system_id=NULL, home_planet_index=NULL, possible_homes='[]',
        total_planets=0, total_population=0, total_farms=0, total_factories=0, total_labs=0, total_cybernetics=0, cv_used=0, cv_limit=0
    WHERE id = ?
`);
function resetPlayerOnRestart(id) {
    resetPlayerOnRestartStmt.run(id);
}

const upsertPlayerFullStmt = db.prepare(`
    INSERT INTO players (
        id, name, alliance_id, country, local_time, idle_time, origin_system,
        level, ranking, points, science_level, culture_level,
        biology, economy, energy, mathematics, physics, social,
        trade_revenue, artefact, eco_bonus,
        race_growth, race_science, race_culture, race_production, race_speed, race_attack, race_defense,
        race_trader, race_sul, joined, logins, has_intel, intel_updated_at,
        home_planet_id, home_system_id, home_planet_index, possible_homes,
        total_planets, total_population, total_farms, total_factories, total_labs, total_cybernetics, cv_used, cv_limit
    ) VALUES (
        @id, @name, @alliance_id, @country, @local_time, @idle_time, @origin_system,
        @level, @ranking, @points, @science_level, @culture_level,
        @biology, @economy, @energy, @mathematics, @physics, @social,
        @trade_revenue, @artefact, @eco_bonus,
        @race_growth, @race_science, @race_culture, @race_production, @race_speed, @race_attack, @race_defense,
        @race_trader, @race_sul, @joined, @logins, @has_intel,
        CASE WHEN @has_intel = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        @home_planet_id, @home_system_id, @home_planet_index, @possible_homes,
        @total_planets, @total_population, @total_farms, @total_factories, @total_labs, @total_cybernetics, @cv_used, @cv_limit
    ) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, alliance_id=excluded.alliance_id, country=excluded.country,
        local_time=excluded.local_time, idle_time=excluded.idle_time, origin_system=excluded.origin_system,
        level=excluded.level, ranking=excluded.ranking, points=excluded.points,
        science_level=excluded.science_level, culture_level=excluded.culture_level,
        joined=excluded.joined, logins=excluded.logins,
        home_planet_id=excluded.home_planet_id, home_system_id=excluded.home_system_id, home_planet_index=excluded.home_planet_index,
        possible_homes=excluded.possible_homes, total_planets=excluded.total_planets, total_population=excluded.total_population,
        total_farms=excluded.total_farms, total_factories=excluded.total_factories, total_labs=excluded.total_labs,
        total_cybernetics=excluded.total_cybernetics, cv_used=excluded.cv_used, cv_limit=excluded.cv_limit,
        updated_at=CURRENT_TIMESTAMP,

        biology = CASE WHEN excluded.has_intel = 1 THEN excluded.biology ELSE players.biology END,
        economy = CASE WHEN excluded.has_intel = 1 THEN excluded.economy ELSE players.economy END,
        energy = CASE WHEN excluded.has_intel = 1 THEN excluded.energy ELSE players.energy END,
        mathematics = CASE WHEN excluded.has_intel = 1 THEN excluded.mathematics ELSE players.mathematics END,
        physics = CASE WHEN excluded.has_intel = 1 THEN excluded.physics ELSE players.physics END,
        social = CASE WHEN excluded.has_intel = 1 THEN excluded.social ELSE players.social END,
        trade_revenue = CASE WHEN excluded.has_intel = 1 THEN excluded.trade_revenue ELSE players.trade_revenue END,
        artefact = CASE WHEN excluded.has_intel = 1 THEN excluded.artefact ELSE players.artefact END,
        eco_bonus = CASE WHEN excluded.has_intel = 1 THEN excluded.eco_bonus ELSE players.eco_bonus END,
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
function upsertPlayerFull(player) {
    upsertPlayerFullStmt.run(player);
}

const insertPlayerLoginStmt = db.prepare(`INSERT INTO player_logins (player_id, total_logins) VALUES (?, ?)`);
function insertPlayerLogin(playerId, totalLogins) {
    insertPlayerLoginStmt.run(playerId, totalLogins);
}

// Alliance-scan member upsert: unconditionally overwrites alliance_id (unlike
// upsertPlayerBasic above, which preserves it when the new value is null). Two distinct
// call shapes in the original code — kept separate per the no-behavior-change rule.
const upsertAllianceMemberBasicStmt = db.prepare(`
    INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        alliance_id=excluded.alliance_id,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceMemberBasic(id, name, allianceId) {
    upsertAllianceMemberBasicStmt.run(id, name, allianceId);
}

const upsertPlayerNameOnlyStmt = db.prepare(`
    INSERT INTO players (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=CURRENT_TIMESTAMP
`);
function upsertPlayerNameOnly(id, name) {
    upsertPlayerNameOnlyStmt.run(id, name);
}

// --- players: read (discord_bot.js) ---

const getPlayerBiologyByNameStmt = db.prepare(`SELECT id, biology FROM players WHERE LOWER(name) = ?`);
function getPlayerBiologyByName(name) {
    return getPlayerBiologyByNameStmt.get(name);
}

const getThreatPlayersByBiologyStmt = db.prepare(`
    SELECT p.name, p.biology, a.tag as ally_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.has_intel = 1 AND p.biology >= ? AND p.id != ?
    ORDER BY p.biology DESC, p.name ASC
    LIMIT 25
`);
function getThreatPlayersByBiology(threshold, excludeId) {
    return getThreatPlayersByBiologyStmt.all(threshold, excludeId);
}

const getThreatPlayersByScienceStmt = db.prepare(`
    SELECT p.name, p.science_level, a.tag as ally_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.has_intel = 0 AND p.science_level >= ? AND p.id != ?
    ORDER BY p.science_level DESC, p.name ASC
    LIMIT 25
`);
function getThreatPlayersByScience(threshold, excludeId) {
    return getThreatPlayersByScienceStmt.all(threshold, excludeId);
}

const getPlayerTravelStatsByNameStmt = db.prepare(`SELECT name, race_speed, energy FROM players WHERE name LIKE ?`);
function getPlayerTravelStatsByName(name) {
    return getPlayerTravelStatsByNameStmt.get(name);
}

const countUnaffiliatedIntelPlayersStmt = db.prepare(`
    SELECT COUNT(*) as count FROM players p
    WHERE p.alliance_id IS NULL
    AND p.has_intel = 1
`);
function countUnaffiliatedIntelPlayers() {
    return countUnaffiliatedIntelPlayersStmt.get().count;
}

const listUnaffiliatedIntelPlayersStmt = db.prepare(`
    SELECT id, name FROM players
    WHERE alliance_id IS NULL AND has_intel = 1
    ORDER BY name ASC
`);
function listUnaffiliatedIntelPlayers() {
    return listUnaffiliatedIntelPlayersStmt.all();
}

const listAllianceIntelPlayersStmt = db.prepare(`
    SELECT id, name FROM players
    WHERE alliance_id = ? AND has_intel = 1
    ORDER BY name ASC
`);
function listAllianceIntelPlayers(allianceId) {
    return listAllianceIntelPlayersStmt.all(allianceId);
}

const getPlayerFullByIdStmt = db.prepare(`
    SELECT p.*, a.tag as ally_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
           (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
    FROM players p 
    LEFT JOIN alliances a ON p.alliance_id = a.id 
    WHERE p.id = ?
`);
function getPlayerFullById(id) {
    return getPlayerFullByIdStmt.get(id);
}

const getPlayerFullByNameStmt = db.prepare(`
    SELECT p.*, a.tag as ally_tag,
           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
           (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
    FROM players p 
    LEFT JOIN alliances a ON p.alliance_id = a.id 
    WHERE p.name LIKE ?
`);
function getPlayerFullByName(name) {
    return getPlayerFullByNameStmt.get(name);
}

const getAllianceOriginPlayersBriefStmt = db.prepare(`
    SELECT p.name, p.biology, p.science_level, s.x, s.y
    FROM players p
    JOIN alliances a ON p.alliance_id = a.id
    JOIN systems s ON p.origin_system = s.id
    WHERE a.tag = ?
    AND p.origin_system IS NOT NULL 
    AND p.origin_system > 0
`);
function getAllianceOriginPlayersBrief(tag) {
    return getAllianceOriginPlayersBriefStmt.all(tag);
}

const getAllianceOriginPlayersDetailedStmt = db.prepare(`
    SELECT p.id, p.name, p.biology, p.science_level, p.energy, p.race_speed, s.id as orig_sys_id, s.x as orig_x, s.y as orig_y
    FROM players p
    JOIN alliances a ON p.alliance_id = a.id
    JOIN systems s ON p.origin_system = s.id
    WHERE a.tag = ?
`);
function getAllianceOriginPlayersDetailed(tag) {
    return getAllianceOriginPlayersDetailedStmt.all(tag);
}

// Consolidates discord_bot.js's !battlecalc --def and --atk lookups (byte-identical SQL in
// the original code — see Global Constraints exception #1).
const getPlayerCombatStatsStmt = db.prepare(`SELECT name, level, physics, mathematics, race_attack, race_defense FROM players WHERE name LIKE ?`);
function getPlayerCombatStats(name) {
    return getPlayerCombatStatsStmt.get(name);
}

// --- players: write (admin.js) ---

const deleteAllPlayersStmt = db.prepare(`DELETE FROM players`);
function deleteAllPlayers() {
    deleteAllPlayersStmt.run();
}

// --- players: read (trade.js) ---

const getPlayerIdByNameStmt = db.prepare(`SELECT id FROM players WHERE name = ? COLLATE NOCASE`);
function getPlayerIdByName(name) {
    return getPlayerIdByNameStmt.get(name);
}

// --- players: read (search.js) ---

const searchPlayersByNameOrIdStmt = db.prepare(`
    SELECT p.id, p.name, a.tag as alliance_tag
    FROM players p
    LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE p.name LIKE ? OR CAST(p.id AS TEXT) = ?
    LIMIT 20
`);
function searchPlayersByNameOrId(likeTerm, exactId) {
    return searchPlayersByNameOrIdStmt.all(likeTerm, exactId);
}

// --- players: read (incoming.js) ---

// Arity varies per call (ids length), prepared fresh each call.
function getPlayerStatsByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`
        SELECT p.id, p.name, p.level, p.has_intel,
               p.race_speed, p.race_attack, p.race_defense,
               p.physics, p.mathematics, p.energy,
               a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id IN (${placeholders})
    `).all(...ids);
}

const STAT_COLS = `race_attack, race_defense, physics, mathematics, science_level, level, has_intel, intel_updated_at`;

const getPlayerCombatStatsByIdStmt = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE id = ?`);
function getPlayerCombatStatsById(id) {
    return getPlayerCombatStatsByIdStmt.get(id);
}

// Consolidates incoming.js's attachWinChances enemy-by-name fallback and its per-defender
// statStmt loop (byte-identical SQL in the original code — see Global Constraints exception #2).
const getPlayerCombatStatsByNameStmt = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ?`);
function getPlayerCombatStatsByName(name) {
    return getPlayerCombatStatsByNameStmt.get(name);
}

const getPlayerWithAllianceByNameLowerStmt = db.prepare(`
    SELECT p.id, p.name, p.level, p.has_intel, p.race_speed, p.race_attack, p.race_defense,
           p.physics, p.mathematics, p.energy, a.tag AS alliance_tag
    FROM players p LEFT JOIN alliances a ON p.alliance_id = a.id
    WHERE LOWER(p.name) = ?
`);
function getPlayerWithAllianceByNameLower(name) {
    return getPlayerWithAllianceByNameLowerStmt.get(name);
}

// --- players: read (interceptors.js) ---

const getPlayerAllianceIdByNameStmt = db.prepare(`SELECT alliance_id FROM players WHERE name = ? COLLATE NOCASE`);
function getPlayerAllianceIdByName(name) {
    return getPlayerAllianceIdByNameStmt.get(name);
}

// Two fixed variants of interceptors.js's dynamic WHERE clause for the `homes` query —
// same pattern as fleets.js's getInterceptFleetsByAlliance/getInterceptFleetsByActiveUsers.
const getInterceptHomesByAllianceStmt = db.prepare(`
    SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
           COALESCE(p.home_planet_index, 1) AS launch_planet,
           ams.production_points, ams.astro_dollars,
           s.x AS sx, s.y AS sy
    FROM players p
    JOIN alliance_member_stats ams ON ams.player_id = p.id
    JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
    WHERE p.alliance_id = @aid AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptHomesByAlliance(allianceId) {
    return getInterceptHomesByAllianceStmt.all({ aid: allianceId });
}

const getInterceptHomesByActiveUsersStmt = db.prepare(`
    SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
           COALESCE(p.home_planet_index, 1) AS launch_planet,
           ams.production_points, ams.astro_dollars,
           s.x AS sx, s.y AS sy
    FROM players p
    JOIN alliance_member_stats ams ON ams.player_id = p.id
    JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
    WHERE LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1) AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getInterceptHomesByActiveUsers() {
    return getInterceptHomesByActiveUsersStmt.all({});
}

// --- players: read (discord-commands.js) ---

const suggestPlayersByQueryStmt = db.prepare(`
    SELECT p.name, a.tag
    FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
    WHERE p.name LIKE ? ORDER BY LENGTH(p.name) ASC LIMIT ?
`);
function suggestPlayersByQuery(likeTerm, limit) {
    return suggestPlayersByQueryStmt.all(likeTerm, limit);
}

const suggestPlayersTopByPointsStmt = db.prepare(`
    SELECT p.name, a.tag
    FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
    ORDER BY p.points DESC LIMIT ?
`);
function suggestPlayersTopByPoints(limit) {
    return suggestPlayersTopByPointsStmt.all(limit);
}

module.exports = {
    getWarRoomPlayers, getAllianceIntelPlayerIds, countPlayers, listPlayerIds, getFullPlayersDb,
    getAllianceTagForMembers, getVisionObservers, getPlayerWithPlanetCount,
    getPlayerLoginHistory, getPlayerLoginHeatmap,
    upsertPlayerBasic, getPlayerNameWithTag, getPlayerRestartCheck, resetPlayerOnRestart,
    upsertPlayerFull, insertPlayerLogin, upsertAllianceMemberBasic, upsertPlayerNameOnly,
    getPlayerBiologyByName, getThreatPlayersByBiology, getThreatPlayersByScience,
    getPlayerTravelStatsByName, countUnaffiliatedIntelPlayers, listUnaffiliatedIntelPlayers,
    listAllianceIntelPlayers, getPlayerFullById, getPlayerFullByName,
    getAllianceOriginPlayersBrief, getAllianceOriginPlayersDetailed, getPlayerCombatStats,
    deleteAllPlayers, getPlayerIdByName, searchPlayersByNameOrId, getPlayerStatsByIds,
    getPlayerCombatStatsById, getPlayerCombatStatsByName, getPlayerWithAllianceByNameLower,
    getPlayerAllianceIdByName, getInterceptHomesByAlliance, getInterceptHomesByActiveUsers,
    suggestPlayersByQuery, suggestPlayersTopByPoints,
};
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/players.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const players = require('./players');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('players.test.js');

db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (1, 'RAID', 'Raiders')`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (10, 'Rana', 5, 5)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, discord_name) VALUES (1, 'caveman', 'x', 'caveman')`).run();

ok('countPlayers starts at 0', players.countPlayers() === 0);

players.upsertPlayerBasic(1, 'caveman', 1);
ok('countPlayers is 1 after upsert', players.countPlayers() === 1);
ok('upsertPlayerBasic set the name', players.getPlayerNameWithTag(1).name === 'caveman');
ok('upsertPlayerBasic joined the alliance tag', players.getPlayerNameWithTag(1).alliance_tag === 'RAID');

// upsertPlayerBasic preserves alliance_id when the new value is null (unlike upsertAllianceMemberBasic).
players.upsertPlayerBasic(1, 'caveman', null);
ok('upsertPlayerBasic keeps the existing alliance_id on a null update', players.getPlayerNameWithTag(1).alliance_tag === 'RAID');

// upsertAllianceMemberBasic unconditionally overwrites alliance_id.
db.prepare(`INSERT INTO alliances (id, tag, name) VALUES (2, 'AO', 'Allied Ops')`).run();
players.upsertAllianceMemberBasic(1, 'caveman', 2);
ok('upsertAllianceMemberBasic overwrites alliance_id unconditionally', players.getPlayerNameWithTag(1).alliance_tag === 'AO');

players.upsertPlayerNameOnly(2, 'stahlburg');
ok('upsertPlayerNameOnly creates a bare-name row', players.getPlayerBiologyByName('stahlburg').id === 2);

players.resetPlayerOnRestart(1);
const afterReset = db.prepare(`SELECT points, biology FROM players WHERE id = ?`).get(1);
ok('resetPlayerOnRestart zeroes stats', afterReset.points === 0 && afterReset.biology === 0);

const check = players.getPlayerRestartCheck(2);
ok('getPlayerRestartCheck returns logins/points/origin_system', 'logins' in check && 'points' in check && 'origin_system' in check);

players.insertPlayerLogin(1, 50);
const history = players.getPlayerLoginHistory(1);
ok('getPlayerLoginHistory returns the logged row', history.length === 1 && history[0].total_logins === 50);

const heatmap = players.getPlayerLoginHeatmap(1);
ok('getPlayerLoginHeatmap groups by hour', heatmap.length === 1 && heatmap[0].count === 1);

const withPlanets = players.getPlayerWithPlanetCount(1);
ok('getPlayerWithPlanetCount returns the player row', withPlanets.id === 1);
ok('getPlayerWithPlanetCount includes a planet_count field', 'planet_count' in withPlanets);

const tagLookup = players.getAllianceTagForMembers([1, 2]);
ok('getAllianceTagForMembers finds the majority alliance', tagLookup && tagLookup.tag === 'AO');
ok('getAllianceTagForMembers returns undefined for an empty id list', players.getAllianceTagForMembers([]) === undefined);

db.prepare(`UPDATE players SET origin_system = 10 WHERE id = 1`).run();
const observers = players.getVisionObservers([1, 2]);
ok('getVisionObservers only returns players with a mapped origin system', observers.length === 1 && observers[0].playerId === 1);

const combatDef = players.getPlayerCombatStats('caveman');
const combatAtk = players.getPlayerCombatStats('caveman');
ok('getPlayerCombatStats is reusable for both --def and --atk lookups', combatDef.name === combatAtk.name && combatDef.name === 'caveman');

const byName = players.getPlayerCombatStatsByName('CAVEMAN'.toLowerCase());
const byId = players.getPlayerCombatStatsById(1);
ok('getPlayerCombatStatsByName and getPlayerCombatStatsById agree on the same player', byName.level === byId.level);

const statsByIds = players.getPlayerStatsByIds([1, 2, 999]);
ok('getPlayerStatsByIds returns only existing ids', statsByIds.length === 2);
ok('getPlayerStatsByIds returns an empty array for an empty id list', players.getPlayerStatsByIds([]).length === 0);

const searchResults = players.searchPlayersByNameOrId('%cave%', '1');
ok('searchPlayersByNameOrId finds by partial name', searchResults.some(r => r.id === 1));

const idByName = players.getPlayerIdByName('CAVEMAN');
ok('getPlayerIdByName is case-insensitive', idByName && idByName.id === 1);

players.upsertPlayerFull({
    id: 3, name: 'newscout', alliance_id: null, country: null, local_time: null, idle_time: null,
    origin_system: null, level: 5, ranking: null, points: 100, science_level: 2, culture_level: 1,
    biology: 3, economy: 0, energy: 0, mathematics: 0, physics: 0, social: 0,
    trade_revenue: 0, artefact: null, eco_bonus: 0,
    race_growth: 0, race_science: 0, race_culture: 0, race_production: 0, race_speed: 0, race_attack: 0, race_defense: 0,
    race_trader: 0, race_sul: 0, joined: null, logins: 1, has_intel: 1,
    home_planet_id: null, home_system_id: null, home_planet_index: null, possible_homes: '[]',
    total_planets: 0, total_population: 0, total_farms: 0, total_factories: 0, total_labs: 0, total_cybernetics: 0, cv_used: 0, cv_limit: 0
});
ok('upsertPlayerFull created the player', players.countPlayers() === 3);
ok('upsertPlayerFull respected has_intel=1 for biology', players.getPlayerWithPlanetCount(3).biology === 3);

players.deleteAllPlayers();
ok('deleteAllPlayers empties the table', players.countPlayers() === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `players.js`, run `node src/repositories/players.test.js`, confirm it errors
with `Cannot find module './players'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/players.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/players.js src/repositories/players.test.js
git commit -m "Add players repository module (players, player_logins)"
```

---

### Task 2: Migrate `src/routes/intel.js`

**Files:**
- Modify: `src/routes/intel.js`

**Interfaces:**
- Consumes: `players` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`plansRepo` imports, add:
```js
const playersRepo = require('../repositories/players');
```

- [ ] **Step 2: `/intel/war-room/players`**

Before:
```js
        const players = db.prepare(`
            SELECT p.id, p.name, p.economy, p.social, p.physics, p.mathematics, p.energy, p.biology, p.idle_time,
                   p.race_attack, p.race_defense, p.race_speed, p.race_production, p.race_science,
                   p.updated_at as player_scan_time, p.intel_updated_at,
                   p.total_population, p.total_factories, p.total_farms, p.total_cybernetics, p.total_labs,
                   p.trade_revenue, p.artefact,
                   p.level, p.culture_level, p.has_intel,
                   a.tag as alliance_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as total_planets
            FROM players p
            JOIN alliances a ON p.alliance_id = a.id
            WHERE p.alliance_id = ?
        `).all(alliance_id);
```
After: `const players = playersRepo.getWarRoomPlayers(alliance_id);`

- [ ] **Step 3: `/alliance-intel/:allianceId`**

Before:
```js
        const rows = db.prepare(`
            SELECT id FROM players
            WHERE alliance_id = ? AND has_intel = 1
        `).all(allianceId);
```
After: `const rows = playersRepo.getAllianceIntelPlayerIds(allianceId);`

- [ ] **Step 4: `/intel/summary`**

Before: `const players = db.prepare(\`SELECT COUNT(*) as count FROM players\`).get().count;`
After: `const players = playersRepo.countPlayers();`

- [ ] **Step 5: `/players` (mass scan list)**

Before: `const playersList = db.prepare(\`SELECT id FROM players ORDER BY id ASC\`).all();`
After: `const playersList = playersRepo.listPlayerIds();`

- [ ] **Step 6: `/intel/players` (full player DB)**

Before:
```js
        const players = db.prepare(`
            SELECT p.*, a.tag as alliance_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as planet_count
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
        `).all();
```
After: `const players = playersRepo.getFullPlayersDb();`

- [ ] **Step 7: `/intel/galaxy-map`'s `ownTag` and `observers` lookups**

Before:
```js
        const memberIds = db.prepare(`SELECT player_id FROM alliance_member_stats`).all().map(r => r.player_id);
        const ownTag = memberIds.length
            ? (db.prepare(`
                SELECT a.tag, COUNT(*) AS n
                FROM players p JOIN alliances a ON p.alliance_id = a.id
                WHERE p.id IN (${memberIds.map(() => '?').join(',')})
                GROUP BY a.tag ORDER BY n DESC LIMIT 1
              `).get(...memberIds) || {}).tag || null
            : null;

        // Observers for the vision layer. Radius is NOT computed here — the rule lives in
        // public/js/utils/vision-model.js and is applied once, on the client, so the map
        // and Discord cannot drift apart again.
        const observers = memberIds.length
            ? db.prepare(`
                SELECT p.id AS playerId, p.name, p.biology, p.science_level,
                       s.id AS originSystemId, s.x, s.y
                FROM players p
                JOIN systems s ON p.origin_system = s.id
                WHERE p.id IN (${memberIds.map(() => '?').join(',')})
                  AND p.origin_system IS NOT NULL AND p.origin_system > 0
                  AND s.x IS NOT NULL AND s.y IS NOT NULL
              `).all(...memberIds)
            : [];
```
After (the `alliance_member_stats` query for `memberIds` stays raw — that table belongs to a
future domain plan; only the two `players`-driven queries move):
```js
        const memberIds = db.prepare(`SELECT player_id FROM alliance_member_stats`).all().map(r => r.player_id);
        const ownTag = (playersRepo.getAllianceTagForMembers(memberIds) || {}).tag || null;

        // Observers for the vision layer. Radius is NOT computed here — the rule lives in
        // public/js/utils/vision-model.js and is applied once, on the client, so the map
        // and Discord cannot drift apart again.
        const observers = playersRepo.getVisionObservers(memberIds);
```
Note: `getAllianceTagForMembers`/`getVisionObservers` already handle the empty-`memberIds` case
internally (returning `undefined`/`[]`), so the ternaries collapse away — this is the same kind
of harmless internal guard `getSystemsByIds` added in the first domain (see that plan's
constraints), not a behavior change to the response shape.

- [ ] **Step 8: `/intel/player/:id`'s player-info, login-history, and heatmap queries**

Before:
```js
        const playerInfo = db.prepare(`
            SELECT p.*,
                   a.tag as alliance_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = ?) as planet_count
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.id = ?
        `).get(playerId, playerId);
```
After: `const playerInfo = playersRepo.getPlayerWithPlanetCount(playerId);`

Before:
```js
            const history = db.prepare(`
                SELECT timestamp, total_logins
                FROM player_logins
                WHERE player_id = ?
                ORDER BY timestamp ASC
                LIMIT 30
            `).all(playerId);
```
After: `const history = playersRepo.getPlayerLoginHistory(playerId);`

Before:
```js
            const heatmapData = db.prepare(`
                SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
                FROM player_logins
                WHERE player_id = ?
                GROUP BY hour
            `).all(playerId);
```
After: `const heatmapData = playersRepo.getPlayerLoginHeatmap(playerId);`

- [ ] **Step 9: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/routes/intel.js`, and for every remaining
match, read its full SQL text (not just the grep line) and confirm its primary table is
genuinely NOT `players`/`player_logins` (should be alliances/alliance_member_stats/app_users/
trade_agreements/etc. — all future-domain tables).

- [ ] **Step 10: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
In a browser at `https://test.37.27.17.97.nip.io`: check the War Room players list, the alliance
profile intel-flag injection, the dashboard summary counts, the full player database view, the
galaxy archive map (own-alliance tag + vision overlay), and a player's intel panel (stats,
login-history chart, activity heatmap).

- [ ] **Step 11: Commit**

```bash
cd /root/awt-test
git add src/routes/intel.js
git commit -m "Migrate intel.js players/player_logins queries to the repository layer"
```

---

### Task 3: Migrate `src/routes/sync.js`

This is the highest-risk file in this domain — players/player_logins statements are interleaved
with not-yet-migrated alliances writes inside three separate `db.transaction()` callbacks.

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `players` from Task 1

- [ ] **Step 1: Add the import**

```js
const playersRepo = require('../repositories/players');
```

- [ ] **Step 2: `/sync/system`'s player upsert (module-scope-per-request statement + its call site)**

Before (statement declaration):
```js
    const upsertPlayer = db.prepare(`
        INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            alliance_id = CASE WHEN excluded.alliance_id IS NOT NULL THEN excluded.alliance_id ELSE players.alliance_id END,
            updated_at = CURRENT_TIMESTAMP
    `);
```
After: delete this declaration entirely (its call site moves to a repository call below).

Before (call site inside the planets loop, alongside the `upsertAlliance` call — leave
`upsertAlliance`'s own call untouched, only replace `upsertPlayer.run(...)`):
```js
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                upsertPlayer.run(p.owner.id, p.owner.name, p.owner.alliance_id || null);
```
After:
```js
                if (p.owner.alliance_id) upsertAlliance.run(p.owner.alliance_id, p.owner.alliance_tag ?? null, p.owner.alliance_tag ?? '');
                playersRepo.upsertPlayerBasic(p.owner.id, p.owner.name, p.owner.alliance_id || null);
```

- [ ] **Step 3: `/sync/system`'s Discord-announce name lookup**

Before (statement declaration, alongside the retained `getPlayerName` variable name — rename the
usages, don't leave a `getPlayerName` local pointing at a repository function under a
mismatched name):
```js
    const getPlayerName = db.prepare(`
        SELECT p.name, a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id = ?
    `);
```
After: delete this declaration.

Before (the `nameOf` closure that calls it):
```js
    const nameOf = (id) => {
        if (!id) return null;
        const row = getPlayerName.get(id);
        if (!row) return `#${id}`;
        return row.alliance_tag ? `[${row.alliance_tag}] ${row.name}` : row.name;
    };
```
After:
```js
    const nameOf = (id) => {
        if (!id) return null;
        const row = playersRepo.getPlayerNameWithTag(id);
        if (!row) return `#${id}`;
        return row.alliance_tag ? `[${row.alliance_tag}] ${row.name}` : row.name;
    };
```

- [ ] **Step 4: `/sync/player`'s restart-check lookup (before the transaction)**

Before: `const oldPlayer = db.prepare('SELECT logins, points, origin_system FROM players WHERE id = ?').get(p.id);`
After: `const oldPlayer = playersRepo.getPlayerRestartCheck(p.id);`

- [ ] **Step 5: `/sync/player`'s restart-reset UPDATE, inside `syncTransaction`**

Before (this sits immediately after `fleetsRepo.deleteFleetsByOwner(player.id);`, already
migrated in the first domain plan — leave that line as-is, only replace the `UPDATE players`
block that follows it):
```js
            fleetsRepo.deleteFleetsByOwner(player.id);
            db.prepare(`
                UPDATE players SET
                    level=0, points=0, ranking=NULL, science_level=0, culture_level=0,
                    biology=0, economy=0, energy=0, mathematics=0, physics=0, social=0,
                    trade_revenue=0, artefact=NULL, eco_bonus=0,
                    race_growth=0, race_science=0, race_culture=0, race_production=0, race_speed=0, race_attack=0, race_defense=0,
                    race_trader=0, race_sul=0, origin_system=NULL, has_intel=0, intel_updated_at=NULL,
                    home_planet_id=NULL, home_system_id=NULL, home_planet_index=NULL, possible_homes='[]',
                    total_planets=0, total_population=0, total_farms=0, total_factories=0, total_labs=0, total_cybernetics=0, cv_used=0, cv_limit=0
                WHERE id = ?
            `).run(player.id);
```
After:
```js
            fleetsRepo.deleteFleetsByOwner(player.id);
            playersRepo.resetPlayerOnRestart(player.id);
```

- [ ] **Step 6: `/sync/player`'s main upsert, inside `syncTransaction`**

Before: the full `db.prepare(\`INSERT INTO players (...) VALUES (...) ON CONFLICT ...\`).run(player);`
block (the large named-parameter statement — see the plan's Task 1 module source for its exact
text, it is byte-for-byte identical here in `sync.js`).

After: `playersRepo.upsertPlayerFull(player);`

Leave the `if (player.alliance_id) { db.prepare(\`INSERT INTO alliances ...\`) ... }` block
immediately above this untouched — that's an alliances-domain write.

- [ ] **Step 7: `/sync/player`'s login-row insert, inside `syncTransaction`**

Before:
```js
        if (player.logins > 0 && (!oldPlayer || oldPlayer.logins !== player.logins)) {
            db.prepare(`INSERT INTO player_logins (player_id, total_logins) VALUES (?, ?)`).run(player.id, player.logins);
        }
```
After:
```js
        if (player.logins > 0 && (!oldPlayer || oldPlayer.logins !== player.logins)) {
            playersRepo.insertPlayerLogin(player.id, player.logins);
        }
```

- [ ] **Step 8: `/sync/alliance`'s member-upsert loop, inside its `syncTransaction`**

Before (leave the alliances INSERT immediately above this — lines "1. Upsert Alliance Data" —
completely untouched; only the player-upsert statement and its loop call move):
```js
        // 2. Map all members to this Alliance
        const upsertPlayer = db.prepare(`
            INSERT INTO players (id, name, alliance_id) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                alliance_id=excluded.alliance_id,
                updated_at=CURRENT_TIMESTAMP
        `);

        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                upsertPlayer.run(member.id, member.name, a.id);
            }
        }
```
After:
```js
        // 2. Map all members to this Alliance
        if (Array.isArray(a.members)) {
            for (const member of a.members) {
                playersRepo.upsertAllianceMemberBasic(member.id, member.name, a.id);
            }
        }
```

- [ ] **Step 9: `/sync/alliance-stats`'s player name-upsert, inside its `tx`**

Before (leave the `INSERT INTO alliance_member_stats` block immediately above this untouched —
that table belongs to a future domain plan; only the players statement moves):
```js
            db.prepare(`
                INSERT INTO players (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=CURRENT_TIMESTAMP
            `).run(s.player_id, s.name);
```
After:
```js
            playersRepo.upsertPlayerNameOnly(s.player_id, s.name);
```

- [ ] **Step 10: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/routes/sync.js`, and for every remaining
match, read its full SQL text and confirm its primary table is NOT `players`/`player_logins`
(should be alliances/planets/best_guarded — wait, planets/best_guarded/systems/fleets are
already migrated in the first domain, so any survivors there would themselves be a first-domain
regression, not this task's concern; the only NEW survivors this task should leave behind are
alliances-table statements). Specifically confirm these three transactions still contain, in
order: `syncTransaction` in `/sync/system` (systemsRepo calls including `systemsRepo.logPlanetEvent`
from the first domain, `upsertAlliance.run`, `playersRepo.upsertPlayerBasic`);
`syncTransaction` in `/sync/player` (`fleetsRepo.deleteFleetsByOwner`,
`playersRepo.resetPlayerOnRestart`, raw alliances INSERT, `playersRepo.upsertPlayerFull`,
`playersRepo.insertPlayerLogin`); `syncTransaction` in `/sync/alliance` (raw alliances INSERT,
`playersRepo.upsertAllianceMemberBasic` in the loop); `tx` in `/sync/alliance-stats` (raw
alliance_member_stats INSERT, `playersRepo.upsertPlayerNameOnly`, `fleetsRepo` calls from the
first domain).

- [ ] **Step 11: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
Browse a system in-game through the proxy to trigger `/sync/system` and confirm player names/
alliance tags still populate correctly. If you can trigger a player-profile visit, an alliance
scan, or wait for the next scheduled alliance-stats scan, confirm no errors in
`pm2 logs awt-test --lines 50 --nostream` and that player data (points, level, stats) updates as
expected afterward.

- [ ] **Step 12: Commit**

```bash
cd /root/awt-test
git add src/routes/sync.js
git commit -m "Migrate sync.js players/player_logins queries to the repository layer"
```

---

### Task 4: Migrate `src/discord_bot.js`

This is the largest consumer in this domain (14 call sites).

**Files:**
- Modify: `src/discord_bot.js`

**Interfaces:**
- Consumes: `players` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing `systemsRepo`/`fleetsRepo`/`plansRepo` imports:
```js
const playersRepo = require('./repositories/players');
```

- [ ] **Step 2: `!threat`-style command's biology/science lookups**

Before:
```js
        const me = db.prepare(`SELECT id, biology FROM players WHERE LOWER(name) = ?`).get(user.game_name.toLowerCase());
```
After: `const me = playersRepo.getPlayerBiologyByName(user.game_name.toLowerCase());`

Before:
```js
        const confirmedThreats = db.prepare(`
            SELECT p.name, p.biology, a.tag as ally_tag
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.has_intel = 1 AND p.biology >= ? AND p.id != ?
            ORDER BY p.biology DESC, p.name ASC
            LIMIT 25
        `).all(threatThreshold, me.id);
```
After: `const confirmedThreats = playersRepo.getThreatPlayersByBiology(threatThreshold, me.id);`

Before:
```js
        const suspectedThreats = db.prepare(`
            SELECT p.name, p.science_level, a.tag as ally_tag
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.has_intel = 0 AND p.science_level >= ? AND p.id != ?
            ORDER BY p.science_level DESC, p.name ASC
            LIMIT 25
        `).all(threatThreshold, me.id);
```
After: `const suspectedThreats = playersRepo.getThreatPlayersByScience(threatThreshold, me.id);`

- [ ] **Step 3: `!tt` travel-time calculator's semi-manual player lookup**

Before: `const player = db.prepare(\`SELECT name, race_speed, energy FROM players WHERE name LIKE ?\`).get(playerName);`
After: `const player = playersRepo.getPlayerTravelStatsByName(playerName);`

- [ ] **Step 4: `!intels` drilldown — solos count, group lists, player detail**

Before:
```js
        const solosCount = db.prepare(`
            SELECT COUNT(*) as count FROM players p
            WHERE p.alliance_id IS NULL
            AND p.has_intel = 1
        `).get().count;
```
After: `const solosCount = playersRepo.countUnaffiliatedIntelPlayers();`

Before:
```js
                if (chosenGroup.type === 'solos') {
                    groupPlayers = db.prepare(`
                        SELECT id, name FROM players
                        WHERE alliance_id IS NULL AND has_intel = 1
                        ORDER BY name ASC
                    `).all();
                } else {
                    groupPlayers = db.prepare(`
                        SELECT id, name FROM players
                        WHERE alliance_id = ? AND has_intel = 1
                        ORDER BY name ASC
                    `).all(chosenGroup.id);
                }
```
After:
```js
                if (chosenGroup.type === 'solos') {
                    groupPlayers = playersRepo.listUnaffiliatedIntelPlayers();
                } else {
                    groupPlayers = playersRepo.listAllianceIntelPlayers(chosenGroup.id);
                }
```

Before:
```js
                const player = db.prepare(`
                    SELECT p.*, a.tag as ally_tag,
                           (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
                           (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
                    FROM players p 
                    LEFT JOIN alliances a ON p.alliance_id = a.id 
                    WHERE p.id = ?
                `).get(targetPlayer.id);
```
After: `const player = playersRepo.getPlayerFullById(targetPlayer.id);`

- [ ] **Step 5: `!intel <name>` command**

Before:
```js
        const player = db.prepare(`
            SELECT p.*, a.tag as ally_tag,
                   (SELECT COUNT(*) FROM planets WHERE owner_id = p.id) as actual_planets,
                   (SELECT SUM(population) FROM planets WHERE owner_id = p.id) as actual_pop
            FROM players p 
            LEFT JOIN alliances a ON p.alliance_id = a.id 
            WHERE p.name LIKE ?
        `).get(playerName);
```
After: `const player = playersRepo.getPlayerFullByName(playerName);`

- [ ] **Step 6: `!vision` command's alliance-origin players lookup**

Before:
```js
        const players = db.prepare(`
            SELECT p.name, p.biology, p.science_level, s.x, s.y
            FROM players p
            JOIN alliances a ON p.alliance_id = a.id
            JOIN systems s ON p.origin_system = s.id
            WHERE a.tag = ?
            AND p.origin_system IS NOT NULL 
            AND p.origin_system > 0
        `).all(tag);
```
After: `const players = playersRepo.getAllianceOriginPlayersBrief(tag);`

- [ ] **Step 7: `!ghosts` command's alliance-origin players lookup**

Before:
```js
        const alliancePlayers = db.prepare(`
            SELECT p.id, p.name, p.biology, p.science_level, p.energy, p.race_speed, s.id as orig_sys_id, s.x as orig_x, s.y as orig_y
            FROM players p
            JOIN alliances a ON p.alliance_id = a.id
            JOIN systems s ON p.origin_system = s.id
            WHERE a.tag = ?
        `).all(tag);
```
After: `const alliancePlayers = playersRepo.getAllianceOriginPlayersDetailed(tag);`

- [ ] **Step 8: `!battlecalc`'s `--def`/`--atk` auto-fill lookups**

Before (two near-identical blocks — replace both, per the sanctioned dedup in Global
Constraints):
```js
        if (defPlayerName) {
            const p = db.prepare(`SELECT name, level, physics, mathematics, race_attack, race_defense FROM players WHERE name LIKE ?`).get(defPlayerName);
```
After: `const p = playersRepo.getPlayerCombatStats(defPlayerName);`

Before:
```js
        if (atkPlayerName) {
            const p = db.prepare(`SELECT name, level, physics, mathematics, race_attack, race_defense FROM players WHERE name LIKE ?`).get(atkPlayerName);
```
After: `const p = playersRepo.getPlayerCombatStats(atkPlayerName);`

(Only the `db.prepare(...).get(...)` line changes in each block — the surrounding
`if (defPlayerName) { ... }`/`if (atkPlayerName) { ... }` bodies and their subsequent field
assignments stay exactly as they are.)

- [ ] **Step 9: Verify no domain call sites were missed**

Run: `cd /root/awt-test && grep -n "db\.prepare" src/discord_bot.js`, and for every remaining
match, read its full SQL text and confirm its primary table is NOT `players`/`player_logins`.

- [ ] **Step 10: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`, confirm the Discord bot reconnects ("Tactical Bot active
and logged in"). In the Discord test server, run: the biology/science threat command, `!tt`
with a player name (semi-manual mode), `!intels` through both a solos and an alliance group to a
player detail, `!intel <name>`, `!vision <system> <tag>`, `!ghosts <system> <tag>`, and
`!battlecalc --def <name> --atk <name>` — confirm each responds with real data.

- [ ] **Step 11: Commit**

```bash
cd /root/awt-test
git add src/discord_bot.js
git commit -m "Migrate discord_bot.js players queries to the repository layer"
```

---

### Task 5: Migrate the remaining files (admin.js, trade.js, search.js, incoming.js, interceptors.js, discord-commands.js)

**Files:**
- Modify: `src/routes/admin.js`, `src/routes/trade.js`, `src/routes/search.js`,
  `src/routes/incoming.js`, `src/utils/interceptors.js`, `src/discord-commands.js`

**Interfaces:**
- Consumes: `players` from Task 1

- [ ] **Step 1: `src/routes/admin.js` — add the import**

Alongside the file's existing repository imports:
```js
const playersRepo = require('../repositories/players');
```

- [ ] **Step 2: `src/routes/admin.js` — `/admin/status`**

Before:
```js
            players: db.prepare(`SELECT COUNT(*) as count FROM players`).get().count,
```
After:
```js
            players: playersRepo.countPlayers(),
```

- [ ] **Step 3: `src/routes/admin.js` — nuke transaction**

Before (leave `archiveRound`, `fleetsRepo`/`plansRepo`/`systemsRepo` calls, the alliances
DELETE, and their relative order completely untouched — only the `players` DELETE moves):
```js
            db.prepare(`DELETE FROM players`).run();
```
After:
```js
            playersRepo.deleteAllPlayers();
```

- [ ] **Step 4: `src/routes/trade.js` — add the import**

```js
const playersRepo = require('../repositories/players');
```

- [ ] **Step 5: `src/routes/trade.js` — hoarded-AU lookup**

Before:
```js
        const row = db.prepare(`SELECT id FROM players WHERE name = ? COLLATE NOCASE`).get(me);
```
After:
```js
        const row = playersRepo.getPlayerIdByName(me);
```

- [ ] **Step 6: `src/routes/search.js` — add the import**

Alongside the file's existing `plansRepo`/`systemsRepo` imports:
```js
const playersRepo = require('../repositories/players');
```

- [ ] **Step 7: `src/routes/search.js` — `/search/player`**

Before:
```js
        const query = db.prepare(`
            SELECT p.id, p.name, a.tag as alliance_tag
            FROM players p
            LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE p.name LIKE ? OR CAST(p.id AS TEXT) = ?
            LIMIT 20
        `);

        // Pass the wildcard string for the LIKE, and the raw string for the exact ID match
        const results = query.all(searchTerm, q);
```
After:
```js
        // Pass the wildcard string for the LIKE, and the raw string for the exact ID match
        const results = playersRepo.searchPlayersByNameOrId(searchTerm, q);
```
(The `former` round_players fallback query immediately below stays untouched — its primary FROM
table is `round_players`, out of scope.)

- [ ] **Step 8: `src/routes/incoming.js` — add the import**

```js
const playersRepo = require('../repositories/players');
```
(Note: `systemsRepo` was already added to this file in the first domain plan — reuse that
import, don't duplicate it.)

- [ ] **Step 9: `src/routes/incoming.js` — `getStatsByIds`**

Before:
```js
function getStatsByIds(ids) {
    const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (clean.length === 0) return {};
    const placeholders = clean.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT p.id, p.name, p.level, p.has_intel,
               p.race_speed, p.race_attack, p.race_defense,
               p.physics, p.mathematics, p.energy,
               a.tag AS alliance_tag
        FROM players p
        LEFT JOIN alliances a ON p.alliance_id = a.id
        WHERE p.id IN (${placeholders})
    `).all(...clean);

    const out = {};
```
After:
```js
function getStatsByIds(ids) {
    const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (clean.length === 0) return {};
    const rows = playersRepo.getPlayerStatsByIds(clean);

    const out = {};
```

- [ ] **Step 10: `src/routes/incoming.js` — `attachWinChances`**

Before:
```js
        let enemyRow = null;
        if (data.attacker && data.attacker.id) {
            enemyRow = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE id = ?`).get(data.attacker.id);
        }
        if (!enemyRow && data.attacker && data.attacker.name) {
            enemyRow = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ?`).get(data.attacker.name.toLowerCase());
        }
        const enemyStats = resolveStats(enemyRow);

        const statStmt = db.prepare(`SELECT ${STAT_COLS} FROM players WHERE LOWER(name) = ?`);
        const all = [...result.onTime, ...(result.late || [])];
        for (const d of all) {
            const allyFleet = d.ships || [Math.floor(d.cv / 3), 0, 0];
            const allyRow = statStmt.get(d.name.toLowerCase());
```
After (the local `STAT_COLS` constant at module scope in this file becomes unused by this
function — leave the constant declaration itself in place only if something else in the file
still references it; check with `grep -n "STAT_COLS" src/routes/incoming.js` after this edit and
remove the constant if this was its only use):
```js
        let enemyRow = null;
        if (data.attacker && data.attacker.id) {
            enemyRow = playersRepo.getPlayerCombatStatsById(data.attacker.id);
        }
        if (!enemyRow && data.attacker && data.attacker.name) {
            enemyRow = playersRepo.getPlayerCombatStatsByName(data.attacker.name.toLowerCase());
        }
        const enemyStats = resolveStats(enemyRow);

        const all = [...result.onTime, ...(result.late || [])];
        for (const d of all) {
            const allyFleet = d.ships || [Math.floor(d.cv / 3), 0, 0];
            const allyRow = playersRepo.getPlayerCombatStatsByName(d.name.toLowerCase());
```

- [ ] **Step 11: `src/routes/incoming.js` — `announceIncoming`'s name-based fallback**

Before (inside `async function announceIncoming(data)`, the "Webhook only knows the attacker's
name" fallback):
```js
    let stats = data.attacker.id ? getStatsByIds([data.attacker.id])[data.attacker.id] : null;
    if (!stats) {
        // Webhook only knows the attacker's name — resolve stats by name.
        const row = db.prepare(`
            SELECT p.id, p.name, p.level, p.has_intel, p.race_speed, p.race_attack, p.race_defense,
                   p.physics, p.mathematics, p.energy, a.tag AS alliance_tag
            FROM players p LEFT JOIN alliances a ON p.alliance_id = a.id
            WHERE LOWER(p.name) = ?
        `).get(data.attacker.name.toLowerCase());
        if (row) stats = { ...row, statLine: statLine(row) };
    }
```
After:
```js
    let stats = data.attacker.id ? getStatsByIds([data.attacker.id])[data.attacker.id] : null;
    if (!stats) {
        // Webhook only knows the attacker's name — resolve stats by name.
        const row = playersRepo.getPlayerWithAllianceByNameLower(data.attacker.name.toLowerCase());
        if (row) stats = { ...row, statLine: statLine(row) };
    }
```

- [ ] **Step 12: `src/utils/interceptors.js` — add the import**

```js
const playersRepo = require('../repositories/players');
```
(Note: `systemsRepo`/`fleetsRepo` were already added to this file in the first domain plan —
reuse those, don't duplicate.)

- [ ] **Step 13: `src/utils/interceptors.js` — `computeInterceptors`**

Before:
```js
    const defender = attack.defenderName
        ? db.prepare(`SELECT alliance_id FROM players WHERE name = ? COLLATE NOCASE`).get(attack.defenderName)
        : null;
```
After:
```js
    const defender = attack.defenderName
        ? playersRepo.getPlayerAllianceIdByName(attack.defenderName)
        : null;
```

Before (the `whereClause` const becomes unused by the `homes` query below once that query moves
— check whether anything else in this function still references `whereClause` after this edit;
per the plan's extraction it is used ONLY by the `homes` query, so remove the `whereClause`
declaration entirely once its one use is gone):
```js
    const whereClause = allianceId
        ? `p.alliance_id = @aid`
        : `LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1)`;

    const fleets = allianceId
        ? fleetsRepo.getInterceptFleetsByAlliance(allianceId)
        : fleetsRepo.getInterceptFleetsByActiveUsers();

    const ppPrice = getPpPrice();

    const homes = db.prepare(`
        SELECT p.name AS owner_name, p.energy, p.race_speed, p.economy,
               COALESCE(p.home_planet_index, 1) AS launch_planet,
               ams.production_points, ams.astro_dollars,
               s.x AS sx, s.y AS sy
        FROM players p
        JOIN alliance_member_stats ams ON ams.player_id = p.id
        JOIN systems s ON s.id = COALESCE(p.home_system_id, p.origin_system)
        WHERE ${whereClause} AND s.x IS NOT NULL AND s.y IS NOT NULL
    `).all(allianceId ? { aid: allianceId } : {});
```
After:
```js
    const fleets = allianceId
        ? fleetsRepo.getInterceptFleetsByAlliance(allianceId)
        : fleetsRepo.getInterceptFleetsByActiveUsers();

    const ppPrice = getPpPrice();

    const homes = allianceId
        ? playersRepo.getInterceptHomesByAlliance(allianceId)
        : playersRepo.getInterceptHomesByActiveUsers();
```

- [ ] **Step 14: `src/discord-commands.js` — add the import**

Alongside the file's existing `systemsRepo` import:
```js
const playersRepo = require('./repositories/players');
```

- [ ] **Step 15: `src/discord-commands.js` — `suggestPlayers`**

Before:
```js
        const rows = q
            ? db.prepare(`
                SELECT p.name, a.tag
                FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
                WHERE p.name LIKE ? ORDER BY LENGTH(p.name) ASC LIMIT ?
              `).all(`%${q}%`, MAX_CHOICES)
            : db.prepare(`
                SELECT p.name, a.tag
                FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
                ORDER BY p.points DESC LIMIT ?
              `).all(MAX_CHOICES);
```
After:
```js
        const rows = q
            ? playersRepo.suggestPlayersByQuery(`%${q}%`, MAX_CHOICES)
            : playersRepo.suggestPlayersTopByPoints(MAX_CHOICES);
```

- [ ] **Step 16: Verify no domain call sites were missed in any of the six files**

Run:
```bash
cd /root/awt-test && grep -n "db\.prepare" src/routes/admin.js src/routes/trade.js src/routes/search.js src/routes/incoming.js src/utils/interceptors.js src/discord-commands.js
```
For every match across all six files, read its full SQL text and confirm its primary table is
NOT `players`/`player_logins`. Also confirm `STAT_COLS` (`src/routes/incoming.js:126`, three
uses at lines 136/139/143 before this task's edits) and `whereClause`
(`src/utils/interceptors.js:58`, one use at line 76 before this task's edits) each have zero
remaining uses after Steps 10 and 13 — `grep -n "STAT_COLS" src/routes/incoming.js` and
`grep -n "whereClause" src/utils/interceptors.js` should each return only the declaration line
itself, if not zero lines. Remove both declarations; if a grep unexpectedly returns a use beyond
the declaration, stop and note it in your task report rather than deleting a still-used constant.

- [ ] **Step 17: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
As a regular user: check the trade page's hoarded-AU field save, the player search box, an
incoming-attack alert's cached stats display and win-chance percentages (if one is active), and
any interceptor-eligible alert's defender list. As admin: check `/admin/status` player count and
(carefully) the nuke button if you're comfortable re-seeding afterward.

- [ ] **Step 18: Commit**

```bash
cd /root/awt-test
git add src/routes/admin.js src/routes/trade.js src/routes/search.js src/routes/incoming.js src/utils/interceptors.js src/discord-commands.js
git commit -m "Migrate remaining players/player_logins call sites to the repository layer"
```

---

### Task 6: Full regression pass and close out the domain

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /root/awt-test && npm test`
Expected: all suites pass (including the new `repositories/players.test.js`), exit code 0. If
anything fails, check first whether it's a source-text assertion broken by this domain's
refactor (the same failure mode `round-archive.test.js` hit in the first domain) before assuming
it's a real behavior regression.

- [ ] **Step 2: Confirm zero remaining raw call sites for this domain, codebase-wide — properly this time**

Do NOT rely on a single-line grep (the first domain's final review found it misses multi-line
queries). Instead:
```bash
cd /root/awt-test && grep -rln "players" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js" | grep -v "src/utils/round-archive.js"
```
For every file this lists, read each `db.prepare(...)`/`db.transaction(...)` block's actual SQL
text (not just the grep-matched line) and confirm none of them have `players`/`player_logins` as
their primary `FROM`/`INTO`/`UPDATE`/`DELETE FROM` target. A hit that's only a JOIN against an
already-migrated or not-yet-migrated table is fine to leave; a hit where players/player_logins
IS the primary table is a missed call site — add a step here migrating it before continuing.

- [ ] **Step 3: Final end-to-end pass on `awt-test`**

Run: `pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 30 --nostream`
Expected: clean boot, no errors, Discord bot reconnects. Spend a few minutes clicking through
the hub's player-related pages (War Room, player search, a player's intel panel, the trade page)
and the Discord commands touched in Tasks 3-5 one more time, now that every call site for this
domain has moved.
