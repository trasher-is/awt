# Game REST API

## What this is

The game exposes a REST API under `/api/v1/*` (OpenAPI 3.0.1 spec at
`/swagger/v1/swagger.json`). Its programmatic use on production has been agreed with the
game's administration under the conditions recorded in [AGENTS.md](../AGENTS.md): one
global request budget, member sessions only, no bot or test accounts. This file documents
what the hub actually calls, how a request travels, and what is known versus assumed.

**Everything below is spec-derived.** No `/api/v1` response has ever been observed through
the proxy — every shape comes from the published OpenAPI spec, not from live traffic. The
only live observations on record are session-less probes: the routes answer `401` rather
than `404` (see [travel-calibration.md](travel-calibration.md) for the test-server one).
When the first real responses arrive, discrepancies get written down here.

## How a request travels

Every call originates in a member's browser — either realm, the Wrapper dashboard or the
injected game frame. The server never calls the API itself: it has no game session.

```
browser ──► AWGameRate.gameFetch    client gate: 5/s, one window shared across
     │                              both realms via localStorage
     ▼  same-origin /api/v1/...
requireAuth                         hub session, or the login redirect
     ▼
proxyCeiling                        loose per-member ceiling on ALL proxied traffic
     ▼
apiGate                             the global /api/v1 budget (below)
     ▼
proxy middleware                    strips the hub session cookie and the
     │                              X-AWT-Automated marker, forwards the member's
     ▼                              own game session cookie
astrowars.games
```

The chain lives in `server.js`, registered before the `/api` JSON-parser mount on purpose:
`express.json` would otherwise drain PUT/POST bodies before the proxy could forward them.
The path is forwarded verbatim — no prefix stripping. Authorization is the member's own
game session cookie, attached by the proxy; the client adds no auth of its own.

## The rate budget — stated precisely

The `/api/v1` stream is capped **per account** on two dimensions: `GAME_API_MAX_PER_SECOND`
(default 5) and `GAME_API_MAX_PER_5MIN` (default 200), each measured against the
individual member whose game session the request carries — not pooled across the hub.
(An earlier version of this document, and of the code, described the per-second figure as
one global bucket shared by everyone combined. That was a mistake, corrected once —
`apiGate` now keys per-account, the same as the pre-existing scraper gate `gameGate`.)
`apiGate` counts every `/api/v1` request toward the per-second figure, marker or not; a
second middleware, `apiAccountWindowCeiling`, separately tracks the 5-minute figure using
the same fixed-window limiter `proxyCeiling` uses below it in the chain. The browser-side
gate in `AWGameRate.gameFetch` is the first line; the server gates are the floor.

Because both ceilings are per-account, two members active at once each get their own
budget — the hub's aggregate capacity scales with how many members are online, it is not
capped at one shared 5/s regardless of headcount.

