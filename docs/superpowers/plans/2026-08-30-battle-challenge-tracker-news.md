# Battle Challenge Tracker — News-Page Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the population-kill and conquest events that never generate a `battle_reports` row (undefended-planet bombardment and conquest) by scraping each member's own `/Game/News` feed, and feed genuine walkovers into the population leaderboard built in the core plan.

**Architecture:** A client-side content script (mirroring the existing `public/js/ui/news-incoming.js` News-page enhancer) parses conquest/bombardment rows out of the DOM, walks backward through pagination only as far as needed, and POSTs structured entries to a new `/sync/news` route. The server resolves the scraping member's player id from their session, decides (via a small pure helper) who earns population credit for a bombardment row, cross-references `battle_reports` by player pair + time proximity to avoid double-counting a real fight, and stores everything in a new `news_events` table. `battlePoints.getPopLeaderboard` (from the core plan) is extended to union in unmatched bombardment rows.

**Tech Stack:** Node.js, Express, better-sqlite3, vanilla browser DOM APIs (no new client dependency).

**Spec:** `docs/superpowers/specs/2026-08-30-battle-challenge-tracker-design.md` (section 3, and its "Matching rule (correction from an earlier draft)" note)

**Depends on:** `docs/superpowers/plans/2026-08-30-battle-challenge-tracker-core.md` (must be implemented first — this plan extends `src/repositories/battlePoints.js` from Task 1 of that plan).

## Global Constraints

- `battle_reports` has **no planet or system column** — matching a News entry against it uses player pair (`att_player_id`/`def_player_id`) + `started_at` within **±15 minutes** of the News entry's `occurred_at`, never a planet id.
- `battle-conquer`/`battle-conquered` rows never carry an opponent id and can never match a real battle report by the rule above — they are always walkovers, stored for future announcement use only, and never scored.
- `battle-bombarded` rows carry two wordings depending on which side the scraping player was on (`"You lost N population..."` = defender, `"You killed N population..."` = attacker-side wording, **not yet confirmed against a real example** — the client parser must key off the words "killed"/"lost" next to "population", not an exact sentence, precisely because that wording is unconfirmed). Population is always credited to the attacker.
- Dedup key: `(player_id, game_planet_id, message_type, occurred_at)`, enforced by a `UNIQUE` constraint + `INSERT OR IGNORE` — never a pre-check `SELECT` then `INSERT`.
- Pagination walks backward from page 1, stopping when the current page's oldest entry is at or before the player's stored watermark (`players.last_news_scraped_at`), when there's no next-page link, or after 20 pages — whichever comes first.
- Every network call in the client script is best-effort: a failed fetch/POST silently stops that visit's walk (never throws into the page) and is retried on the member's next News-page visit.
- Test files use the project's plain-Node harness (`ok(desc, cond)`), a fresh temp SQLite DB per file via `AWT_DB_PATH`, discovered automatically by `src/utils/run-tests.js`. Client-side DOM-parsing code (`public/js/ui/*.js`) has no existing automated test coverage anywhere in this codebase (confirmed: `news-incoming.js` has none) — this plan matches that precedent and verifies the new client script manually instead of inventing a new jsdom-based test pattern for one file.

---

### Task 1: `news_events` table, `players.last_news_scraped_at`, and the `newsEvents` repository

**Files:**
- Modify: `src/database.js`
- Modify: `src/routes/admin.js` (round-wipe transaction)
- Create: `src/repositories/newsEvents.js`
- Test: `src/repositories/newsEvents.test.js`

**Interfaces:**
- Consumes: `db` from `../database`.
- Produces: `module.exports = { insertNewsEvent, getWatermark, advanceWatermark, deleteAllNewsEvents }`.
  - `insertNewsEvent(entry)`: `(object) => boolean` (`true` if a new row was actually inserted, `false` if it was a duplicate). `entry` shape: `{ player_id, message_type, occurred_at, game_planet_id, system_id, other_player_id, population_delta, credited_player_id, matched_battle_report_id }` (all but the first three may be `null`/absent).
  - `getWatermark(playerId)`: `(number) => string|null`.
  - `advanceWatermark(playerId, isoTimestamp)`: `(number, string) => void` — only moves forward, never backward.
  - `deleteAllNewsEvents()`: `() => number` (rows deleted).

- [ ] **Step 1: Write the failing test**

Create `src/repositories/newsEvents.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const newsEvents = require('./newsEvents');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('newsEvents.test.js');

db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Alice'), (2, 'Bob')`).run();

ok('getWatermark returns null before any scrape', newsEvents.getWatermark(1) === null);

const entry1 = {
    player_id: 1, message_type: 'battle-conquer', occurred_at: '2026-08-24T20:54:00Z',
    game_planet_id: 13456, system_id: 5, other_player_id: null, population_delta: null,
    credited_player_id: null, matched_battle_report_id: null,
};
ok('first insert of a new event returns true', newsEvents.insertNewsEvent(entry1) === true);
ok('inserting the exact same event again is ignored (dedup) and returns false',
    newsEvents.insertNewsEvent(entry1) === false);

