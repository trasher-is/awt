# Database call refactor — design

## Purpose

`awt`'s data access grew organically over a round: `database.js` holds schema/migrations only,
and every route file, plus `discord_bot.js`, calls `db.prepare(sql).get/all/run(...)` directly
and inline. There is no query layer. As of this writing, raw `db.prepare()` calls appear in 18
files (`discord_bot.js` 47, `admin.js` 35, `intel.js` 34, `sync.js` 28, `trade.js` 17,
`routes.js` 14, `search.js`/`incoming.js` 8 each, `interceptors.js`/`rzhub.js`/`notes.js`/
`auth.js` 6 each, `discord-commands.js` 4, `covering.js` 2, and a few single call sites),
roughly 260 call sites total, with real duplication (e.g. `SELECT name, x, y FROM systems
WHERE id = ?` appears near-verbatim three times in `discord_bot.js` alone).

This project introduces a per-domain repository layer so query logic lives in one place per
table group, is named, and is compiled once instead of re-prepared per call. It is the first
of three planned `round-new` sub-projects (see [[awt-test-instance]] in memory); the other two
— moving player/system intel from the sidebar to injections into game HTML, and swapping
scraping for the official AstroWars API where it's a clean win — are separate specs and are
deliberately not started until this one lands, since both build on top of the data layer this
project creates.

## Non-goals

- **No behavior changes.** This is a mechanical extraction: same SQL, same parameters, same
  return shapes, just moved into named functions and given prepared-statement reuse. If a bug
  or an obvious N+1 turns up while migrating a domain, it gets flagged, not fixed inline —
  mixing "move code" with "fix code" is how mechanical refactors turn into regressions.
- **No error-handling changes.** Repository functions are thin wrappers that throw whatever
  better-sqlite3 throws. Try/catch and HTTP status mapping stay in the route files exactly as
  they are today.
- **No UI or scraping/API work.** The `battle_reports` / `battle_report_units` tables added
  here are schema only — an empty `repositories/battleReports.js` shell with no sync logic.
  Population (via the AstroWars API and supplementary scraping) is project #3's job.

## Repository structure

New `src/repositories/` directory, one file per domain, grouping the 24 existing tables plus
the 2 new ones:

| Module | Tables |
|---|---|
| `users.js` | `app_users`, `discord_link_codes` |
| `players.js` | `players`, `player_logins` |
| `alliances.js` | `alliances`, `alliance_member_stats`, `alliance_broadcasts` |
| `systems.js` | `systems`, `best_guarded`, `planets`, `planet_events`, `planet_takeovers` |
| `fleets.js` | `fleets` |
| `plans.js` | `planet_plans` |
| `trade.js` | `trade_agreements` |
| `notes.js` | `user_notes` |
| `incoming.js` | `incoming_alerts`, `incoming_msgs` |
| `discordTimers.js` | `discord_timers` |
| `routing.js` | `routes`, `route_legs` |
| `settings.js` | `app_settings` |
| `rounds.js` | `rounds`, `round_players`, `round_systems` |
| `battleReports.js` | `battle_reports`, `battle_report_units` (new — shell only, see below) |

Each module:

- Compiles its prepared statements once at module load (module-level `const`), not per call —
  a free perf win given how many of these currently run inside loops (e.g. `discord_timers`'
  `markFired`/`markSent` patterns, already hoisted by hand in a couple of places; this makes it
  the default everywhere).
- Exports named functions describing intent, e.g. `getSystemCoords(id)`, `getActiveUsers()`,
  `upsertAllianceMember(...)` — not a generic query-builder or ORM. Multi-statement writes that
  are already wrapped in `db.transaction()` at the call site keep that wrapping, just moved
  into the repository function.
- Imports `db` from `database.js`. Route files and `discord_bot.js` import repositories
  instead of `database.js` going forward; `database.js` itself shrinks to schema/migrations
  only and keeps exporting the raw `db` handle (repositories are its only remaining consumer
  outside of tests).

## Migration order and verification

Domain by domain, not one large diff. For each domain: extract its repository module, update
every call site that touches those tables, restart `awt-test` (`pm2 restart awt-test`), and
exercise the corresponding feature by hand before moving to the next domain and before
committing. Suggested order, roughly by call-site count / risk (highest first, since catching
a mistake early in the highest-traffic domain is more valuable than saving it for last):

1. `systems` / `fleets` / `plans` (heaviest use — `intel.js`, `sync.js`, `discord_bot.js` map
   commands all touch these)
2. `players`
3. `alliances`
4. `users` (touches auth — verify login/session behavior explicitly)
5. `trade`
6. `discordTimers`
7. `incoming`
8. `notes`, `settings`, `routing`, `rounds` (lowest call-site count, batch together)

`battleReports.js` is created alongside its schema addition (see below) but has no callers yet
— it verifies trivially (empty tables, module loads without error) and isn't part of the
per-domain migration risk above.

## New tables: `battle_reports` and `battle_report_units`

Added in this project because they're pure schema (fits the "this project touches
`database.js`" scope), even though nothing populates them until project #3.

Comparing the AstroWars API's `BattleReportResponse` (from `/swagger/v1/swagger.json`) against
an actual in-game battle report page confirmed what the API is missing: it has aggregate
combat-value/luckiness/XP/kill-% stats per side, but no per-unit-type breakdown and, more
importantly, **no location at all** (no system or planet ID in the response) — so scraping the
in-game report stays necessary just to know where a battle happened, not only for the
per-ship-type breakdown.

**`battle_reports`** — one row per battle:

- `id` (the game's own report id, e.g. `29942` — not autoincrement)
- `started_at`, `is_public`, `winner`, `win_chance` (API's `randomNumber` — the dice-roll value
  shown as e.g. "58.57"), `conquered_planet`, `killed_population`
- `system_id`, `planet_index` — nullable, **scrape-only**, API has no location data
- `attacker_player_id`, `attacker_player_name`, `attacker_alliance_id`, `attacker_alliance_tag`,
  `attacker_has_won`, `attacker_luckiness`, `attacker_combat_value`, `attacker_survived_cv`,
  `attacker_lost_cv`, `attacker_pct_cv_lost`, `attacker_xp_gained`, `attacker_level_gained`
- `defender_*` — mirrors every `attacker_*` column above
- `api_synced_at`, `scraped_at` — nullable timestamps, so a row's provenance (API-only,
  scrape-only, or both) is always visible rather than inferred

**`battle_report_units`** — scrape-only, one row per (battle, side, unit type):

- `battle_report_id` (FK → `battle_reports.id`)
- `side` (`'attacker'` | `'defender'`)
- `unit_type` (`'Destroyer'`, `'Cruiser'`, `'Battleship'`, `'Transport'`, `'Colony Ship'`,
  `'Starbase'`)
- `count_before`, `count_lost`, `count_survived`

## Testing

- One lightweight smoke test per repository module (extending the existing `*.test.js` /
  `run-tests.js` convention), run against a throwaway on-disk SQLite file initialized via
  `database.js`'s own `initDatabase()` — not a full integration suite, just enough to catch
  "the module doesn't load" / "the statement doesn't compile" / "the function returns the
  wrong shape" mistakes made during the mechanical move.
- The real verification is manual: exercise each domain's features on `awt-test` after that
  domain's migration, before committing and before starting the next domain, per the order
  above.
