# Battle Report Ship Detail (Phase 4 of Game API Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the one thing the `BattleReport/search` API doesn't provide — per-ship-type counts/losses and the win-probability value — via a new page scraper for `/About/BattleReport/{id}`, coordinated across members so it never runs redundantly.

**Architecture:** The existing `battle-sync.js` (30-min periodic pull via the API, already integrated, untouched by this plan) keeps populating `battle_reports` rows with everything the API provides. This plan adds a SEPARATE, independent background sweep that finds rows still missing ship-detail data, claims a small batch (same optimistic-timestamp-claim pattern established in Plan 3 for players — reused here, not reinvented), fetches each report's page HTML through the existing `gameFetch` proxy path (the same "fetch an arbitrary game page, parse its HTML" pattern `player-parser.js`'s `buildSecuredStatsUrl` already uses), and syncs the parsed ship-detail fields back.

**Tech Stack:** Node.js, Express, better-sqlite3, plain browser JS, `DOMParser` for HTML parsing.

**Spec:** `docs/superpowers/specs/2026-08-29-game-api-integration-design.md` (section "4. Battle reports")

## Design correction from the spec (read before starting)

The spec described a once-daily, `app_settings`-based "first logged-in member does it" coordination scheme tied to the game's public battle-report reveal time (00:00 CET). Building that plan revealed a simpler, more consistent design: `battle-sync.js` ALREADY pulls every 30 minutes and already handles "don't double-post to Discord" via its own `announced` flag — there is no need for a second, parallel daily-coordination concept. Instead, this plan reuses Plan 3's established claim pattern (an optimistic `*_scraped_at` timestamp bump) applied per-report rather than per-day: a report either has its ship detail scraped or it doesn't, and "claim" means "mark it scraped now, before actually scraping it" — the same trade-off Plan 3 already made and documented. This is simpler, consistent with the rest of this project, and needs no `app_settings` value or daily-boundary logic at all.

## Global Constraints

- **No behavior change to `battle-sync.js` or the existing `/sync/battle-reports` route.**
  Both are completely untouched by this plan — the ship-detail sweep is a separate,
  independent job operating on rows `battle-sync.js` already created.
- **The claim route must be `POST`, not `GET`** — Plan 3's final review caught a GET route
  that mutated state (bumping a timestamp) and had to fix it to avoid bypassing the
  guest-write gate. Do not repeat that mistake here; the claim route in this plan is `POST`
  from the start.
- **A report's ship-detail claim never needs a staleness re-check, unlike the player
  sweep.** Once a battle report is scraped, its ship-detail data never changes (a battle
  report is a historical, immutable record) — the claim query only needs `ship_detail_scraped_at
  IS NULL`, with no time-window re-offering like Plan 3's player sweep needed.