The defaults are an agreement with the game's administrator, not a tuning knob. Raising
either `GAME_API_MAX_PER_SECOND` or `GAME_API_MAX_PER_5MIN` requires their renewed
consent — the env vars exist for deployment, not for code review.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GAME_API_MAX_PER_SECOND` | `5` | Per-account `/api/v1` requests/second; `0` disables the gate |
| `GAME_API_MAX_WAIT_MS` | `8000` | How long a queued request may wait at the per-second limit before it answers 429 |
| `GAME_API_MAX_PER_5MIN` | `200` | Per-account `/api/v1` requests per 5-minute window; `0` disables the gate. Fails closed (429) immediately, no queue |

All three are documented in [.env.example](../.env.example) next to the older per-member pair
(`GAME_MAX_PER_SECOND`, `GAME_MAX_WAIT_MS`) and the loose per-member ceiling `PROXY_MAX` —
four limiters now, four different jobs.

Admins can watch both halves live at the same endpoint: `GET /hub-api/admin/api-traffic`
returns `{ gate: apiGate.snapshot(), accountWindow: apiAccountWindowCeiling.snapshot() }`
— `rate-limit.js`'s `rateLimit()` helper (also used by `proxyCeiling`) now exposes a
`snapshot()` in the same `{admitted, rejected, limit, buckets}` shape `gameTrafficGate`
does, so either kind of limiter can be read the same way. A rejection from
`apiAccountWindowCeiling` also logs a `[GameAPI] ... hit the 5-minute per-account budget`
line via `console.warn` — this used to be silent, which is exactly what made the first
real occurrence (some Deep Scan calls failing with no visible cause) a guess instead of a
diagnosis.

`apiGate.snapshot()` (and `gameGate.snapshot()`, and any `rateLimit()` instance) also
includes `byPath`: a count of admitted requests per endpoint, with numeric path segments
collapsed to `:id` (e.g. `/api/v1/Player/419` and `/api/v1/Player/420` both count toward
`/api/v1/Player/:id`) so the map stays small regardless of how many distinct ids get
scanned. Added after a real "is X calling the game once per system?" question that source
reading alone couldn't settle as convincingly as just looking at what actually went out.

## The client

One file: **`public/js/utils/aw-api.js`** — the dual-runtime module publishing
`globalThis.AWApi`; Node `require()`s the same file for the tests. Every function routes
through `AWGameRate.gameFetch`, and a bare `fetch('/api/v1/...')` anywhere in `public/js`
fails the enforcement scan, by design.

Every call resolves — it never rejects for network, HTTP or parse trouble — with one of:

```
{ ok: true,  data }                          parsed JSON (null when the body is empty)
{ ok: false, status, reason: 'session' }     the body was HTML: a login page, hub or game
{ ok: false, status, reason: 'http' }        non-2xx with a JSON body (ProblemDetails)
{ ok: false, status, reason: 'parse' }       2xx but the body is not JSON
{ ok: false, status: 0, reason: 'network' }  fetch itself threw
```

The HTML sniff runs before anything else so an expired session surfaces as itself, never
as a parse error.

## Endpoints used

| Call | Endpoint | Returns (spec-derived) |
|---|---|---|
| `getSolarSystems()` | `GET /api/v1/SolarSystem` | `[{id, name, fullName, info, populationLevel, x, y}]` — `x`/`y` are nullable; filter before doing geometry |
| `getSolarSystem(id)` | `GET /api/v1/SolarSystem/{id}` | one system, including planets and ownership when in vision |
| `getSystemPlanets(id)` | `GET /api/v1/SolarSystem/{id}/planets` | `[{id, index, name, ownerId, ownerName, allianceId, allianceTag, populationLevel, starbaseLevel, isUnknownOwner, hasSiege, starbaseOrders}]` |
| `getMapSectors({x1, y1, x2, y2})` | `GET /api/v1/Map/sectors` | `[{id, rectangle, alliances, players, solarSystems}]` — each `solarSystems[]` entry additionally carries `{capturedAt, format, isInVision, planets[]}` on top of the base SolarSystem shape |
| `getTravelTime({fromSystem, fromPlanetIndex, toSystem, toPlanetIndex, energyLevel})` | `GET /api/v1/Fleet/travelTime` | `{days, hours, minutes, seconds, timeSpan, totalSeconds}` — answers for the logged-in player, by system id, race speed baked in |
| `searchBattleReports(params)` | `GET /api/v1/BattleReport/search` | battle reports; `params` uses the spec's dotted names verbatim (`FirstParty.AllianceId`, `OrderBy`, `OrderDirection`, `Take`, `BattleDateFrom`, …) |
| `putOrderGeometry(orderId, {range, angleDegree1, angleDegree2})` | `PUT /api/v1/Starbase/orders/{orderId}/geometry` | writes the geometry; the API exposes **no read** of the current geometry |
| `getPlayers()` | `GET /api/v1/Player` | all active players (no filter): `[{id, allianceId, isActivePlayer, name, allianceTag, joinedAt, playerLevel, playsFromCountryCode, pointsScored, rank}]` |
| `getPlayer(id)` | `GET /api/v1/Player/{id}` | one player's full detail, including `intelligenceReport` when the caller has vision |
| `searchPlayers({q, limit})` | `GET /api/v1/Player/search` | player name/id search; same `ListPlayer` shape as `getPlayers()`, just filtered by `q` |
| `searchAlliances({q, limit})` | `GET /api/v1/Alliance/search` | alliance name/tag/id search: `[{id, name, tag, fullName, memberCount, pointsScored, rank}]` |
| `searchSolarSystems({q, limit})` | `GET /api/v1/SolarSystem/search` | system name/id search: `[{id, name, fullName, info, populationLevel, x, y}]` — same shape as `getSolarSystems()`, just filtered by `q` |

## Page scrapes

Everything above is a REST call through `/api/v1`. One feature instead scrapes a rendered
game page directly, because the API has no equivalent endpoint:

| Call | Page | Returns |
|---|---|---|
| `scrapeBattleReportShipDetail(id)` | `GET /About/BattleReport/{id}` | per-ship-type counts/losses (6 ship types × attacker/defender × count/lost) and the win-probability value, parsed out of the rendered HTML by `public/js/scrapers/battle-report-parser.js`. Everything else visible on that page (population change, conquered flag, luckiness, XP/level gained) is already covered by `searchBattleReports` above and is deliberately not re-extracted here. Returns `null` on anything that doesn't look like a real battle report page (no ship-type row matched, or the page's own Defender/Attacker header row disagrees with the parser's assumed column order) rather than risk a permanent row of nulls or silently-swapped attacker/defender data. |

`mapPlanetsToSyncPayload(systemId, apiPlanets)` is the one shared mapper from API planet
objects to the existing `POST /hub-api/sync/system` body: `id→game_planet_id`,
`index→planet_index`, `populationLevel→population`, `starbaseLevel→starbase`,
`isUnknownOwner→is_unknown`, `hasSiege→is_sieged`, owner fields into the `owner` object or
`null`. The travel calculator's Update button and the system-intel refresh both use it, so
the API-sourced payload cannot drift between them. `has_fleet` stays `null` — the API says
nothing about stationed fleets, and `null` keeps "not observed" distinct from a fabricated
"observed absent".

## Who calls what

| Feature | API calls | Feeds |
|---|---|---|
| Galaxy map "Seed z API" | `getSolarSystems` | `POST /hub-api/sync/galaxy` |
| Galaxy map "Seed planets (sectors)" | `getMapSectors` | `POST /hub-api/sync/system` (one call per system, via the shared mapper, `scan_mode: 'silent'` to suppress Discord announcements) then `POST /hub-api/sync/system-in-vision` with every system's `isInVision` flag |
| Travel calculator, game-server line | `getTravelTime`, debounced 400 ms | display only; a mismatch over 2 s against the local formula is `console.warn`ed with full inputs |
| Travel calculator Update / system-intel refresh | `getSystemPlanets` | `POST /hub-api/sync/system` via the shared mapper |
| Battle-report sync (dashboard, first pull 10 s after load, then every 30 min) | `searchBattleReports` twice — once per alliance side | `POST /hub-api/sync/battle-reports`; the hub stores idempotently and announces the genuinely new reports on Discord |
| Starbase order editor (own planets only) | `getSystemPlanets`, then `putOrderGeometry` after an explicit confirm | `POST /hub-api/sync/starbase-audit` after a confirmed 200 |
| Player list background sync (`player-api-sync.js`, cadence decays with round age) | `getPlayers` | `POST /hub-api/sync/player-list` via the shared `mapPlayersToSyncPayload` mapper |
| Player detail background sweep (`player-api-sync.js`, staleness-ordered, batched via `/hub-api/sync/player-scan-claim`) | `getPlayer` per claimed id | `POST /hub-api/sync/player-detail` |
| Search live-fallback — player branch (`search.js`'s `searchLiveViaApi('player', …)`) | `searchPlayers` | `POST /hub-api/sync/player-list` via the shared `mapPlayersToSyncPayload` mapper, then the same DB-backed search re-runs |
| Search live-fallback — alliance branch (`search.js`'s `searchLiveViaApi('alliance', …)`) | `searchAlliances` | `POST /hub-api/sync/alliance-search`, then the same DB-backed search re-runs |
| Search live-fallback — system branch (`search.js`'s `searchLiveViaApi('system', …)`) | `searchSolarSystems` | `POST /hub-api/sync/galaxy` via the shared `mapSolarSystemsToSyncPayload` mapper, then the same DB-backed search re-runs |
| Battle-report ship-detail sweep (`battle-report-detail-sync.js`, every 90 s, batched via `/hub-api/sync/battle-report-ship-detail-claim`) | none (page scrape, not an API call) — `scrapeBattleReportShipDetail` above | `POST /hub-api/sync/battle-report-ship-detail` per claimed report |

## Open questions

- **RedZone pace.** The current round is RedZone and runs at ×10 pace. Whether
  `Fleet/travelTime` reports the paced number, and how that maps onto the local formula,
  is unverified. The galaxy map's isochrone thresholds are standard-pace and say so on
  screen.
- **Alliance travel-time semantics.** Whether the endpoint applies the allied ×0.5 halving,
  and under what conditions, is unknown — it is not a parameter. The travel calculator
  skips the API line for alliance moves for exactly this reason.
- **Starbase geometry is write-only.** No endpoint reads an order's current geometry, so
  the editor cannot show what a write replaces. It says so on screen and requires an
  explicit confirmation before every PUT.