const row = db.prepare(`SELECT * FROM news_events WHERE player_id = 1`).get();
ok('the stored row has the right message_type', row.message_type === 'battle-conquer', row);
ok('the stored row has the right game_planet_id', row.game_planet_id === 13456, row);

// A different game_planet_id at the same timestamp is a DIFFERENT event (dedup key includes it)
const entry2 = { ...entry1, game_planet_id: 99999 };
ok('a different game_planet_id at the same timestamp is a distinct row', newsEvents.insertNewsEvent(entry2) === true);

newsEvents.advanceWatermark(1, '2026-08-24T20:54:00Z');
ok('watermark advances to the timestamp given', newsEvents.getWatermark(1) === '2026-08-24T20:54:00Z');

newsEvents.advanceWatermark(1, '2026-08-20T00:00:00Z'); // older — must NOT move it backward
ok('watermark never regresses to an earlier timestamp', newsEvents.getWatermark(1) === '2026-08-24T20:54:00Z');

newsEvents.advanceWatermark(1, '2026-08-25T00:00:00Z'); // newer — must advance
ok('watermark advances to a later timestamp', newsEvents.getWatermark(1) === '2026-08-25T00:00:00Z');

ok('a second player still has no watermark', newsEvents.getWatermark(2) === null);

const deletedCount = newsEvents.deleteAllNewsEvents();
ok('deleteAllNewsEvents returns the count deleted', deletedCount === 2, deletedCount);
ok('the table is empty afterward', db.prepare(`SELECT COUNT(*) AS n FROM news_events`).get().n === 0);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/repositories/newsEvents.test.js`
Expected: FAIL — `no such table: news_events` (or `Cannot find module './newsEvents'`)

- [ ] **Step 3: Add the schema**

In `src/database.js`, find the line `addColumn('players', 'last_api_scan_at', 'DATETIME');` (around line 157) and add immediately after it:

```js
    addColumn('players', 'last_news_scraped_at', 'DATETIME');
```

Then find the ship-detail `addColumn('battle_reports', 'ship_detail_scraped_at', 'DATETIME');` line (around line 694) and add immediately after it:

```js

    // --- NEWS-PAGE INGESTION ---
    // Populated by each member's own /Game/News feed (client-side scrape, POSTed through
    // /sync/news). Exists because an undefended-planet conquest or bombardment produces no
    // battle_reports row at all — see docs/superpowers/specs/2026-08-30-battle-challenge-
    // tracker-design.md section 3 for why. Describes events on the map being wiped, so it
    // goes with the round wipe exactly like battle_reports (see src/routes/admin.js).
    db.exec(`
        CREATE TABLE IF NOT EXISTS news_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            message_type TEXT NOT NULL,
            occurred_at DATETIME NOT NULL,
            game_planet_id INTEGER,
            system_id INTEGER,
            other_player_id INTEGER,
            population_delta INTEGER,
            credited_player_id INTEGER,
            matched_battle_report_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(player_id, game_planet_id, message_type, occurred_at),
            FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
            FOREIGN KEY(other_player_id) REFERENCES players(id) ON DELETE SET NULL,
            FOREIGN KEY(matched_battle_report_id) REFERENCES battle_reports(id) ON DELETE SET NULL
        )
    `);
```

Then find the index-creation block:

```js
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_battle_reports_started ON battle_reports(started_at);
        CREATE INDEX IF NOT EXISTS idx_starbase_audit_actor   ON starbase_order_audit(actor_user_id);
    `);
```

and replace it with:

```js
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_battle_reports_started ON battle_reports(started_at);
        CREATE INDEX IF NOT EXISTS idx_starbase_audit_actor   ON starbase_order_audit(actor_user_id);
        CREATE INDEX IF NOT EXISTS idx_news_events_credited   ON news_events(credited_player_id, occurred_at);
    `);
```

- [ ] **Step 4: Write the repository**

Create `src/repositories/newsEvents.js`:

```js
const db = require('../database');

const insertNewsEventStmt = db.prepare(`
    INSERT OR IGNORE INTO news_events (
        player_id, message_type, occurred_at, game_planet_id, system_id,
        other_player_id, population_delta, credited_player_id, matched_battle_report_id
    ) VALUES (
        @player_id, @message_type, @occurred_at, @game_planet_id, @system_id,
        @other_player_id, @population_delta, @credited_player_id, @matched_battle_report_id
    )
`);
function insertNewsEvent(entry) {
    return insertNewsEventStmt.run({
        player_id: entry.player_id,
        message_type: entry.message_type,
        occurred_at: entry.occurred_at,
        game_planet_id: entry.game_planet_id ?? null,
        system_id: entry.system_id ?? null,
        other_player_id: entry.other_player_id ?? null,
        population_delta: entry.population_delta ?? null,
        credited_player_id: entry.credited_player_id ?? null,
        matched_battle_report_id: entry.matched_battle_report_id ?? null,
    }).changes > 0;
}

