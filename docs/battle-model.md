# The battle model

## Where it lives

One file: **`public/js/utils/battle-model.js`**.

It sits under `public/` because that is the only directory the browser can fetch from, and
it is written so Node can load the very same file:

```js
// Node
const model = require('../../public/js/utils/battle-model.js');

// Browser (ES module)
import '../utils/battle-model.js';        // side-effect import
const model = globalThis.AWBattleModel;
```

The file has no `import`/`export` statements, so a browser treats it as a module body that
runs for its side effect, while Node treats it as CommonJS. `typeof module` decides which
branch of the footer applies. No build step, no bundler, no Node version requirement
beyond what the project already has.

Callers:

| Caller | How |
|---|---|
| `src/utils/battle.js` | re-exports the parts the server uses |
| `src/utils/interceptors.js` | `cvOf`, `SHIPS` via `./battle` |
| `src/discord_bot.js` (`!battle`) | `require('../public/js/utils/battle-model.js')` |
| `public/js/ui/battle-calc.js` | side-effect import |
| `public/js/ui/system-intel.js` | side-effect import (CV display only) |

## Why this exists

The model used to be hand-copied into three places. On 2026-06-26 the bot's copy was
frozen; on 2026-06-27 and 06-28 the dashboard copy was recalibrated against in-game
samples. Nobody updated the bot. For five weeks `!battle` and the Hub calculator answered
the same fight differently:

| | |
|---|---|
| average win-% disagreement over 2304 fleet/stat combinations | **19.1 pp** |
| worst disagreement | **66.7 pp** |
| combinations more than 10 pp apart | **1426 of 2304 (62%)** |
| worst survivor disagreement | **62.8 pp** |

On the one case with a written-down in-game observation — 1000 destroyers against
125 cruisers at equal CV, observed **72.66%** — the bot said **50.00%** and the dashboard
**72.67%**.

`src/utils/battle-calc.test.js` scans the repo for the model's distinctive constants and
fails if a second copy appears, so this cannot happen again silently.

## The model

Ship stats — CV = attack + defense:

| | attack | defense | CV |
|---|---|---|---|
| Destroyer | 2 | 1 | 3 |
| Cruiser | 8 | 16 | 24 |
| Battleship | 36 | 24 | 60 |

Starbase level *n*: `cv = round(4·1.5ⁿ) − 4`, `attack = defense = floor(cv/2)`.

**Survivors** (reverse-engineered in commit `fb2013f`):

```
lossFraction_own = Σ enemyCV / Σ(att + 2·def)_own      uniform across ship types
```

Race defense divides your own losses by `(1 + 0.12·RD)` and does not touch the enemy
(`0.11` before patch 6.0.0-beta, 2026-08-28 — see docs/game-rules.md's Race picks table).
Mathematics adds a small symmetric toughness term (`0.0015`/level) plus a `+12.5%` combat
bracket at a 6+ lead. Race attack, physics and player level do **not** change survivors.
The winning side always keeps at least one ship.

**Win %** is a separate logistic over the force ratio, the attack ratio and stat
differences. Force and attack enter as power laws, not linearly.

**Stale as of 6.0.0-beta**: the race attack bonus per point was also raised (7% → 8%), but
the win-% logistic's race-attack coefficients below were fit against the old 7% value —
they now under-weight race attack's effect on win chance. Not hand-tuned here; needs
recalibration against fresh post-patch in-game samples, same method as the original fit.

## Ground truth

`src/utils/battle-fixtures.json`. Every number in it is something the game reported.
**Never edit a fixture to make a test pass.**

The 2026-06 recalibration used 24 in-game samples, but the raw samples were never
committed — only summary numbers inside commit messages. Nine of them state their inputs
clearly enough to replay, and those are the fixtures. The rest are lost.

Current state of the harness:

- 9 win-% fixtures, worst error **0.37 pp**, gate at 1.5 pp
- 10 starbase CV levels, exact match required
- **0 survivor fixtures** — the survivor half of the model has no coverage at all,
  even though the UI presents those counts as exact

## Collecting new samples

Run `node src/utils/battle-calc.test.js` first. The coverage section lists which
dimensions have no ground truth; those are worth the most.

Two sources:

**1. The in-game battle calculator.** Set both fleets and both sides' stats, read the
predicted outcome. Fast, and it is what the current fixtures came from. It gives you the
game's own model, which is what we are trying to reproduce.

**2. Real battle reports.** Slower and noisier (you rarely control both sides' sciences),
but it is the only way to check that the in-game calculator matches actual combat.

Record every input. A sample without its sciences, races, player levels and starbase level
is not usable — that is exactly why the 2026-06 samples could not be recovered.

Add an entry to `winChance` in the fixtures file:

```json
{
  "id": "short-kebab-id",
  "desc": "what the fight was",
  "source": "in-game calculator, 2026-08-01, screenshot in <wherever>",
  "confidence": "observed",
  "def": { "fleet": [D, C, B], "starbase": 0,
           "physics": 0, "mathematics": 0, "raceAttack": 0, "raceDefense": 0, "level": 0 },
  "atk": { "fleet": [D, C, B],
           "physics": 0, "mathematics": 0, "raceAttack": 0, "raceDefense": 0, "level": 0 },
  "observedDefenderWinPct": 00.00
}
```

Survivor samples go in `survivors.cases` — the harness has a placeholder for them and the
coverage report flags the gap until they exist.

If new fixtures push the worst error above the gate, that is the harness working. Refit
the constants in `battle-model.js`, do not raise the gate.

## Calibration history

| Commit | Date | What changed |
|---|---|---|
| `db73cd5` | 2026-06-26 | last version of the bot's inline copy (the one that went stale) |
| `fb2013f` | 2026-06-27 | survivors recalibrated to `ΣenemyCV / Σ(att+2·def)`, ±3% |
| `eabbe83` | 2026-06-27 | +6 mathematics bracket |
| `2758b16` | 2026-06-27 | physics +6 win threshold, starbase result shown as a level |
| `807eecf` | 2026-06-27 | annihilated attacker means the defender wins |
| `0910caa` | 2026-06-28 | stats can overturn a 1.5× force deficit |
| `d029342` | 2026-06-28 | +6 math bonus halved to +12.5%, winner keeps ≥1 ship |
| `50d6c8c` | 2026-06-28 | removed the win-chance cliff in near-mutual wipes |
| `7853be9` | 2026-06-28 | +6 physics bracket halved |
| `7289025` | 2026-06-28 | win % weighs attack power, not just CV |
| `62232a3` | 2026-06-28 | 1.5× CV shortcut limited to same-ship-type fights |
| `243bdfe` | 2026-06-28 | physics & race attack refitted from 1000-v-1000 samples |
| `2cc1467` | 2026-06-28 | power-law force/attack; 24 samples, mean error 0.97%, max 4.0% |

## Known-approximate areas

Called out by the original calibration and still true:

- a starbase defending **alongside** a fleet (that combination skips the annihilation
  shortcut and falls through to the logistic)
- strongly asymmetric mathematics, where the game appears to resolve iteratively
- the survivor formula in general, which has no regression coverage