- **The HTML parsing logic in Task 3 is UNVERIFIED against a live game session** — built
  entirely from a single pasted example page, the same category of uncertainty already
  flagged and accepted in Plans 1-3 (e.g. Plan 3's `IntelligenceReport.race` field names).
  If the real page's markup differs from the example, only Task 3's parsing function needs
  correcting; everything else in this plan (schema, routes, claim/sweep mechanics) is
  independent of the exact selectors used.
- **Every field the API's `BattleReportResponse` already provides must NOT be re-scraped**
  — confirmed in this project's earlier research: `killed_population`, `conquered_planet`,
  `luckiness` (the "Combat Variance" badge), `experiencePointsGained`/`playerLevelGained`
  are already synced via the existing API path. This plan's scraper extracts ONLY the two
  genuinely missing pieces: per-ship-type counts/losses/survivors, and the win-probability
  value.

## File Structure

- Modify: `src/database.js` — 24 ship-type columns + `win_chance` + `ship_detail_scraped_at`
  on `battle_reports`.
- Modify: `src/repositories/battleReports.js` — `getReportsNeedingShipDetail`,
  `markShipDetailScraped`, `updateShipDetail`.
- Modify: `src/repositories/battleReports.test.js` — cover the 3 new functions.
- Modify: `src/routes/sync.js` — `POST /sync/battle-report-ship-detail-claim`, `POST
  /sync/battle-report-ship-detail`.
- Create: `public/js/scrapers/battle-report-parser.js` — the page-HTML parser.
- Create: `public/js/ui/battle-report-detail-sync.js` — the background sweep (mirrors
  `player-api-sync.js`'s shape from Plan 3).
- Modify: `public/js/ui/dashboard.js` — start the new sweep alongside the existing two.

---

### Task 1: Schema — ship-type columns, `win_chance`, `ship_detail_scraped_at`

**Files:**
- Modify: `src/database.js` (right after the `battle_reports` table's closing `` `); ``,
  currently ending `announced INTEGER DEFAULT 0, created_at DATETIME DEFAULT
  CURRENT_TIMESTAMP` — confirmed at that exact location)

**Interfaces:**
- Produces: 24 new INTEGER columns (`att_destroyers`, `att_destroyers_lost`,
  `att_cruisers`, `att_cruisers_lost`, `att_battleships`, `att_battleships_lost`,
  `att_transports`, `att_transports_lost`, `att_colony_ships`, `att_colony_ships_lost`,
  `att_starbases`, `att_starbases_lost`, and the same 12 mirrored with `def_`), plus
  `win_chance` (REAL) and `ship_detail_scraped_at` (DATETIME) — all nullable, all
  consumed by Task 2.

- [ ] **Step 1: Add the migration calls**

Add this block anywhere convenient in `src/database.js` (there is no existing
`addColumn('battle_reports', ...)` block yet — add a new one, e.g. right after the
`battle_reports` table's `` `); ``):

```js
    addColumn('battle_reports', 'att_destroyers', 'INTEGER');
    addColumn('battle_reports', 'att_destroyers_lost', 'INTEGER');
    addColumn('battle_reports', 'att_cruisers', 'INTEGER');
    addColumn('battle_reports', 'att_cruisers_lost', 'INTEGER');
    addColumn('battle_reports', 'att_battleships', 'INTEGER');
    addColumn('battle_reports', 'att_battleships_lost', 'INTEGER');
    addColumn('battle_reports', 'att_transports', 'INTEGER');
    addColumn('battle_reports', 'att_transports_lost', 'INTEGER');
    addColumn('battle_reports', 'att_colony_ships', 'INTEGER');
    addColumn('battle_reports', 'att_colony_ships_lost', 'INTEGER');
    addColumn('battle_reports', 'att_starbases', 'INTEGER');
    addColumn('battle_reports', 'att_starbases_lost', 'INTEGER');
    addColumn('battle_reports', 'def_destroyers', 'INTEGER');
    addColumn('battle_reports', 'def_destroyers_lost', 'INTEGER');
    addColumn('battle_reports', 'def_cruisers', 'INTEGER');
    addColumn('battle_reports', 'def_cruisers_lost', 'INTEGER');
    addColumn('battle_reports', 'def_battleships', 'INTEGER');
    addColumn('battle_reports', 'def_battleships_lost', 'INTEGER');
    addColumn('battle_reports', 'def_transports', 'INTEGER');
    addColumn('battle_reports', 'def_transports_lost', 'INTEGER');
    addColumn('battle_reports', 'def_colony_ships', 'INTEGER');
    addColumn('battle_reports', 'def_colony_ships_lost', 'INTEGER');
    addColumn('battle_reports', 'def_starbases', 'INTEGER');
    addColumn('battle_reports', 'def_starbases_lost', 'INTEGER');
    addColumn('battle_reports', 'win_chance', 'REAL');
    addColumn('battle_reports', 'ship_detail_scraped_at', 'DATETIME');
```

- [ ] **Step 2: Verify the migration runs cleanly**

Run: `AWT_DB_PATH=/tmp/battle-reports-migration-check.db node -e "require('./src/database.js')"`
Expected: 26 `[DB] Added <column> column to battle_reports table.` log lines, no errors. Do
NOT run against the real `awt.db`.

- [ ] **Step 3: Commit**

```bash
git add src/database.js
git commit -m "Add ship-type breakdown, win_chance, and ship_detail_scraped_at columns to battle_reports"
```

---

### Task 2: Extend `src/repositories/battleReports.js`

**Files:**
- Modify: `src/repositories/battleReports.js`
- Modify: `src/repositories/battleReports.test.js`

**Interfaces:**
- Consumes: the 26 new columns from Task 1.
- Produces: `getReportsNeedingShipDetail(limit)` (new, returns an array of ids),
  `markShipDetailScraped(ids)` (new, variable-arity), `updateShipDetail(id, detail)` (new,
  named-parameter object). All three consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `src/repositories/battleReports.test.js` (match its existing `ok()`/`AWT_DB_PATH`
style):

```js
ok('getReportsNeedingShipDetail returns [] when there are no reports', battleReports.getReportsNeedingShipDetail(10).length === 0);

const db = require('../database');
db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (?, ?)`).run(9001, '2026-08-20T10:00:00Z');
db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (?, ?)`).run(9002, '2026-08-25T10:00:00Z');
db.prepare(`INSERT INTO battle_reports (id, started_at) VALUES (?, ?)`).run(9003, '2026-08-15T10:00:00Z');

const needing = battleReports.getReportsNeedingShipDetail(10);
ok('all 3 fresh reports need ship detail', needing.length === 3 && needing.includes(9001) && needing.includes(9002) && needing.includes(9003), needing);
ok('newest report first (started_at DESC)', needing[0] === 9002, needing);

battleReports.markShipDetailScraped([9001, 9003]);
const stillNeeding = battleReports.getReportsNeedingShipDetail(10);
ok('scraped reports are excluded, unscraped one remains', stillNeeding.length === 1 && stillNeeding[0] === 9002, stillNeeding);

battleReports.updateShipDetail(9002, {
    att_destroyers: 100, att_destroyers_lost: 10, att_cruisers: 5, att_cruisers_lost: 1,
    att_battleships: 2, att_battleships_lost: 0, att_transports: 3, att_transports_lost: 3,
    att_colony_ships: 0, att_colony_ships_lost: 0, att_starbases: 0, att_starbases_lost: 0,
    def_destroyers: 50, def_destroyers_lost: 50, def_cruisers: 0, def_cruisers_lost: 0,
    def_battleships: 0, def_battleships_lost: 0, def_transports: 0, def_transports_lost: 0,
    def_colony_ships: 0, def_colony_ships_lost: 0, def_starbases: 1, def_starbases_lost: 1,
    win_chance: 62.5,
});
const updated = db.prepare(`SELECT * FROM battle_reports WHERE id = ?`).get(9002);
ok('updateShipDetail writes the ship-type fields', updated.att_destroyers === 100 && updated.def_starbases_lost === 1 && updated.win_chance === 62.5, updated);
ok('updateShipDetail also marks the report scraped', updated.ship_detail_scraped_at != null, updated);
const noLongerNeeding = battleReports.getReportsNeedingShipDetail(10);
ok('the updated report no longer appears in getReportsNeedingShipDetail', !noLongerNeeding.includes(9002), noLongerNeeding);
```

(Add `const db = require('../database');` once near the top of the test file if not
already present, alongside the existing require of `./battleReports`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node src/repositories/battleReports.test.js`
Expected: FAIL — `getReportsNeedingShipDetail is not a function`.

- [ ] **Step 3: Implement**

Add to `src/repositories/battleReports.js`:

```js
const getReportsNeedingShipDetailStmt = db.prepare(`
    SELECT id FROM battle_reports
    WHERE ship_detail_scraped_at IS NULL
    ORDER BY started_at DESC
    LIMIT ?
`);
function getReportsNeedingShipDetail(limit) {
    return getReportsNeedingShipDetailStmt.all(limit).map(r => r.id);
}

// Arity varies per call (ids length) — prepared fresh each call, same reasoning as
// systems.js's getSystemsByIds / players.js's markPlayersApiScanned.
function markShipDetailScraped(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE battle_reports SET ship_detail_scraped_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
}

const updateShipDetailStmt = db.prepare(`
    UPDATE battle_reports SET
        att_destroyers=@att_destroyers, att_destroyers_lost=@att_destroyers_lost,
        att_cruisers=@att_cruisers, att_cruisers_lost=@att_cruisers_lost,
        att_battleships=@att_battleships, att_battleships_lost=@att_battleships_lost,
        att_transports=@att_transports, att_transports_lost=@att_transports_lost,
        att_colony_ships=@att_colony_ships, att_colony_ships_lost=@att_colony_ships_lost,
        att_starbases=@att_starbases, att_starbases_lost=@att_starbases_lost,
        def_destroyers=@def_destroyers, def_destroyers_lost=@def_destroyers_lost,
        def_cruisers=@def_cruisers, def_cruisers_lost=@def_cruisers_lost,
        def_battleships=@def_battleships, def_battleships_lost=@def_battleships_lost,
        def_transports=@def_transports, def_transports_lost=@def_transports_lost,
        def_colony_ships=@def_colony_ships, def_colony_ships_lost=@def_colony_ships_lost,
        def_starbases=@def_starbases, def_starbases_lost=@def_starbases_lost,
        win_chance=@win_chance,
        ship_detail_scraped_at=CURRENT_TIMESTAMP
    WHERE id=@id
`);
function updateShipDetail(id, detail) {
    updateShipDetailStmt.run({ id, ...detail });
}
```

Note `updateShipDetail` marks the report scraped itself (via `ship_detail_scraped_at =
CURRENT_TIMESTAMP` in the same statement) — a successful detail sync makes a prior
optimistic claim from `markShipDetailScraped` redundant but harmless (both set the same
column to `CURRENT_TIMESTAMP`, whichever runs is fine).

- [ ] **Step 4: Update `module.exports`**

Add `getReportsNeedingShipDetail, markShipDetailScraped, updateShipDetail,` to the
existing `module.exports` list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node src/repositories/battleReports.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/repositories/battleReports.js src/repositories/battleReports.test.js
git commit -m "Add ship-detail claim queue and updater to the battleReports repository"
```

---

### Task 3: Page scraper — `public/js/scrapers/battle-report-parser.js`

**Files:**
- Create: `public/js/scrapers/battle-report-parser.js`

**Interfaces:**
- Consumes: `gameFetch` (from `game-rate-limit.js`, same as the existing
  `buildSecuredStatsUrl`/stats-history fetch pattern in `player-parser.js`).
- Produces: `scrapeBattleReportShipDetail(id)` (new, async, returns the ship-detail object
  shape `updateShipDetail` expects, or `null` on any parse failure) and
  `parseBattleReportHtml(html)` (new, the pure-function parser, exported separately so it
  can be tested against a fixture string without a network call). Consumed by Task 5.

This task has NO automated test in this plan (the parsing logic is unverified against a
live page per this plan's stated design correction) — but Step 1 below still writes ONE
manual smoke check against the exact example HTML this plan was designed from, run
directly with `node`, not part of the `npm test` suite (there is no live game session to
generate a real fixture from).

- [ ] **Step 1: Write the parser**

```js
// Extracts what BattleReport/search's API response does NOT provide from a rendered
// /About/BattleReport/{id} page: per-ship-type counts/losses/survivors and the
// win-probability value. Everything else visible on that page (population change,
// conquered flag, luckiness, XP/level gained) is already covered by the existing API
// integration (src/utils/battle-reports.js) and is deliberately NOT re-extracted here.
//
// UNVERIFIED against a live game session — built from a single pasted example page. If
// the real page's markup differs, only this file needs correcting; nothing else in this
// plan depends on the exact selectors used here.

const SHIP_TYPES = [
    { label: 'Destroyer', col: 'destroyers' },
    { label: 'Cruiser', col: 'cruisers' },
    { label: 'Battleship', col: 'battleships' },
    { label: 'Transport', col: 'transports' },
    { label: 'Colony Ship', col: 'colony_ships' },
    { label: 'Starbase', col: 'starbases' },
];

function parseCount(text) {
    if (typeof text !== 'string') return null;
    const n = parseInt(text.replace(/[,\s]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}

// The battle report table has one row per ship type: [name, def_count, def_lost,
// def_survived, spacer, att_count, att_lost, att_survived]. The Defender/Attacker column
// order is fixed by the page's own header row (Defender's stats always render on the
// left, Attacker's on the right) — confirmed against the one example page this was built
// from, not independently re-verified for every possible battle layout.
function parseBattleReportHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(doc.querySelectorAll('table.table tr'));
    const result = {};
    for (const t of SHIP_TYPES) {
        result[`att_${t.col}`] = null;
        result[`att_${t.col}_lost`] = null;
        result[`def_${t.col}`] = null;
        result[`def_${t.col}_lost`] = null;
    }
    result.win_chance = null;

    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;
        const label = cells[0].textContent.trim();

        const shipType = SHIP_TYPES.find(t => t.label === label);
        if (shipType && cells.length >= 8) {
            result[`def_${shipType.col}`] = parseCount(cells[1].textContent);
            result[`def_${shipType.col}_lost`] = parseCount(cells[2].textContent);
            result[`att_${shipType.col}`] = parseCount(cells[5].textContent);
            result[`att_${shipType.col}_lost`] = parseCount(cells[6].textContent);
            continue;
        }

        if (label === 'Victory' && cells.length >= 5) {
            const span = cells[4].querySelector('span');
            const text = span ? span.textContent.trim() : cells[4].textContent.trim();
            const n = parseFloat(text);
            if (Number.isFinite(n)) result.win_chance = n;
        }
    }
    return result;
}

async function scrapeBattleReportShipDetail(id) {
    const gate = globalThis.AWGameRate;
    if (!gate || typeof gate.gameFetch !== 'function') {
        throw new Error('scrapeBattleReportShipDetail: AWGameRate gate is missing — import game-rate-limit.js first');
    }
    try {
        const res = await gate.gameFetch(`/About/BattleReport/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const html = await res.text();
        return parseBattleReportHtml(html);
    } catch (err) {
        console.warn('[BattleReportParser] fetch/parse failed for report', id, err.message);
        return null;
    }
}

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.BattleReportParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    return { parseBattleReportHtml, scrapeBattleReportShipDetail };
});
```

- [ ] **Step 2: One-off manual smoke check (not part of `npm test`)**

Since `DOMParser` is browser-only and this file has no Node-side test in this plan, verify
`parseBattleReportHtml` manually with a quick script using a browser-like DOM (or, simpler:
temporarily paste the exact example HTML this plan was built from into a local `.html`
file, open it in any browser's console, `fetch` it as text, and call
`BattleReportParser.parseBattleReportHtml(html)` — confirm it returns
`att_destroyers: 47500, att_destroyers_lost: 11838, def_destroyers: 24205,
def_destroyers_lost: 24205, win_chance: 58.57`, matching the example page's actual values).
Record what you tried and the result in your report — this is a one-time sanity check, not
a maintained automated test, given the browser-only `DOMParser` dependency and the absence
of a live fixture.

- [ ] **Step 3: Commit**

```bash
git add public/js/scrapers/battle-report-parser.js
git commit -m "Add battle-report ship-detail page scraper"
```

---

### Task 4: New routes in `src/routes/sync.js`

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `battleReportsRepo.getReportsNeedingShipDetail(limit)`,
  `battleReportsRepo.markShipDetailScraped(ids)`,
  `battleReportsRepo.updateShipDetail(id, detail)` (Task 2).
- Produces: `POST /sync/battle-report-ship-detail-claim` (returns `{success, ids}`), `POST
  /sync/battle-report-ship-detail` (accepts the ship-detail object plus `id`, returns
  `{success}`). Both consumed by Task 5.

- [ ] **Step 1: Add the claim route**

Add anywhere convenient in `sync.js` (e.g. right after the existing `/sync/battle-reports`
route's closing `});`). This file already has `const battleReportsRepo =
require('../repositories/battleReports');` — no new require needed.

```js
// --- BATTLE REPORT SHIP-DETAIL CLAIM ---
// Same optimistic-claim pattern as /sync/player-scan-claim (Plan 3): "claiming" is just
// bumping ship_detail_scraped_at now. A battle report's ship detail never changes once
// scraped (it's an immutable historical record), so unlike the player sweep this needs no
// staleness re-check — a report is either scraped or it isn't.
router.post('/sync/battle-report-ship-detail-claim', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 10, 50);
    const ids = battleReportsRepo.getReportsNeedingShipDetail(limit);
    if (ids.length) battleReportsRepo.markShipDetailScraped(ids);
    res.json({ success: true, ids });
});
```

- [ ] **Step 2: Add the ship-detail receiver route**

```js
// --- BATTLE REPORT SHIP-DETAIL RECEIVER ---
router.post('/sync/battle-report-ship-detail', requireAuth, (req, res) => {
    const { id, ...detail } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    try {
        battleReportsRepo.updateShipDetail(id, detail);
        res.json({ success: true });
    } catch (err) {
        console.error(`[DB Error] Failed to sync battle report ship detail ${id}:`, err.message);
        res.status(500).json({ error: 'Database sync failed' });
    }
});
```

- [ ] **Step 3: Add both new paths to `guest-role.test.js`'s `writePaths`**

Both are `POST` write routes — append `/sync/battle-report-ship-detail-claim` and
`/sync/battle-report-ship-detail` to the END of the `writePaths` array in
`src/utils/guest-role.test.js` (not the middle — that file has a `writePaths.slice(0, 6)`
elsewhere whose meaning would change if new entries were inserted before index 6; append
at the end, matching how Plans 2 and 3 both extended this same array).

- [ ] **Step 4: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass, including `utils/guest-role.test.js` with both new paths
correctly guest-blocked.

- [ ] **Step 5: Commit**

```bash
git add src/routes/sync.js src/utils/guest-role.test.js
git commit -m "Add battle-report ship-detail claim and receiver sync routes"
```

---

### Task 5: Background sweep — `public/js/ui/battle-report-detail-sync.js`

**Files:**
- Create: `public/js/ui/battle-report-detail-sync.js`
- Modify: `public/js/ui/dashboard.js`

**Interfaces:**
- Consumes: `BattleReportParser.scrapeBattleReportShipDetail(id)` (Task 3), `POST
  /hub-api/sync/battle-report-ship-detail-claim`, `POST
  /hub-api/sync/battle-report-ship-detail` (Task 4).

This task has no automated test, consistent with `battle-sync.js`/`player-api-sync.js`'s
own precedent. Verify per Step 3 below.

- [ ] **Step 1: Write the module**

```js
// Battle-report ship-detail background sweep — wrapper realm only, mirrors
// player-api-sync.js's sweep half (Plan 3) almost exactly: claim a small batch of
// not-yet-scraped reports, scrape each one's page, sync the result back.
//
// Runs independently of battle-sync.js (which populates battle_reports rows from the API
// on its own 30-min clock) — this sweep only ever touches rows that already exist,
// filling in the one thing the API doesn't provide.