const getWatermarkStmt = db.prepare(`SELECT last_news_scraped_at FROM players WHERE id = ?`);
function getWatermark(playerId) {
    const row = getWatermarkStmt.get(playerId);
    return row ? row.last_news_scraped_at : null;
}

// Only ever moves forward — a page fetched out of order, or a duplicate visit, must
// never regress a player's watermark back in time.
const advanceWatermarkStmt = db.prepare(`
    UPDATE players
    SET last_news_scraped_at = CASE
        WHEN last_news_scraped_at IS NULL OR @ts > last_news_scraped_at THEN @ts
        ELSE last_news_scraped_at
    END
    WHERE id = @id
`);
function advanceWatermark(playerId, isoTimestamp) {
    advanceWatermarkStmt.run({ id: playerId, ts: isoTimestamp });
}

const deleteAllNewsEventsStmt = db.prepare(`DELETE FROM news_events`);
function deleteAllNewsEvents() {
    return deleteAllNewsEventsStmt.run().changes;
}

module.exports = { insertNewsEvent, getWatermark, advanceWatermark, deleteAllNewsEvents };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node src/repositories/newsEvents.test.js`
Expected: `All checks passed`

- [ ] **Step 6: Wire the round wipe**

In `src/routes/admin.js`, find:

```js
            // Battle reports describe battles on the map being wiped — they go with it.
            // starbase_order_audit is deliberately NOT here: it is an operations record
            // of who sent what through the hub, and that stays true across rounds.
            battleReportsRepo.deleteAllBattleReports();
```

Replace with:

```js
            // Battle reports describe battles on the map being wiped — they go with it.
            // News events are the same kind of record (walkover conquests/bombardments on
            // the same wiped map). starbase_order_audit is deliberately NOT here: it is an
            // operations record of who sent what through the hub, and that stays true
            // across rounds.
            battleReportsRepo.deleteAllBattleReports();
            newsEventsRepo.deleteAllNewsEvents();
```

Then, near the top of the same file, find the existing `const battleReportsRepo = require('../repositories/battleReports');` line and add immediately after it:

```js
const newsEventsRepo = require('../repositories/newsEvents');
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all suites pass, including the new `newsEvents.test.js`.

- [ ] **Step 8: Commit**

```bash
git add src/database.js src/routes/admin.js src/repositories/newsEvents.js src/repositories/newsEvents.test.js
git commit -m "Add news_events table, watermark column, and newsEvents repository"
```

---

### Task 2: Cross-reference helper — `battleReportsRepo.findByPlayerPairNear`

**Files:**
- Modify: `src/repositories/battleReports.js`
- Modify: `src/repositories/battleReports.test.js`

**Interfaces:**
- Consumes: `db` from `../database` (existing).
- Produces: `findByPlayerPairNear(playerA, playerB, occurredAtIso, windowMinutes)`: `(number, number, string, number) => number|null` — the matching `battle_reports.id`, or `null` if none exists within the window. Added to this file's existing `module.exports` object.

- [ ] **Step 1: Write the failing test**

In `src/repositories/battleReports.test.js`, immediately before the final `fs.rmSync(...)` line, add:

```js
// --- findByPlayerPairNear ---
db.prepare(`INSERT INTO battle_reports (id, started_at, att_player_id, def_player_id) VALUES (?, ?, ?, ?)`)
    .run(9101, '2026-08-24T10:00:00Z', 1, 2);

ok('finds a match with the pair in (att, def) order, within the window',
    battleReports.findByPlayerPairNear(1, 2, '2026-08-24T10:10:00Z', 15) === 9101);
ok('finds a match with the pair reversed (def, att) — direction does not matter',
    battleReports.findByPlayerPairNear(2, 1, '2026-08-24T10:10:00Z', 15) === 9101);
ok('no match when the timestamp is outside the window',
    battleReports.findByPlayerPairNear(1, 2, '2026-08-24T11:00:00Z', 15) === null);
ok('no match for a different player pair entirely',
    battleReports.findByPlayerPairNear(1, 3, '2026-08-24T10:10:00Z', 15) === null);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/repositories/battleReports.test.js`
Expected: FAIL — `battleReports.findByPlayerPairNear is not a function`

- [ ] **Step 3: Add the implementation**

In `src/repositories/battleReports.js`, add before the final `module.exports = { ... };`:

