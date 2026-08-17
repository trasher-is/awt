# Game API integration — implementation plan

Date: 2026-08-16. Branch: `API`. One PR to `main` containing everything below.

## What changed outside the code

The game's administration has agreed to programmatic use of the production REST API
(`/api/v1/*` on `astrowars.games`, OpenAPI 3.0.1 spec at `/swagger/v1/swagger.json`) under
these conditions:

- **Hard ceiling of 5 requests/second for the whole hub combined** — every member, every
  feature, one budget. The ceiling is deploy-configurable (env var) but its default stays 5
  and raising it requires the administrator's renewed consent, not a code review.
- **No dedicated bot or test accounts.** The only authorization is a real member's own game
  session riding through the hub's reverse proxy. The Discord bot has no session and stays on
  the local formulas permanently.
- Server-side scripts still must not accept production base URLs
  (`scripts/collect-travel-fixtures.js` keeps its allowlist). The member-session-through-proxy
  path is the *only* sanctioned route to production.

AGENTS.md's "Production game API is off limits" section is updated by this PR to record the
agreement and its boundaries.

## Architecture in one paragraph

All API calls originate in the browser (either realm: the Wrapper dashboard or the injected
game frame), go through the shared client gate `AWGameRate.gameFetch` (first line, 5/s across
realms via localStorage), hit the hub as same-origin `/api/v1/...` requests, pass a **new
dedicated server chain** — `requireAuth` → per-member `proxyCeiling` → **new global
`apiGate`** (a `gameTrafficGate` instance with `keyOf: () => 'global'`,
`isAutomated: () => true`, `maxPerSecond` from env `GAME_API_MAX_PER_SECOND`, default 5) —
and are forwarded by the *existing* proxy middleware (which already strips the hub session
cookie and the `X-AWT-Automated` marker, and forwards the player's game session cookie).
The server never calls the game API itself: it has no game session. Results flow back to the
UI and, where they enrich shared intel, are POSTed to the existing `/hub-api/sync/*` routes.

## Work units

### F1 — server foundation (files: `server.js`, `src/database.js`, `src/routes/sync.js`, `src/routes/admin.js`, `src/routes/auth.js`, `.env.example`, `src/utils/battle-reports.js` + tests)

1. **`/api/v1` chain in `server.js`**: registered **before** `app.use('/api',
   express.json(...), webhookRouter)` (server.js:247) so PUT/POST bodies are not consumed by
   the JSON parser before proxying. No prefix stripping — guard on `req.path.startsWith('/api/v1')`
   and reuse the exported proxy middleware so cookie/marker hygiene is inherited. Chain:
   `requireAuth` → `proxyCeiling` → `apiGate` → proxy.
2. **`apiGate`**: second `gameTrafficGate` instance, global key, counts every `/api/v1`
   request regardless of marker. Env: `GAME_API_MAX_PER_SECOND` (default 5, `0` disables,
   same `=== undefined ? 5 : Number(...)` idiom), `GAME_API_MAX_WAIT_MS` (default 8000).
   Comment names the agreement. Admin observability: new
   `GET /hub-api/admin/api-traffic` returning `apiGate.snapshot()` (sibling of the existing
   game-traffic endpoint; do not change the existing endpoint's shape).
3. **DB migrations** (append-only, idempotent):
   - `battle_reports`: `id INTEGER PRIMARY KEY` (game report id), `started_at TEXT`,
     `is_public INTEGER`, `winner TEXT`, `conquered_planet INTEGER`, `killed_population INTEGER`,
     `random_number REAL`, then per side (`att_` / `def_` prefixes): `alliance_id`, `alliance_tag`,
     `player_id`, `player_name`, `has_won INTEGER`, `luckiness REAL`, `combat_value INTEGER`,
     `survived_cv INTEGER`, `lost_cv INTEGER`, `pct_cv_lost REAL`, `xp_gained INTEGER`,
     `level_gained INTEGER`; plus `announced INTEGER DEFAULT 0`, `created_at`. Index on
     `started_at`. Included in the admin "nuke" round wipe (`src/routes/admin.js`).
   - `starbase_order_audit`: `id AUTOINCREMENT`, `order_id INTEGER`, `system_id INTEGER`,
     `planet_index INTEGER`, `range REAL`, `angle1 REAL`, `angle2 REAL`,
     `actor_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL`,
     `actor_game_name TEXT`, `created_at TEXT`. Survives the round wipe (operations record).
4. **`src/utils/battle-reports.js`** (pure, testable): `mapApiReport(apiObj)` →
   flat row or `null` (integer/shape guards, skip-bad-rows-never-abort),
   `upsertReports(db, rows)` → `{inserted: [...], skipped: n}` using `INSERT OR IGNORE`
   inside one transaction, `formatBattleEmbed(row)` → discord.js-free plain object
   `{title, description, color}` (timestamps as `<t:unix:R>` markdown, never inside code
   blocks; names through `defuseMentions` at the call site).
5. **Sync routes** (`src/routes/sync.js`):
   - `POST /sync/battle-reports` `{reports: [...]}` — map/validate via battle-reports.js,
     upsert, and after commit fire-and-forget `postEmbed('discord_battlereport_channel', ...)`
     (REST helper from `src/utils/discord-post.js` — do **not** touch `src/discord_bot.js`,
     its test suite scans that file's source). Announce only freshly inserted reports with
     `announced=0`, mark them announced, cap at 5 embeds per sync (summarize the rest in one
     line). Names pass through `defuseMentions`.
   - `POST /sync/starbase-audit` — one audit row per confirmed PUT, actor from
     `req.session` (`userId`, `gameName`).
   - `POST /sync/system`: accept optional `is_sieged` per planet (maps API `hasSiege`; first
     writer of the existing, never-written column). Keep every fog-of-war guard intact —
     when `is_unknown` is true the guard preserves owner/pop/starbase, and it must preserve
     the previous `is_sieged` the same way (never zero out what you cannot see).
   - `GET /me` (`src/routes/auth.js:36`): extend the response with `allianceId` — resolved
     via the existing name bridge (`LOWER(app_users.game_name) = LOWER(players.name)` →
     `players.alliance_id`), `null` when unresolved. Purely additive; existing consumers
     (`route-planner.js`, `dashboard.js`) read only `id`/`role` and must keep working.
6. **`.env.example`**: `GAME_API_MAX_PER_SECOND=5` + `GAME_API_MAX_WAIT_MS=8000` in the
   Rate-limits block with a comment naming the agreement; back-fill the currently
   undocumented `GAME_MAX_PER_SECOND`, `GAME_MAX_WAIT_MS`, `PROXY_MAX`.
7. **Tests** (`src/utils/*.test.js`, framework-free, real timers for anything rate-related):
   - `game-api-route.test.js`: source-scan `server.js` — the `/api/v1` chain exists, is
     registered before the `/api` JSON-parser mount, uses the shared proxy middleware, and the
     env idiom is `=== undefined`; behavioral test of the global gate (two fake sessions share
     one bucket).
   - `battle-reports.test.js`: temp-DB upsert/dedupe/announce-flag semantics; synthetic
     fixtures only (public repo — never captured data).

### F2 — shared client modules (files: `public/js/utils/aw-api.js` NEW, `public/js/utils/travel-model.js`, + tests)

1. **`aw-api.js`** — 7th dual-runtime UMD module (no import/export, publishes
   `globalThis.AWApi`, Node `require()`-able). Every call routes through
   `AWGameRate.gameFetch` (browser: read `globalThis.AWGameRate` at call time; Node: require
   `./game-rate-limit.js`) — a bare `fetch('/api/v1/...')` anywhere in `public/js` fails the
   existing enforcement test, by design. API surface:
   `getSolarSystems()`, `getSolarSystem(id)`, `getSystemPlanets(id)`,
   `getTravelTime({fromSystem, fromPlanetIndex, toSystem, toPlanetIndex, energyLevel})`,
   `searchBattleReports(params)`, `putOrderGeometry(orderId, {range, angleDegree1, angleDegree2})`,
   and `mapPlanetsToSyncPayload(systemId, apiPlanets)` — the ONE shared mapper from API
   planet objects to the existing `POST /hub-api/sync/system` payload shape
   (`id→game_planet_id`, `index→planet_index`, `populationLevel→population`,
   `starbaseLevel→starbase`, `isUnknownOwner→is_unknown`, `hasSiege→is_sieged`,
   owner: `{id: ownerId, name: ownerName, alliance_id: allianceId, alliance_tag: allianceTag}`
   or `null`); slices A and C both consume it, neither writes its own.
   Uniform result: `{ok: true, data}` or `{ok: false, status, reason}` — an HTML body (the
   `requireAuth` login redirect or the game's Identity login page) is detected and returned as
   `reason: 'session'`, never thrown as a JSON parse error. Injectable fetch for tests.
2. **`travel-model.js`**: add `isochroneRadius(seconds, energy, raceSpeed, isAlliance)` —
   the analytic inverse of the deep-space branch with planet term `sqrt(0+1)=1`
   (`dist = ((T[/0.5 if alliance] − 2700)/mod − 3600)/36000`, clamped at 0). This is the ONLY
   file allowed to hold formula constants (identity + constant-scan tests). `calcTravelSeconds`
   itself is untouched — the 9/9 fixture gate must stay green.
3. **Tests**: `aw-api.test.js` (URL building, result normalization, HTML-response handling,
   source-scan: no bare fetch, no import/export); `isochrone.test.js` (round-trip property:
   for a grid of energy/speed/alliance, `calcTravelSeconds(origin → point at isochroneRadius(T))`
   ≤ T, and slightly beyond the radius > T).

### F3 — UI features (four disjoint slices, parallel)

- **A. Travel calculator v2** (`public/js/ui/travel-calc-ui.js`): local result renders
  instantly (unchanged path). When both endpoints came from the system picker (ids known),
  the alliance box is unchecked, and a session is available, a debounced (400 ms)
  `AWApi.getTravelTime` call adds the game-server line; when it arrives it is displayed as
  the primary value with a "źródło: serwer gry" badge and the local value stays visible
  beneath. Mismatch > 2 s → `console.warn` with full inputs. API line is skipped for
  alliance moves (endpoint semantics for allied halving unverified) and for manual x/y input
  (API takes system ids). The "Update" button switches from DOM scraping to
  `AWApi.getSystemPlanets` → existing `POST /hub-api/sync/system` payload shape (map
  `p.id→game_planet_id`, `p.index→planet_index`, `populationLevel→population`,
  `starbaseLevel→starbase`, `isUnknownOwner→is_unknown`, `hasSiege→is_sieged`, owner fields),
  falling back to `scrapeSystemById` when the API answer is not ok.
- **B. Galaxy map: isochrones + seed** (`public/js/ui/galaxy-map.js`,
  `public/components/galaxy-map.html`): new `isochrones` key in `DEFAULT_LAYERS` (default
  off — auto-wired by the existing checkbox loop); controls for origin system (picker over
  the already-loaded systems list, default = own home system when known), energy (0–100),
  race speed (−4..+4), alliance toggle, three thresholds defaulting to 12/24/48 h. Render as
  an underlay (beside the vision wash): three `isochroneRadius`-derived rings around the
  origin (world-radius × `state.scale`) plus per-system dot tint by band computed with
  `calcTravelSeconds` (planet index 1→1). All math via `globalThis.AWTravelModel` —
  galaxy-map.js gains the side-effect import but no formula constants (source-scan test).
  "Seed z API" button: `AWApi.getSolarSystems()` → filter `x != null && y != null` → existing
  `POST /hub-api/sync/galaxy` `{systems:[{id,name,x,y}]}` → reload; empty-state message now
  offers the seed button. Settings persist in the existing per-user localStorage prefs.
- **C. System intel: live refresh + starbase editor** (`public/js/ui/system-intel.js`,
  `public/Wrapper.html`): "Odśwież z API" button in the system-intel sidebar — same
  API→sync→`loadPlans()` cycle as slice A's Update path (shared mapping helper lives in
  aw-api.js as `mapPlanetsToSyncPayload(systemId, apiPlanets)`). Starbase orders: for own
  planets (owner name vs `GET /hub-api/me` game name, case-insensitive), an "Orders" action
  fetches `getSystemPlanets` and lists each planet's `starbaseOrders` (`{id, canBeChanged}`
  — the API exposes no current geometry, so the editor is write-only and says so); editable
  form (range, angle1, angle2 in degrees) → explicit confirm dialog showing exactly what will
  be sent → `AWApi.putOrderGeometry` → on 200, `POST /hub-api/sync/starbase-audit`;
  403/404/`canBeChanged=false` surfaced verbatim. No automation, no batch writes. All
  interpolated strings through `esc()`.
- **D. Battle-report sync** (`public/js/ui/dashboard.js` + `public/js/ui/battle-sync.js`
  NEW): wrapper-realm scheduler — first pull 10 s after dashboard load, then every 30 min
  while open (`setInterval` in the dashboard realm is fine; the no-polling rule bans
  game-DOM polling in the injected frame). Pull = own alliance id from a new lightweight
  `GET /hub-api/me` extension (`allianceId` resolved server-side via the existing
  name-bridge; skip sync when null) → two `searchBattleReports` calls
  (`FirstParty.AllianceId` and `SecondParty.AllianceId`, `OrderBy=DateTime Descending`,
  `Take=50`, `BattleDateFrom` = newest `started_at` already in the hub, from the sync
  response) → `POST /hub-api/sync/battle-reports`. Concurrency guard so two open dashboards
  don't double-pull (localStorage timestamp lock, 25-min TTL).

### F4 — docs (after code): `AGENTS.md` (agreement section rewrite + AWApi row in the
dual-runtime table + checklist touch-ups), `README.md` (layout/tests mirrors),
`docs/game-api.md` NEW (endpoints used, auth model, rate budget, RedZone open question,
what is spec-derived vs observed), `docs/player-guide.md` (short RedZone section: x10 pace,
TA 120k vs 20k, pointer to issue #53 for the full delta list).

**Precision rule for the rate-budget wording** (both `docs/game-api.md` and the AGENTS.md
rewrite): the guarantee this PR provides is "the `/api/v1` stream is globally capped at
`GAME_API_MAX_PER_SECOND`". It is NOT "the hub never exceeds 5 req/s overall" — the existing
`gameGate` on scraped game traffic is per-member and counts only marker-tagged requests, so
scrape + API + page loads combined can exceed 5/s with 2+ active members. That is
pre-existing behavior, out of scope here; do not write a stronger guarantee than the code
enforces.

### PR body requirements (AGENTS.md: disclose unverified parts)

The PR description must carry an explicit "Unverified" section listing at minimum:
- No `/api/v1` request has ever been made through the proxy against production — every
  response shape in this PR is spec-derived (OpenAPI), not observed;
  `scripts/collect-travel-fixtures.js` has never successfully run.
- `Fleet/travelTime` semantics for alliance (halved) moves are unknown — the UI skips the
  API line for alliance moves for exactly this reason.
- RedZone (x10 pace) interaction with `travelTime` and the local formula is an open
  question; the current round is RedZone.
- The starbase-order PUT has never been exercised; the API exposes no read of current
  geometry, so the editor is write-only by design.

## Hard constraints (from AGENTS.md + enforced by existing tests)

1. Never touch `src/discord_bot.js` (source-scan suite) — Discord alerts go via
   `postEmbed` REST helper.
2. No import/export inside `public/js/utils/*` (UMD only); no bare `fetch` to game paths in
   `public/js` (enforcement test); every game-bound request through `gameFetch`.
3. Formula constants only in `travel-model.js`; `src/utils/travel-calc.js` stays a pure
   re-export (object-identity test); never edit fixtures.
4. Fog-of-war guards in `/sync/system` stay intact; never null-out data you cannot see;
   FK insert order (systems → players → planets); `clearMovedPlanet` before setting
   `game_planet_id`.
5. Synthetic fixtures only — the repo is public; no captured player data in the tree.
6. Tests live in `src/utils/*.test.js`, framework-free, real timers for rate limits;
   `npm test` green is the merge gate.
7. `esc()` for every player-derived string hitting `innerHTML`; `defuseMentions` for every
   player-derived string hitting Discord.
8. New injected DOM (if any) carries `aw-`/`awt-` class prefixes; panels: newer error-surface
   convention, not silent catch.

## Out of scope (explicit)

- Discord bot API access of any kind; new slash commands.
- Server-initiated API calls (server has no game session).
- RedZone pace multiplier in the travel formula — no verified data; documented as an open
  question in `docs/game-api.md` (the current round runs x10; isochrone defaults are
  standard-pace and say so in the UI).
- Reading current starbase-order geometry (the API does not expose it).