import '../utils/game-rate-limit.js'; // must load before either gameFetch or aw-api resolves the gate
import './battle-report-parser.js';

const { scrapeBattleReportShipDetail } = globalThis.BattleReportParser;

const SWEEP_INTERVAL_MS = 90 * 1000; // slower than the player sweep — battle reports are much lower volume
const SWEEP_LOCK_KEY = 'awt.battleReportDetailSync.lock.v1';
const SWEEP_LOCK_TTL_MS = 80 * 1000; // shorter than the interval
const SWEEP_BATCH_SIZE = 5; // battle-report pages are heavier fetches than a player profile; keep batches small

function claimLock(key, ttlMs) {
    try {
        const raw = localStorage.getItem(key);
        const now = Date.now();
        if (raw && now - parseInt(raw, 10) < ttlMs) return false;
        localStorage.setItem(key, String(now));
        return true;
    } catch (err) {
        return true; // no localStorage — degrade to "always run", same fallback philosophy as game-rate-limit.js
    }
}

let sweeping = false;

async function runSweepTick() {
    if (sweeping) return; // in-tab re-entrancy guard — a slow tick must not stack (see Plan 3's fix for the same class of bug)
    if (!claimLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)) return; // cross-tab guard
    sweeping = true;
    try {
        const claimRes = await fetch('/hub-api/sync/battle-report-ship-detail-claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: SWEEP_BATCH_SIZE }),
        });
        if (!claimRes.ok) { console.warn('[BattleReportDetailSync] claim failed:', claimRes.status); return; }
        const claimed = await claimRes.json().catch(() => ({}));
        if (!claimed.success) { console.warn('[BattleReportDetailSync] claim response not successful:', claimed); return; }
        const ids = Array.isArray(claimed.ids) ? claimed.ids : [];

        for (const id of ids) {
            const detail = await scrapeBattleReportShipDetail(id);
            if (!detail) continue; // scrape/parse failed — report stays claimed (already scraped=now), acceptable data gap, not retried
            const syncRes = await fetch('/hub-api/sync/battle-report-ship-detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...detail }),
            });
            if (!syncRes.ok) { console.warn('[BattleReportDetailSync] sync failed for report', id, syncRes.status); continue; }
            const syncBody = await syncRes.json().catch(() => ({}));
            if (!syncBody.success) console.warn('[BattleReportDetailSync] sync response not successful for report', id, syncBody);
        }
    } catch (err) {
        console.warn('[BattleReportDetailSync] sweep tick failed:', err.message);
    } finally {
        sweeping = false;
    }
}