```js
// News-page events carry no planet reference (battle_reports has no planet/system column
// at all) — matching is by player pair + time proximity instead. Direction doesn't matter:
// either player could be attacker or defender in the stored report.
function findByPlayerPairNear(playerA, playerB, occurredAtIso, windowMinutes) {
    const center = new Date(occurredAtIso).getTime();
    const from = new Date(center - windowMinutes * 60000).toISOString();
    const to = new Date(center + windowMinutes * 60000).toISOString();
    const row = db.prepare(`
        SELECT id FROM battle_reports
        WHERE ((att_player_id = @a AND def_player_id = @b) OR (att_player_id = @b AND def_player_id = @a))
          AND started_at BETWEEN @from AND @to
        LIMIT 1
    `).get({ a: playerA, b: playerB, from, to });
    return row ? row.id : null;
}
```

And update the `module.exports` object to include it:

```js
module.exports = {
    deleteAllBattleReports,
    getPendingAnnouncements,
    markAnnounced,
    getNewestStartedAt,
    getReportsNeedingShipDetail,
    markShipDetailScraped,
    updateShipDetail,
    findByPlayerPairNear,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node src/repositories/battleReports.test.js`
Expected: `All checks passed`

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/battleReports.js src/repositories/battleReports.test.js
git commit -m "Add findByPlayerPairNear: match News-page events against battle_reports"
```

---

### Task 3: Bombardment-credit decision helper + `/sync/news` and `/sync/news-watermark` routes

**Files:**
- Create: `src/utils/news-battle-matching.js`
- Test: `src/utils/news-battle-matching.test.js`
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `battleReportsRepo.findByPlayerPairNear` (Task 2); `newsEventsRepo.insertNewsEvent`/`getWatermark`/`advanceWatermark` (Task 1); `playersRepo.getPlayerIdByName` (existing, already imported in `sync.js`).
- Produces: `resolveBombardmentCredit(entry, scrapingPlayerId)`: `({other_player_id, direction}, number) => {credited_player_id: number, otherPlayerId: number}|null` (`null` when `other_player_id` is missing). Used only inside `sync.js`'s new route — not consumed by any later task.

- [ ] **Step 1: Write the failing test**

Create `src/utils/news-battle-matching.test.js`:

```js
const { resolveBombardmentCredit } = require('./news-battle-matching');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('news-battle-matching.test.js');

ok('direction "killed" credits the scraping player (they were the attacker)',
    JSON.stringify(resolveBombardmentCredit({ other_player_id: 99, direction: 'killed' }, 1)) ===
    JSON.stringify({ credited_player_id: 1, otherPlayerId: 99 }));

ok('direction "lost" credits the other player (the scraping player was the defender)',
    JSON.stringify(resolveBombardmentCredit({ other_player_id: 99, direction: 'lost' }, 1)) ===
    JSON.stringify({ credited_player_id: 99, otherPlayerId: 1 }));

ok('no other_player_id means no credit can be resolved',
    resolveBombardmentCredit({ other_player_id: null, direction: 'killed' }, 1) === null);

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/utils/news-battle-matching.test.js`
Expected: FAIL — `Cannot find module './news-battle-matching'`

- [ ] **Step 3: Write the implementation**

Create `src/utils/news-battle-matching.js`:

```js
// Decides who earns population credit for one battle-bombarded News entry. Population is
// always credited to the attacker: if the scraping player's own row says "You killed N
// population" they were the attacker (credit themselves); if it says "You lost N
// population" they were the defender (credit the other player named in the row).
function resolveBombardmentCredit(entry, scrapingPlayerId) {
    if (!entry.other_player_id) return null;
    const credited_player_id = entry.direction === 'killed' ? scrapingPlayerId : entry.other_player_id;
    const otherPlayerId = credited_player_id === scrapingPlayerId ? entry.other_player_id : scrapingPlayerId;
    return { credited_player_id, otherPlayerId };
}

module.exports = { resolveBombardmentCredit };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node src/utils/news-battle-matching.test.js`
Expected: `All checks passed`

- [ ] **Step 5: Add the routes**

In `src/routes/sync.js`, add near the top, after the existing `const battleReportsRepo = require('../repositories/battleReports');` line:

```js
const newsEventsRepo = require('../repositories/newsEvents');
const { resolveBombardmentCredit } = require('../utils/news-battle-matching');
```

Then, anywhere after the router is created (a sensible spot is right after the existing `/sync/battle-report-ship-detail` route, at the end of the file before `module.exports = router;`), add:

```js
// --- NEWS-PAGE WATERMARK (for the client's pagination-walk stop condition) ---
router.get('/sync/news-watermark', requireAuth, (req, res) => {
    const playerId = playersRepo.getPlayerIdByName(req.session.gameName || '');
    if (!playerId) return res.json({ watermark: null });
    res.json({ watermark: newsEventsRepo.getWatermark(playerId) });
});

