# Travel-time calibration

## Where the formula lives

One file: **`public/js/utils/travel-model.js`**.

It sits under `public/` because that is the only directory the browser can fetch from,
and it is written so Node loads the same file:

```js
// Node
const { calcTravelSeconds } = require('../../public/js/utils/travel-model.js');

// Browser (ES module)
import '../utils/travel-model.js';
const { calcTravelSeconds } = globalThis.AWTravelModel;
```

`src/utils/travel-calc.js` re-exports it, so every existing `require('./utils/travel-calc')`
keeps working. `public/js/ui/travel-calc-ui.js` imports it directly.

## The formula

```
mod = 0.91^energy / (1 + 0.11·raceSpeed)

same system:  1200 + 14400·√(|Δplanet|+1)·mod                  (20-minute minimum)
deep space:   2700 + (36000·dist + 3600·√(|Δplanet|+1))·mod     (45-minute minimum)

allied move:  ×0.5
```

`dist` is the Euclidean distance between the two systems' `(x, y)`. Both flight types are
a fixed minimum that never shrinks, plus a reducible part scaled by `mod`.

The result is floored, and floored again after halving.

## Ground truth

`src/utils/travel-fixtures.json`. Two kinds of entry:

| `source` | meaning |
|---|---|
| `measured` | read off a fleet-deployment screen by hand |
| `api` | produced by `scripts/collect-travel-fixtures.js` from the game's own endpoint |

The gate in `src/utils/travel-calc.test.js` is **zero seconds**. Not a percentage — an
exact match on every fixture. The formula currently reproduces all nine measurements
exactly, so there is no reason to accept less.

## Is the rounding right?

The harness re-derives this every run instead of trusting the comment. It computes each
fixture's unrounded value and asks which rounding rule reproduces the game:

```
floor  reproduces 9/9   <- what the formula uses
round  reproduces 5/9
ceil   reproduces 0/9
trunc  reproduces 9/9
```

`floor` and `trunc` are indistinguishable here because every travel time is positive.
`round` is ruled out decisively: one fixture's unrounded value ends in `.970` and the game
still reports the lower second.

**So the reported "rounding problems" are not reproducible with the measurements we have.**
That does not mean they do not exist — it means the nine fixtures do not reach wherever the
problem is. The coverage report at the end of the harness lists which input regions have no
measurement at all; that is where to look.

## Collecting fixtures from the API

The test server exposes the game's own calculation:

```
GET /api/v1/Fleet/travelTime
      ?fromSystem=&fromPlanetIndex=&toSystem=&toPlanetIndex=&energyLevel=
   -> { days, hours, minutes, seconds, timeSpan, totalSeconds }
```

Verified live on `test.astrowars.games`: the endpoint exists, and without a session it
answers `401` with a redirect to `/Identity/Account/Login`. So collection needs a logged-in
cookie — once, to generate fixtures. The harness runs offline afterwards.

```bash
# 1. log in to https://test.astrowars.games in a browser
# 2. DevTools > Application > Cookies, copy the .AspNetCore.* cookie
AW_COOKIE='.AspNetCore.Identity.Application=...' node scripts/collect-travel-fixtures.js

# useful flags
  --dry                 probe and report, write nothing
  --energy 0,5,15,30,45 energy levels to sweep
  --pairs 40            how many system pairs
  --delay 250           milliseconds between calls
  --base <url>          default https://test.astrowars.games
```

The script:

1. reads `/api/v1/Player` for your race speed bonus — **required**, because the endpoint
   answers for the logged-in player and the fixture cannot be replayed without it;
2. reads `/api/v1/SolarSystem` to turn system ids into coordinates;
3. walks a grid spread across the distance range, deliberately covering the regions the
   harness reports as missing;
4. prints a histogram of `local − API` differences, which is the direct answer to *where*
   the rounding is wrong;
5. appends only new cases to the fixtures file, matching on the full input tuple, so
   re-running it never duplicates or overwrites anything.

### Two things the endpoint cannot give you

- **Race speed.** It is taken from the logged-in account, so one run samples one speed
  value. Sweep it by collecting from accounts with different races, or measure by hand.
- **The allied ×0.5 halving.** Not a parameter. Only one hand-measured fixture covers it.

### It is a reference, not a replacement

The endpoint answers *for the current player*. `src/utils/interceptors.js` and `!ghosts`
compute travel times for **other** players' fleets, which this endpoint cannot do. The
local formula stays; the API only tells us whether it is right.

## What changed when the copies were merged

The browser copy never parsed its inputs to integers, while the server always did. For the
integer levels the game actually uses, the two agreed exactly. For anything fractional
typed into the panel they did not:

| energy | speed | old panel | server (and panel now) | gap |
|---|---|---|---|---|
| 9.5 | 0 | 118:43:02 | 124:24:48 | 5h 42m |
| 0.5 | 0 | 276:25:11 | 289:43:49 | 13h 19m |

The harness now asserts that `travel-calc-ui.js` imports the shared model and contains no
formula constants of its own, so the two cannot drift apart again.
