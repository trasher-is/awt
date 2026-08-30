# Battle Challenge Tracker — Design Spec

**Status:** Approved by user, pending final spec review before handoff to `writing-plans`.
**Branch:** `battle-challenge-tracker` (worktree `/root/awt-battles`, forked from `main`)

## 1. Purpose

An internal alliance leaderboard ("battles" feature) that tracks two independent
point categories — **CV killed** and **population killed** — from real combat
data already captured in `battle_reports`, plus a small set of population-kill
and conquest events that only ever appear on the in-game `/Game/News` page and
never generate a `battle_reports` row at all (undefended-planet bombardment and
conquest). Results are queryable on demand via Discord text commands and posted
automatically twice a day. This repo is public and forked by other alliances,
so every new integration (second Discord bot, News-page ingestion) must be
optional and gracefully degrade when unconfigured — mirroring the existing
`DISCORD_TOKEN` pattern exactly.

## 2. Scoring

Two categories, never summed:

- **CV points** = opponent's `lost_cv` (from `battle_reports`, whichever side
  didn't lose) ÷ `battle_points_cv_ratio`.
- **Population points** = population killed (from `battle_reports.killed_population`,
  or from a News-page bombardment entry with no matching battle report — see
  §3) ÷ `battle_points_pop_ratio`.

Both ratios live in `app_settings` (new keys `battle_points_cv_ratio` and
`battle_points_pop_ratio`, via the existing `getSetting`/`setSetting` in
`src/repositories/settings.js`), admin-adjustable, not hardcoded. Defaults:
`1000` (CV) and `100` (population) — illustrative starting points, expected to
be tuned after the first week of real data.

Credit attribution: for a `battle_reports` row, the winning side is credited
with the losing side's `lost_cv` and (if `conquered_planet` is not itself the
cause) `killed_population`. Conquest alone carries no CV/population numbers
and is never a scoring input — it only feeds the announcement feed (§4).

**Exclusions**, applied as a query-time filter over `battle_reports` /
`news_events` — never by mutating or deleting the underlying rows, so the
filter is fully reversible if the rules change later:

- **Friendly fire**: a battle where `att_alliance_tag` equals `def_alliance_tag`
  is excluded entirely.
- **Excluded alliance tags**: a new `app_settings` key
  `battle_points_excluded_alliance_tags` (comma-separated tag list). A battle
  where either side's alliance tag is in this list is excluded entirely.

Both checks are pure functions over already-stored columns, so they compose
directly into the leaderboard SQL query (a `WHERE` clause), not a
pre-processing pass.

## 3. News-page ingestion (walkover + bombardment completeness)

**Why this exists:** an undefended-planet conquest or bombardment involves no
real combat, so no `battle_reports` row is ever created for it. The only place
these events are visible at all is a player's own `/Game/News` feed
(`filter=my`). This section is a data-completeness layer, not a replacement
for `battle_reports` — anything with a matching battle report is left to that
existing pipeline.

### 3.1 Data source and trigger

Ingestion is **opportunistic**: whenever a logged-in alliance member's browser
loads `/Game/News`, the page is scraped client-side (new content script,
alongside the existing `public/js/ui/news-incoming.js` News-page enhancer) and
POSTed to a new endpoint, `POST /sync/news`, following the same
externally-triggered pattern as every other `/sync/*` route in
`src/routes/sync.js` (no server-side cron or scheduler exists in this codebase
today — see `sync.js`'s comment precedent for `players.last_api_scan_at` and
`battle_reports.ship_detail_scraped_at`, both optimistic claims rather than
locked reservations).

The client script parses each `<tr>` row into a structured entry (type,
timestamp, planet id, system id, other-player name/id if present, population
numbers if present, battle-report id if a link is present) before POSTing —
consistent with this codebase's existing convention of parsing on the client
and sending structured JSON to `/sync/*` routes.

### 3.2 Pagination

A player's News feed can run to 100+ entries across many pages, and the total
page count isn't discoverable from the markup (no fixed max, just prev/next
links plus a page-number strip). The client walks forward from page 1 and
stops when either:

- the oldest entry on the current page is **older** than that player's stored
  watermark (`players.last_news_scraped_at`, new `DATETIME` column, added the
  same way as the existing `last_api_scan_at`), or
- there is no next-page link.

A hard cap (20 pages) per single visit guards against a pathological backlog
hanging one request; if the cap is hit, the watermark still advances to the
oldest entry actually processed, and the remaining backlog is picked up on the
member's next News-page visit.

### 3.3 Message types handled

**Matching rule (correction from an earlier draft):** `battle_reports` carries
no planet or system column at all — only `att_player_id`/`def_player_id` and
`started_at`. So a News entry is matched against `battle_reports` by **player
pair + time proximity**, not by planet: does a row exist where
`(att_player_id, def_player_id)` equals `(scraping player, other player)` in
either order, with `started_at` within ±15 minutes of the News entry's
`occurred_at`? The other player's id comes directly from the profile link in
the News row's HTML (`/Game/Players/Profile/{id}`).