// --- NEWS-PAGE EVENT RECEIVER ---
// Body: { entries: [{ message_type, occurred_at, game_planet_id, system_id,
// other_player_id, population_delta, direction }] }. Parsing lives entirely on the
// client (public/js/ui/news-battle-events.js reading the member's own /Game/News page);
// this route only resolves crediting/matching and stores the result. `direction`
// ('killed'|'lost') only matters for battle-bombarded rows.
router.post('/sync/news', requireAuth, (req, res) => {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: 'Invalid payload' });

    const playerId = playersRepo.getPlayerIdByName(req.session.gameName || '');
    if (!playerId) return res.status(400).json({ error: 'Session player not recognized' });

    let inserted = 0;
    let maxOccurredAt = null;

    for (const raw of entries) {
        if (!raw || !raw.message_type || !raw.occurred_at) continue;
        if (maxOccurredAt === null || raw.occurred_at > maxOccurredAt) maxOccurredAt = raw.occurred_at;

        let credited_player_id = null;
        let matched_battle_report_id = null;

        if (raw.message_type === 'battle-bombarded') {
            const credit = resolveBombardmentCredit(raw, playerId);
            if (credit) {
                credited_player_id = credit.credited_player_id;
                matched_battle_report_id = battleReportsRepo.findByPlayerPairNear(
                    credit.credited_player_id, credit.otherPlayerId, raw.occurred_at, 15
                );
            }
        }

        const wasInserted = newsEventsRepo.insertNewsEvent({
            player_id: playerId,
            message_type: raw.message_type,
            occurred_at: raw.occurred_at,
            game_planet_id: raw.game_planet_id || null,
            system_id: raw.system_id || null,
            other_player_id: raw.other_player_id || null,
            population_delta: raw.population_delta || null,
            credited_player_id,
            matched_battle_report_id,
        });
        if (wasInserted) inserted++;
    }

    if (maxOccurredAt) newsEventsRepo.advanceWatermark(playerId, maxOccurredAt);

    res.json({ success: true, inserted });
});
```

- [ ] **Step 6: Verify the module loads cleanly**

Run: `node -e "require('./src/routes/sync.js'); console.log('module loads cleanly');"`
Expected: prints `module loads cleanly` with no thrown error.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all suites pass, including the new `news-battle-matching.test.js`.

- [ ] **Step 8: Commit**

```bash
git add src/utils/news-battle-matching.js src/utils/news-battle-matching.test.js src/routes/sync.js
git commit -m "Add /sync/news and /sync/news-watermark routes"
```

---

### Task 4: Extend `battlePoints.getPopLeaderboard` to include unmatched bombardments

**Files:**
- Modify: `src/repositories/battlePoints.js`
- Modify: `src/repositories/battlePoints.test.js`

**Interfaces:**
- Consumes: `news_events` table (Task 1); `players.alliance_id` / `alliances.tag` (existing schema).
- Produces: `getPopLeaderboard`'s return shape is unchanged (`Array<{player_id, player_name, raw, points}>`) — this task only changes what feeds into it. `getCvLeaderboard`'s behavior and callers are unaffected.

- [ ] **Step 1: Write the failing test**

In `src/repositories/battlePoints.test.js`, immediately before the final `fs.rmSync(...)` line, add:

```js
// --- News-page bombardment credit (unmatched only — see the "no battle_reports link"
// case vs. the "already covered by a real battle report" case) ---
db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (10, 'Gina', NULL), (11, 'Hank', NULL)`).run();

db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (10, 'battle-bombarded', '2026-08-05T00:00:00Z', 10, 400, NULL)
`).run();
// This one IS matched to a real battle report — must be excluded from the sum (that
// battle report's own killed_population already counts it, via the existing battle_reports path).
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (11, 'battle-bombarded', '2026-08-05T00:00:00Z', 11, 999, 1)
`).run();
// A conquest event never contributes points regardless of credited_player_id.
db.prepare(`
    INSERT INTO news_events (player_id, message_type, occurred_at, credited_player_id, population_delta, matched_battle_report_id)
    VALUES (10, 'battle-conquer', '2026-08-06T00:00:00Z', 10, NULL, NULL)
`).run();

const boardsWithNews = battlePoints.getLeaderboards(null, 10);
const gina = boardsWithNews.pop.find(r => r.player_name === 'Gina');
ok('Gina gets population points from her unmatched bombardment (400)', gina && gina.raw === 400, gina);
ok('Hank never appears — his bombardment is already covered by a real battle report',
    !boardsWithNews.pop.some(r => r.player_name === 'Hank'), boardsWithNews.pop);

ok('cv leaderboard is unaffected by news_events (still only Alice/Bob/Frank from battle_reports)',
    boardsWithNews.cv.length === 3, boardsWithNews.cv);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/repositories/battlePoints.test.js`
Expected: FAIL — Gina's `raw` is `undefined` (she does not appear in `boardsWithNews.pop` yet)

- [ ] **Step 3: Update the implementation**

