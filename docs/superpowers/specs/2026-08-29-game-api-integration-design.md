# Game REST API Integration (Phase 2): design

## Context

The hub already integrates two of the game's official REST API (`/api/v1/*`) endpoints:
`SolarSystem`/`SolarSystem/{id}/planets` (feeds `/sync/system`) and `BattleReport/search`
(feeds `/sync/battle-reports`, built earlier in this project's database refactor). Two more
endpoints are deliberately excluded from this project: `Fleet/travelTime` and
`Starbase/orders/{id}/geometry` (both already wired up, both serve the separate "redzone"
tool, not needed here). `POST /Map/settings` (a UI display preference, not game data) is
also excluded.

This design covers wiring up the remaining endpoints — `Player`, `Player/{id}`,
`Player/search`, `Alliance/search`, `SolarSystem/search`, `Map/sectors` — alongside the
existing scraping pipeline, as a **mixed system**: the API supplements scraping with data
scraping never captured, and lets the hub discover/verify things scraping alone misses or
gets wrong (map regions nobody manually scanned, players nobody profile-scraped yet).
Scraping is not being replaced — several fields (home planet, infrastructure counts, eco
bonus, CV limit/used, idle time) only ever come from scraping, and remain the primary
source for existing intel-derived fields.

Two related but independent needs surfaced during design and are captured here too:
**within-round player alias tracking** (a player restarting mid-round keeps their ID but
changes name — round-archive.js only captures name history across a full round wipe, not a
mid-round restart) and the **rate/budget model** the game's API imposes, which is stricter
than the hub's existing network-level rate gate.

Explicitly out of scope for this design (raised during brainstorming, deliberately deferred
or rejected):
- A full application rewrite — rejected; revisit in ~3 months if still a concern.
- Renaming existing DB columns to match the API's field-naming convention — rejected, no
  functional benefit, high blast radius.
- The alliance CV/population-kill challenge leaderboard — flagged as real, upcoming work,
  but explicitly deferred (no battles expected in week 1 of the new round regardless). The
  data it will need (`killed_population`, `conquered_planet`) already exists in
  `battle_reports` from the existing integration.
- Cross-account alias tracking (a player abandoning an account and registering a new one
  with a different ID) — not solvable from data alone; explicitly left as a manual/social
  process, not automated.

## Timeline context

A new game round starts the day after this design was written; the alliance's members
begin actively logging in and playing a few days after that (Tuesday). The systems seed
(section 3) is the one piece worth having ready for round-start, since the map is smallest
and most valuable to seed fresh at that point. Everything else in this design can land
incrementally over the following days without day-one pressure.

## Shared building blocks

These three patterns are used by every phase below; each phase's implementation plan will
reference them rather than re-derive them.

### Mapper pattern

Each new data source gets its own `mapXApi(apiObject)` function — same shape as the
existing `src/utils/battle-reports.js`'s `mapApiReport()` — converting the API's JSON shape
into the DB row shape. Kept separate from whatever shape a scraper's own POST payload uses;
one sync route never needs to understand two different payload shapes.

### Intel-preservation merge rule (universal — applies to scraping AND the API alike)

Any intel-sourced column follows one of two rules, regardless of which source (scraping or
the API's `intelligenceReport`) is currently writing it:

- **`race_growth`, `race_science`, `race_culture`, `race_production`, `race_speed`,
  `race_attack`, `race_defense`, `race_trader`, `race_sul`** — write-once-per-round. A
  player's race never changes within a round (only on resign+restart, which starts a new
  round for that player's data in practice). Once a value is set (non-NULL), a later write
  must never overwrite it, even if the new source disagrees — the existing value stands
  until an actual restart is detected (out of scope to detect automatically; treat these
  columns as effectively immutable once set within a round).
- **`biology`, `economy`, `energy`, `mathematics`, `physics`, `social`, `artefact`,
  `trade_revenue`** — update whenever the current pull has visibility (has_intel true from
  scraping, or the API's `intelligenceReport` is non-null), but must never be nulled out or
  cleared just because the CURRENT pull lacks visibility. A previously-known value that
  goes temporarily invisible (e.g. the target's biology closes the gap past the ~6-level
  intel-visibility threshold) stays exactly as last recorded, not wiped to NULL and not
  treated as unknown.

This generalizes a principle already established earlier in this project (the
player-restart-reset fix that stopped wiping intel-derived columns) into an explicit,
universal rule that every new write path in this design must follow.

### Distributed claim mechanism

Two features below (player-detail scanning, the daily battle-report pull) need multiple
members' browsers to split up work without duplicating effort — but NOT because of a shared
budget (the game's per-endpoint call budget is per-account, not global; see below), only to
avoid two different members redundantly doing the same work in the same short window.

Mechanism: a short-TTL "claim" recorded server-side (in the database, since it must survive
across different people's browsers, unlike the existing `battle-sync.js` localStorage lock
which only coordinates multiple tabs of the SAME person). A claim older than its TTL is
treated as abandoned (e.g. a closed tab) and up for grabs again. Two concrete uses:

- **Battle-report daily pull** (section 5): a single claim per calendar day, stored in
  `app_settings` (`last_battlereport_pull_date`).
- **Player-detail scan queue** (section 4): a claim per batch of player IDs, TTL ~2 minutes,
  so an abandoned batch is picked up by someone else quickly rather than stalling the whole
  sweep.

### The game API's rate/budget model

Distinct from the hub's existing `game-rate-limit.js` (a 5-requests/second network-level
gate, enforced per browser profile across all `/api/v1/*` traffic regardless of endpoint),
the game itself additionally enforces a **200-calls-per-5-minutes budget, per logged-in
account**, specific to the REST API. This is the actually-binding constraint for anything
that makes many API calls (bulk player scanning in particular) — the 5/s network gate is
rarely what limits you; the 200/5min account budget is.

Design decision: reserve part of that budget for "important sudden things" (e.g. a member
manually looking something up) rather than letting background bulk work (the player-detail
scan) consume the whole 200. Starting point: **150 of 200 usable for background work, 50
reserved**, stored as a tunable value (in `app_settings`, following the existing
`settingsRepo` pattern) rather than hardcoded — the exact split is expected to need tuning
once real usage is observed, and changing a setting must not require a deploy.

Because the budget is per-account, not global, there is no need for a server-side "global
budget tracker" — each member's browser tracks and respects its own local budget
independently (same pattern as the existing client-side rate gate), and the claim mechanism
above only prevents duplicate work, not budget overrun.

## Schema

New columns/tables, by area (all additive — no column removals, no renames, per the "keep
DB as-is" decision):

### `systems`
- `full_name` TEXT
- `info` TEXT
- `population_level` INTEGER
- `is_in_vision` INTEGER (from the API's per-system `isInVision` — whether this was live
  data or the game's cached out-of-vision snapshot at capture time)
- reuse existing `updated_at` for the API's `capturedAt` semantics — no separate column
  needed, since both mean "when was this last confirmed."

### `planets`
- `name` TEXT (planets currently have no name column at all — scraping never captured it,
  the API always provides it)

No `is_unknown_owner` column. Checked the existing `/sync/system` route (`src/routes/sync.js`):
`isUnknownOwner`/`is_unknown` is already a well-established concept there, but it is
deliberately NEVER persisted as its own column — it is a payload-only fog-of-war guard that
decides whether to overwrite `owner_id`/`population` or preserve the previously-known
values (`systemsRepo.getOldPlanet`/`upsertPlanet`). The `Map/sectors` ingestion reuses this
exact same guard, not a new persisted flag — consistent with how `SolarSystem/{id}/planets`
already handles the identical field.

Explicitly NOT adding a `starbase_orders` column — the API's `StarbaseOrder` schema turned
out to be just `{id, canBeChanged}`, no actionable data worth persisting.

### `alliances`
- `full_name` TEXT
- `member_count` INTEGER

### `players`

Corrected against the actual current schema (base `CREATE TABLE` plus every `addColumn`
migration in `src/database.js`) — two of the fields originally listed as new already exist
under different names, both added via earlier scrape-driven `addColumn` migrations:

- `joined` (TEXT, already exists) — reuse for the API's `joinedAt`. The API's ISO timestamp
  is strictly more precise than whatever the profile-page scrape produces; write it
  whenever the API provides it, overwriting the scraped value (a join date never changes,
  so there's no conflict to resolve — just take the better value).
- `logins` (INTEGER, already exists) — reuse for the API's `numberOfLogins`. Same reasoning:
  take the API's count whenever available.
- `eco_bonus` (INTEGER, already exists, the scraped bonus *percentage*) — the API's
  `hasEcoBonus` is a boolean flag, not a magnitude. Rather than add a redundant column,
  derive "has an eco bonus" from `eco_bonus > 0` / `eco_bonus IS NOT NULL` in application
  code wherever it's needed. No new column for this.

Genuinely new columns (nothing existing covers these):
- `is_active_player` INTEGER
- `last_activity_at` DATETIME — distinct from the existing `idle_time` (a scrape-time
  snapshot duration string, stale the moment it's read); this is an absolute timestamp from
  the API, self-refreshing in meaning regardless of when it's read. Both columns are kept;
  `idle_time` is untouched.
- `last_login_at` DATETIME — distinct from `last_activity_at` (the API exposes both
  separately; a player can be logged in but idle, or vice versa)
- `resigned_at` DATETIME
- `number_of_battles` INTEGER
- `battle_luckiness` REAL
- `multi_status` TEXT
- `is_top_permanent_ranker` INTEGER
- `has_supporter_badge` INTEGER
- `supporter_type` TEXT

### `player_name_history` (new table)
```sql
CREATE TABLE IF NOT EXISTS player_name_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    old_name TEXT NOT NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
)
```
Populated by a new `recordNameChangeIfDifferent(id, newName)`-style function in the players
repository, called from EVERY write path that sets `players.name` (both the existing
scraping-driven sync and the new API-driven player sync) — compares the incoming name
against the currently-stored name for that ID, and if different and a prior name existed,
inserts a row here BEFORE overwriting `players.name`. This is a within-round complement to
`round-archive.js`'s existing across-round alias tracking (`previousNames`/
`findByFormerName`/`searchFormerNamesWithCurrentPlayer`) — that mechanism is unaffected and
stays exactly as it is; together the two give full alias history whether a name changed via
a same-round restart or a round-to-round wipe.

### `battle_reports` (new columns for the ship-detail scraper, section 5)
- `att_destroyers`, `att_destroyers_lost`, `att_cruisers`, `att_cruisers_lost`,
  `att_battleships`, `att_battleships_lost`, `att_transports`, `att_transports_lost`,
  `att_colony_ships`, `att_colony_ships_lost`, `att_starbases`, `att_starbases_lost`
  (all INTEGER)
- same 12 columns mirrored with `def_` prefix
- `win_chance` REAL (the dice-vs-chance value shown on the report page, e.g. 58.57)

## 1. Systems — `Map/sectors` seed

One `GET /Map/sectors` call covering the map's known bounds with a safety margin — bounds
have never exceeded roughly `-32,-32` to `32,32` across the game's history so far, though
that could grow with a larger player base; pad generously (e.g. `-40,-40` to `40,40`) since
over-fetching costs nothing extra (one call regardless of area, within reason for payload
size). NOT a strict one-time action — the map grows in a (somewhat random) spiral as the
round progresses, so this needs to be safely re-runnable (idempotent upsert, keyed by
system id) to pick up newly-created regions later, triggered manually (an admin/dashboard
action) rather than automatically, since it should only run occasionally.

Ingestion: one call returns potentially thousands of systems/planets in a single JSON
response (observed ~1.2MB for a 60×60 area) — parsing and inserting this is well within
what a single batched `db.transaction(...)` can handle in well under a second; no need to
split into multiple smaller area calls (that would only cost more of the call budget for no
performance benefit).

## 2. Alliances & system search

`Alliance/search` and `SolarSystem/search`: manual lookup only, following the existing
`system-intel.js` refresh-button pattern (API call → mapper → sync route → re-render from
the hub's own DB, never rendering raw API data straight into the UI — matching every
existing API-integration call site's established convention).

## 3. Players

### `ListPlayer` bulk pull (automatic, cadence changes over the round's life)

Periodic pull of the full active-player list (same "always call it, get a fresh list"
intent as the current ranking-page ID-harvest, but genuinely cheap since it's one API call
rather than N profile scrapes). Cadence is NOT fixed — most members join a few days into a
round (waiting for a better starting location), so activity/discovery matters most early:

- First ~2 weeks of a round: every 5 minutes.
- After 2 weeks: every 6 hours.

The switch point is time-since-round-start, not a fixed calendar cadence — needs a
reference point for "when did this round start" (the `rounds` table's `archived_at` marks
the END of the PREVIOUS round, which is a reasonable proxy for "this round started around
then," or a dedicated marker could be added — implementation detail for the plan).

### `Player/{id}` detail scan (background, budget- and claim-coordinated)

A slow sweep across the whole known roster, prioritized by staleness (least-recently-
scanned player first), feeding the ~13 new columns above (activity/status/supporter fields
— none of which scraping ever captured). Coordinated via the claim mechanism (section
"Shared building blocks") so multiple members' browsers split the roster without
duplicating work; each browser respects its own local 150-of-200 budget independently.

### Within-round name-change tracking

See `player_name_history` under Schema above. Every write to `players.name` — scraping or
API-driven — checks for a change and logs it first.

## 4. Battle reports

### Daily coordinated pull

Battle reports go public each day at 00:00 CET. A `last_battlereport_pull_date` claim in
`app_settings`: whichever member's browser is first to check in after 00:01 CET and finds
today unclaimed does the `BattleDateFrom`-filtered API pull for the previous day (the
existing `getNewestStartedAt()`-as-cursor pattern already partially does this via
`battle-sync.js`'s periodic poll — this adds the once-daily, date-bounded, single-claimant
variant specifically so the new per-report page scrape below doesn't run redundantly across
every member's open dashboard), then marks the day done.

### New per-report page scraper

Targets `/About/BattleReport/{id}` (confirmed: no scraper for this page exists anywhere
today). Extracts only what the API's `BattleReportResponse`/`BattleParticipantResponse`
schemas don't already provide — confirmed by direct schema comparison against a real report
page:
- Per-ship-type counts, losses, and survivors (Destroyer/Cruiser/Battleship/Transport/
  Colony Ship/Starbase), both sides.
- The win-probability/dice value (e.g. 58.57).

Everything else visible on that page (`killed_population`, `conquered_planet`, luckiness,
XP/level gained) is already covered by the existing API integration and needs no new
scraping — confirmed by comparing the rendered page against the `BattleReportResponse`
schema field-by-field.

## Testing

Every new repository function follows the established pattern from the database refactor:
a paired `.test.js` using a temp `AWT_DB_PATH` database, exercising real behavior (not
source-text regex) wherever the function does real logic — in particular:
- The intel-preservation merge rule (race write-once, other intel fields update-when-
  visible/preserve-when-not) needs direct test coverage, since it's a new universal
  invariant several write paths must honor identically.
- `player_name_history` needs a test confirming a name change is logged with the OLD name
  before the overwrite, and that an unchanged name logs nothing.
- The claim mechanism (both uses) needs a test confirming an expired claim can be
  re-claimed, and a live claim blocks a second claimant.

## Open questions carried into implementation planning (not blocking this design)

- Exact reference point for "when did this round start" for the `ListPlayer` cadence
  switch (proxy vs. a dedicated marker) — implementation detail, not a design blocker.
- Exact `player-detail scan` batch size and staleness-ordering query — implementation
  detail.
- The alliance CV/population-kill challenge leaderboard — explicitly deferred to its own
  future design conversation.