let started = false;
export function initBattleReportDetailSync() {
    if (started) return;
    started = true;
    setInterval(runSweepTick, SWEEP_INTERVAL_MS);
}
```

Note the accepted trade-off in the `if (!detail) continue;` line: a report whose scrape or
parse fails stays marked `ship_detail_scraped_at` (set by the claim route BEFORE the
scrape attempt) and is never retried. This mirrors Plan 3's identical accepted trade-off
for the optimistic player-scan claim — a failed attempt just leaves that one report
missing its ship-detail data permanently rather than being retried, which is an acceptable
gap for enrichment data (unlike the player sweep, there's no later opportunity for this
data to become available some other way, but a single permanently-missing ship-detail
row is low-stakes compared to building real retry infrastructure for it).

- [ ] **Step 2: Wire it into `dashboard.js`**

Add right after the existing `player-api-sync.js` import block (from Plan 3), matching the
exact same on-demand-load pattern:

```js
    // Background battle-report ship-detail sweep. Same on-demand-load pattern as the
    // other two background sync modules above.
    import('./battle-report-detail-sync.js')
        .then(({ initBattleReportDetailSync }) => initBattleReportDetailSync())
        .catch(err => console.warn('[BattleReportDetailSync] failed to start:', err));
```

(Find the exact insertion point by locating Plan 3's `player-api-sync.js` import block in
the current file and adding this immediately after it — do not reorder the existing
`battle-sync.js`/`player-api-sync.js` import blocks.)

- [ ] **Step 3: Confirm syntax and manual verification (deferred, same as prior plans)**

Run `node --input-type=module --check < public/js/ui/battle-report-detail-sync.js` and
confirm no syntax errors. Live end-to-end verification (does the sweep actually claim,
scrape, and sync correctly against a real game session) requires a real logged-in game
session, not available today — deferred, same accepted gap as every UI task in this
project so far.

- [ ] **Step 4: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add public/js/ui/battle-report-detail-sync.js public/js/ui/dashboard.js
git commit -m "Add background battle-report ship-detail sweep"
```