In `src/repositories/battlePoints.js`, replace the `exclusionClause` function with a more general version that accepts which column expressions to compare (so it can be reused against `news_events`'s joined alliance tags, not just `battle_reports`'s own columns):

```js
// Friendly fire (both sides share an alliance tag) is always excluded. An admin-configured
// excluded-alliance-tag list is layered on top when non-empty. `attTagExpr`/`defTagExpr`
// are raw SQL column/expression text (never user input) so this same logic works whether
// the caller is querying battle_reports directly or a news_events join. Returns the SQL
// fragment and the positional params it needs, in the exact order its `?` placeholders
// appear — callers must not reorder params relative to where this clause lands.
function exclusionClauseFor(attTagExpr, defTagExpr, excludedTags) {
    let clause = `NOT (${attTagExpr} IS NOT NULL AND ${defTagExpr} IS NOT NULL AND UPPER(${attTagExpr}) = UPPER(${defTagExpr}))`;
    const params = [];
    if (excludedTags.length > 0) {
        const attPh = excludedTags.map(() => '?').join(',');
        const defPh = excludedTags.map(() => '?').join(',');
        clause += ` AND (${attTagExpr} IS NULL OR UPPER(${attTagExpr}) NOT IN (${attPh}))`;
        clause += ` AND (${defTagExpr} IS NULL OR UPPER(${defTagExpr}) NOT IN (${defPh}))`;
        params.push(...excludedTags, ...excludedTags);
    }
    return { clause, params };
}
```

Update `getCvLeaderboard`'s call site (it is unaffected in behavior, just the call
signature changes). The line `const { clause, params } = exclusionClause(getExcludedAllianceTags());`
appears **twice** in this file (once in `getCvLeaderboard`, once in the `getPopLeaderboard`
you are about to replace wholesale in the next step) — edit only the one inside
`getCvLeaderboard` (the one immediately followed by `const sinceSql = sinceIso ? ... `
and then the `SELECT player_id, player_name, SUM(cv_credit) AS raw_cv` query). Change it to:

```js
    const { clause, params } = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', getExcludedAllianceTags());
```

Then replace the whole `getPopLeaderboard` function (its own, now-stale copy of that line
disappears as part of this wholesale replacement) with:

```js
// Population is only ever credited to the attacker (the side whose fleet bombed the
// target planet) — see the design spec §1/§3 for why the defender never earns pop points.
// Two sources are unioned: real battle_reports rows, and News-page bombardments that have
// NO matching battle_reports row (a matched one is already covered by the battle report
// itself, so it is excluded here to avoid double-counting). News-page rows carry no
// alliance-tag columns of their own, so exclusions are applied via a join to players'
// CURRENT alliance — a known simplification (not the alliance at the time of the event).
function getPopLeaderboard(sinceIso, limit) {
    const excludedTags = getExcludedAllianceTags();

    const br = exclusionClauseFor('att_alliance_tag', 'def_alliance_tag', excludedTags);
    const brSinceSql = sinceIso ? `AND started_at >= ?` : '';
    const brWherePart = `${brSinceSql} AND ${br.clause}`;
    const brParams = sinceIso ? [sinceIso, ...br.params] : [...br.params];

    const ne = exclusionClauseFor('ca.tag', 'oa.tag', excludedTags);
    const neSinceSql = sinceIso ? `AND ne.occurred_at >= ?` : '';
    const neWherePart = `${neSinceSql} AND ${ne.clause}`;
    const neParams = sinceIso ? [sinceIso, ...ne.params] : [...ne.params];

    const sql = `
        SELECT player_id, player_name, SUM(pop_credit) AS raw_pop
        FROM (
            SELECT att_player_id AS player_id, att_player_name AS player_name, killed_population AS pop_credit
            FROM battle_reports
            WHERE att_player_id IS NOT NULL ${brWherePart}

            UNION ALL

            SELECT ne.credited_player_id AS player_id, cp.name AS player_name, ne.population_delta AS pop_credit
            FROM news_events ne
            JOIN players cp ON cp.id = ne.credited_player_id
            LEFT JOIN players op ON op.id = ne.other_player_id
            LEFT JOIN alliances ca ON ca.id = cp.alliance_id
            LEFT JOIN alliances oa ON oa.id = op.alliance_id
            WHERE ne.message_type = 'battle-bombarded'
              AND ne.matched_battle_report_id IS NULL
              AND ne.credited_player_id IS NOT NULL
              ${neWherePart}
        )
        GROUP BY player_id
        ORDER BY raw_pop DESC
        LIMIT ?
    `;
    const ratio = getPopRatio();
    return db.prepare(sql).all(...brParams, ...neParams, limit).map(r => ({
        player_id: r.player_id,
        player_name: r.player_name,
        raw: r.raw_pop || 0,
        points: toPoints(r.raw_pop || 0, ratio),
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node src/repositories/battlePoints.test.js`
Expected: `All checks passed`

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/battlePoints.js src/repositories/battlePoints.test.js
git commit -m "Include unmatched News-page bombardments in the population leaderboard"
```

---

### Task 5: Client-side News-page scraper

**Files:**
- Create: `public/js/ui/news-battle-events.js`
- Modify: `public/js/core/spy.js`

**Interfaces:**
- Consumes: `globalThis.AWGameRate.gameFetch` (existing, from `../utils/game-rate-limit.js`), same import pattern as `news-incoming.js`; `/hub-api/sync/news-watermark` and `/hub-api/sync/news` (Task 3).
- Produces: `initNewsBattleEvents()` — exported, called from `spy.js`'s existing `/game/news` gate. Nothing else consumes it.

There is no automated test for this task — see the Global Constraints note: no client-side DOM-parsing file in this codebase has one today, and this plan does not introduce a new test pattern for a single file. Verification is manual (Step 4 below).

- [ ] **Step 1: Write the module**

Create `public/js/ui/news-battle-events.js`:

```js
// News-page battle/conquest completeness scraper.
// Runs inside the proxied game page (same origin as the hub) whenever a member visits
// their own /Game/News feed. Captures the two kinds of event that NEVER produce a
// battle_reports row — an undefended-planet conquest, and bombardment of a planet with no
// defending fleet — and POSTs them to the hub so the population leaderboard and future
// conquest announcements stay complete. See docs/superpowers/specs/2026-08-30-battle-
// challenge-tracker-design.md section 3 for the full design.
import '../utils/game-rate-limit.js';
const { gameFetch } = globalThis.AWGameRate;

