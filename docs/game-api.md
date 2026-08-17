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

The `/api/v1` stream is capped **globally** at `GAME_API_MAX_PER_SECOND` (default 5):
every member, every feature, one shared bucket. `apiGate` is a `gameTrafficGate` instance
whose key collapses everyone into a single bucket and which counts every `/api/v1`
request, marker or not. The browser-side gate in `AWGameRate.gameFetch` is the first line;
the server gate is the floor.

Be precise about what that does **not** say: it is *not* "the hub never sends the game
more than 5 requests per second overall". The pre-existing scraper gate (`gameGate`) is
per-member and counts only marker-tagged requests, so scraped traffic, API traffic and
plain page loads combined can exceed 5/s once two or more members are active. That
behaviour predates the API work and is outside its scope. Do not restate this budget as a
stronger guarantee than the code enforces.

The default of 5 is an agreement with the game's administrator, not a tuning knob. Raising
`GAME_API_MAX_PER_SECOND` requires their renewed consent — the env var exists for
deployment, not for code review.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GAME_API_MAX_PER_SECOND` | `5` | Global `/api/v1` budget for the whole hub combined; `0` disables the gate |
| `GAME_API_MAX_WAIT_MS` | `8000` | How long a queued request may wait at the limit before it answers 429 |

Both are documented in [.env.example](../.env.example) next to the older per-member pair
(`GAME_MAX_PER_SECOND`, `GAME_MAX_WAIT_MS`) and the loose per-member ceiling `PROXY_MAX` —
three limiters, three different jobs.

Admins can watch the gate live: `GET /hub-api/admin/api-traffic` returns `apiGate`'s
snapshot, the sibling of `/hub-api/admin/game-traffic` for the scraper gate.

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
| `getTravelTime({fromSystem, fromPlanetIndex, toSystem, toPlanetIndex, energyLevel})` | `GET /api/v1/Fleet/travelTime` | `{days, hours, minutes, seconds, timeSpan, totalSeconds}` — answers for the logged-in player, by system id, race speed baked in |
| `searchBattleReports(params)` | `GET /api/v1/BattleReport/search` | battle reports; `params` uses the spec's dotted names verbatim (`FirstParty.AllianceId`, `OrderBy`, `OrderDirection`, `Take`, `BattleDateFrom`, …) |
| `putOrderGeometry(orderId, {range, angleDegree1, angleDegree2})` | `PUT /api/v1/Starbase/orders/{orderId}/geometry` | writes the geometry; the API exposes **no read** of the current geometry |

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
| Travel calculator, game-server line | `getTravelTime`, debounced 400 ms | display only; a mismatch over 2 s against the local formula is `console.warn`ed with full inputs |
| Travel calculator Update / system-intel refresh | `getSystemPlanets` | `POST /hub-api/sync/system` via the shared mapper |
| Battle-report sync (dashboard, first pull 10 s after load, then every 30 min) | `searchBattleReports` twice — once per alliance side | `POST /hub-api/sync/battle-reports`; the hub stores idempotently and announces the genuinely new reports on Discord |
| Starbase order editor (own planets only) | `getSystemPlanets`, then `putOrderGeometry` after an explicit confirm | `POST /hub-api/sync/starbase-audit` after a confirmed 200 |

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