- `battle-conquer` / `battle-conquered` — no CV/population numbers, and no
  other-player link either (conquering an undefended planet has no opponent to
  name). These can never match a `battle_reports` row by the rule above — a
  conquest with a real fight behind it always shows up as `battle-lost` (with
  a battle-report link) on one side or an ordinary win on the other, never as
  `battle-conquer`/`battle-conquered` itself. So these two types are *always*
  treated as walkovers and stored for the announcement feed only; they never
  need a cross-reference lookup.
- `battle-bombarded` — two mirrored wordings depending on which side the
  scraping player was on: *"You lost N population..."* (defender) or *"You
  killed N population..."* (attacker). The other player's id (attacker or
  defender counterpart) comes from the profile link in the row, so this type
  IS checked against `battle_reports` by the player-pair + time-proximity rule
  above. If no match exists, the population number **is** counted toward the
  population leaderboard, credited to the attacker. If a match exists, the
  battle report's own `killed_population` already covers it — the News entry
  is stored (for audit/completeness) but excluded from the point sum.
- All other message types (`player-incoming`, etc.) are ignored by this
  feature — already handled elsewhere (`news-incoming.js`, `webhook.js`).

### 3.4 Storage

New table `news_events`:

```sql
CREATE TABLE IF NOT EXISTS news_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    message_type TEXT NOT NULL,
    occurred_at DATETIME NOT NULL,
    game_planet_id INTEGER,
    system_id INTEGER,
    other_player_id INTEGER,
    population_delta INTEGER,
    matched_battle_report_id INTEGER,
    counted_for_points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, game_planet_id, message_type, occurred_at),
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY(matched_battle_report_id) REFERENCES battle_reports(id) ON DELETE SET NULL
)
```

The `UNIQUE` constraint is the dedup mechanism (`INSERT OR IGNORE`), keyed on
`(player_id, game_planet_id, message_type, occurred_at)`. The News page omits
the year in its timestamps (`HH:MM:SS - Mon DD`); the client resolves it
against the current date, rolling back one year if the parsed month/day would
otherwise fall in the future.

New repository module `src/repositories/newsEvents.js`, mirroring
`battleReports.js`'s pattern (module-level prepared statements, plain exported
functions, paired smoke test): `insertNewsEvent`, `getWatermark(playerId)` /
`updatePlayerWatermark`, `getUnpointedBombardments(since)`, and whatever the
leaderboard query needs to aggregate `news_events` alongside `battle_reports`.

## 4. Second Discord bot (generic, optional)

New env var `BATTLE_DISCORD_TOKEN`, documented in `.env.example` with the same
"optional, empty by default" convention as `DISCORD_TOKEN`. A second `Client`
instance is created and gated identically to the existing pattern at
`src/discord_bot.js:1451`:

```js
function initBattleDiscordBot(token) {
    if (!token) {
        console.log('[Discord] No BATTLE_DISCORD_TOKEN found in environment. Battle bot disabled.');
        return null;
    }
    battleClient.login(token).catch(err => {
        console.error('[Discord] Failed to connect (battle bot):', err.message);
    });
    return battleClient;
}
```

Any code that posts a battle/leaderboard message resolves which client to use
in this order: battle bot if configured → main bot if configured → no-op (log
only). This is a single shared helper (e.g. `getBattlePostingClient()`), not
duplicated at each call site.

## 5. Discord commands and automated posts

Three text commands, added to the existing `handleMessage` dispatch chain in
`src/discord_bot.js` (same `if (command === 'xxx') { ... }` pattern as the
existing `!getid` handler), each producing two leaderboard blocks (CV points,
population points) in one message:

- `!mortal` — totals for the current round.
- `!mortalday` — today only (local day boundary).
- `!mortalweek` — trailing 7 days.

**Automated posts:** once after the first `/sync/*` battle-report ingestion
following local midnight picks up new data, and again ~12 hours later. Since
no scheduler exists anywhere in this codebase (confirmed: the only
`setInterval` in the app is the Discord bot's unrelated 60-second reminder
tick), this needs a new, minimal trigger. Given the existing
externally-triggered design (nothing runs server-side on a timer), the
simplest fit is: after any `/sync/battle-report*` route finishes ingesting new
rows, check an `app_settings` key (`battle_points_last_auto_post_at`) and post
if enough real time has passed since the last post AND it's been long enough
since local midnight — an opportunistic check piggybacking on existing sync
traffic, not a new always-running timer, consistent with how every other
scheduled-feeling behavior in this app actually works (driven by client
requests, not server cron).

## 6. Out of scope

- A "conquests" leaderboard/points category — not requested; conquest News
  entries feed the announcement feed only.
- Retroactive backfill of News-page history predating this feature.
- Any change to the existing `battle_reports` scraping/ingestion pipeline.