const MAX_PAGES_PER_VISIT = 20;
const NEWS_TYPES = ['battle-conquer', 'battle-conquered', 'battle-bombarded'];

function idFromHref(href) {
    if (!href) return null;
    const n = parseInt(href.split('/').pop(), 10);
    return Number.isInteger(n) ? n : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "20:54:00 - Aug 24" -> an ISO timestamp. The News page never includes a year, so this
// resolves against `now`'s year, rolling back one year if that would land in the future
// (the feed only ever shows events that already happened).
function parseNewsTimestamp(rawText, now) {
    const m = rawText.trim().match(/(\d{2}):(\d{2}):(\d{2})\s*-\s*(\w{3})\s+(\d{1,2})/);
    if (!m) return null;
    const [, hh, mm, ss, monStr, day] = m;
    const month = MONTHS.indexOf(monStr);
    if (month === -1) return null;
    const year = now.getFullYear();
    let candidate = new Date(year, month, parseInt(day, 10), parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10));
    if (candidate.getTime() > now.getTime() + 60000) {
        candidate = new Date(year - 1, month, parseInt(day, 10), parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10));
    }
    return candidate.toISOString();
}

function bodyDivFor(tr) {
    return tr.querySelector('td.black.text-left div, td.text-left div');
}

function parseConquestRow(tr) {
    const div = bodyDivFor(tr);
    if (!div) return null;
    const sysLink = div.querySelector('a[href*="/SolarSystem/"]');
    const planetLink = div.querySelector('a[href*="/Planets/Planet/"]');
    return {
        game_planet_id: idFromHref(planetLink && planetLink.getAttribute('href')),
        system_id: idFromHref(sysLink && sysLink.getAttribute('href')),
        other_player_id: null,
        population_delta: null,
        direction: null,
    };
}

// Wording for the "you were the attacker" case is not yet confirmed against a real
// example (see the design spec) — this deliberately keys off "killed"/"lost" next to
// "population" rather than one exact sentence, so it survives that uncertainty.
function parseBombardmentRow(tr) {
    const div = bodyDivFor(tr);
    if (!div) return null;
    const text = div.innerText || div.textContent || '';
    const popMatch = text.match(/(killed|lost)\s+([\d,.\s]+)\s+population/i);
    if (!popMatch) return null;

    const sysLink = div.querySelector('a[href*="/SolarSystem/"]');
    const planetLink = div.querySelector('a[href*="/Planets/Planet/"]');
    const profileLink = div.querySelector('a[href*="/Players/Profile/"]');

    return {
        game_planet_id: idFromHref(planetLink && planetLink.getAttribute('href')),
        system_id: idFromHref(sysLink && sysLink.getAttribute('href')),
        other_player_id: idFromHref(profileLink && profileLink.getAttribute('href')),
        population_delta: parseInt(popMatch[2].replace(/[,.\s]/g, ''), 10) || 0,
        direction: popMatch[1].toLowerCase() === 'killed' ? 'killed' : 'lost',
    };
}