---

## Self-Review Notes

- **Spec coverage, with the documented design correction:** the spec's daily-coordinated-pull
  concept is replaced by reusing Plan 3's simpler optimistic-claim pattern, applied
  per-report instead of per-day — documented upfront as a design correction, not a silent
  deviation. The ship-type breakdown and win-probability scraping requirements are both
  covered (Task 3); everything the API already provides is explicitly NOT re-scraped
  (confirmed against the earlier BattleReportResponse schema comparison already on record
  in this project).
- **Type consistency check:** `updateShipDetail(id, detail)`'s named-SQL-parameter keys
  (`@att_destroyers`, `@att_destroyers_lost`, ... `@win_chance`) match exactly what
  `parseBattleReportHtml` produces (Task 3) and what `battle-report-detail-sync.js` spreads
  into its POST body (Task 5) — all three list the same 25 keys (24 ship-type fields +
  `win_chance`), verified side-by-side while writing this plan.
- **Flagged uncertainty, not silently assumed:** Task 3's entire parsing approach is
  explicitly marked unverified against a live page, with a one-time manual smoke-check
  step (not a maintained automated test) as the only verification available without a real
  game session — consistent with how this project has handled every other spec-derived,
  never-independently-confirmed piece of the game's API/page surface so far.
- **No claims-table, no app_settings, no daily-boundary logic** — this plan is
  deliberately simpler than the original spec section for this phase, and the reasoning is
  recorded above rather than left implicit.