// Rows are newest-first on each page (standard for this feed), so the LAST entry
// collected here is the oldest on the page — used by the caller to decide whether to
// walk to the next page.
function collectEntriesFromDoc(doc, now) {
    const entries = [];
    doc.querySelectorAll('tr').forEach(tr => {
        const msgCell = tr.querySelector(NEWS_TYPES.map(t => `td.msg.${t}`).join(', '));
        if (!msgCell || tr.getAttribute('data-aw-newsbattle') === '1') return;

        const type = NEWS_TYPES.find(t => msgCell.classList.contains(t));
        const timeText = (msgCell.textContent || '').trim().split('\n')[0].trim();
        const occurred_at = parseNewsTimestamp(timeText, now);
        if (!occurred_at) return;

        const parsed = type === 'battle-bombarded' ? parseBombardmentRow(tr) : parseConquestRow(tr);
        if (!parsed) return;

        tr.setAttribute('data-aw-newsbattle', '1');
        entries.push({ message_type: type, occurred_at, ...parsed });
    });
    return entries;
}

async function postEntries(entries) {
    if (!entries.length) return true;
    try {
        const res = await fetch('/hub-api/sync/news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
        });
        return res.ok;
    } catch (err) {
        return false;
    }
}

async function fetchWatermark() {
    try {
        const res = await fetch('/hub-api/sync/news-watermark');
        if (!res.ok) return null;
        return (await res.json()).watermark;
    } catch (err) {
        return null;
    }
}

async function walkFromPage(doc, pageNumber, watermark, now) {
    const entries = collectEntriesFromDoc(doc, now);
    const posted = await postEntries(entries);
    if (!posted) return; // best-effort: retried on the member's next visit

    const oldestOnPage = entries.length ? entries[entries.length - 1].occurred_at : null;
    const caughtUp = watermark && oldestOnPage && oldestOnPage <= watermark;
    if (caughtUp || pageNumber >= MAX_PAGES_PER_VISIT) return;

    const nextLink = doc.querySelector(`a[href*="pageNumber=${pageNumber + 1}"]`);
    if (!nextLink) return;

    let nextDoc;
    try {
        const res = await gameFetch(nextLink.getAttribute('href'));
        const html = await res.text();
        nextDoc = new DOMParser().parseFromString(html, 'text/html');
    } catch (err) {
        return;
    }

    await walkFromPage(nextDoc, pageNumber + 1, watermark, now);
}

export async function initNewsBattleEvents() {
    if (!window.location.pathname.toLowerCase().startsWith('/game/news')) return;

    const watermark = await fetchWatermark();
    await walkFromPage(document, 1, watermark, new Date());
}
```

- [ ] **Step 2: Wire it into the News-page view hook**

In `public/js/core/spy.js`, find the import line:

```js
import { initNewsIncomingTools } from '../ui/news-incoming.js';
```

Add immediately after it:

```js
import { initNewsBattleEvents } from '../ui/news-battle-events.js';
```

Then find:

```js
            if (pathLower.includes('/game/news')) {
                initAllianceNewsAlerts();
                initNewsIncomingTools();
            }
```

Replace with:

```js
            if (pathLower.includes('/game/news')) {
                initAllianceNewsAlerts();
                initNewsIncomingTools();
                initNewsBattleEvents().catch(err => console.error('[News] battle-events scrape failed:', err.message));
            }
```

- [ ] **Step 3: Verify the module has no syntax errors**

Run: `node --check public/js/ui/news-battle-events.js`
Expected: no output, exit code 0 (this only checks JS syntax — the ES module `import`/DOM APIs are browser-only and are not executed by this check).

- [ ] **Step 4: Manual verification**

Since this module has no automated test (see the Global Constraints note), verify manually on the live/test hub after deploying:
1. Log in as a member with at least one recent conquest or bombardment in their `/Game/News` feed.
2. Open `/Game/News` (via the hub's proxy) and open the browser devtools Network tab.
3. Confirm a request to `/hub-api/sync/news-watermark` fires, followed by one or more `/hub-api/sync/news` POSTs.
4. Query the database directly (`sqlite3 <db path> "SELECT * FROM news_events"`) and confirm the rows match what's visible on the News page (correct `message_type`, plausible `occurred_at`, `game_planet_id` matching the planet named in the row).
5. Revisit the same News page a second time and confirm no new rows are inserted for events already seen (dedup working) and that no unnecessary extra pages were fetched (watermark stopping the walk correctly).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites still pass (this task touches no `src/` file with existing test coverage other than the syntax check above).

- [ ] **Step 6: Commit**

```bash
git add public/js/ui/news-battle-events.js public/js/core/spy.js
git commit -m "Add client-side News-page scraper for walkover conquests and bombardments"
```

---

## End of Plan 2

At this point: undefended-planet bombardments that never generate a `battle_reports` row now contribute to the population leaderboard, conquest walkovers are recorded (ready for a future announcement feature, out of scope here per spec §6), and the whole News-page ingestion pipeline is idempotent and self-limiting (bounded pagination, dedup by unique constraint, watermark that never regresses). Both plans together fully implement the approved design spec.
