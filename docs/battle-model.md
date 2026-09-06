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

**REPLACED 2026-09-06.** The logistic-regression fit described further down (force/attack
power laws, `WIN_RA`/`WIN_PHYS`/`WIN_LVL` coefficients) is gone. It's been reverse-engineered
directly from the live calculator at astrowars.games/About/BattleCalculator instead —
~4200 real POST requests across four harvest rounds (`scripts/battle-harvest/` in this
repo), producing a closed-form formula rather than a regression. See that directory's
`data.md`, `results.md` and `additional.md` for the full derivation and confidence numbers;
the summary here is what actually shipped.

Ship stats — CV = attack + defense — are unchanged:

| | attack | defense | CV |
|---|---|---|---|
| Destroyer | 2 | 1 | 3 |
| Cruiser | 8 | 16 | 24 |
| Battleship | 36 | 24 | 60 |

Starbase level *n*: `cv = round(4·1.5ⁿ) − 4`, `attack = defense = floor(cv/2)` — also
unchanged and confirmed exact for all 20 levels.

Four mechanics, two outcomes, **no cross-interaction between them**:

**Win %** — Race Attack and Physics, both additive log-odds terms:

```
lneff =  w·ln(CVatk/CVdef) + (1−w)·ln(ATKatk/ATKdef)         force/attack blend
       + ln(1+0.08·RAatk) − ln(1+0.08·RAdef)                  race attack
       + ln(1+0.01491·PHatk) − ln(1+0.01491·PHdef)            physics, below its bracket
       ± ln(1.25)                   if |PHatk−PHdef| >= 6     physics bracket
       ± ln(1+0.00995·|PLatk−PLdef|)                          player level, RAW DIFFERENCE
```

capped at `|lneff| <= ln(1.5)` (a certain win/loss beyond that — the old "1.5× shortcut",
now derived rather than hand-tuned), then run through a saturating curve:
`winFrac = 1 − 0.5·(1−x)^1.805`, `x = 2·(R−1)`, `R = e^|lneff|`.

The blend weight `w` is `0.813` for any 2-3-type mix, but for a **pure single-type duel**
it's pair-specific: `0.807` destroyer/cruiser, `0.760` battleship/destroyer, `0.816`
battleship/cruiser — each fits its pairing to <0.05pp in isolation, vs ~1pp for one global
constant. Reweighting the global constant or adding a defense-ratio third term both failed
to close that residual; a dense 90-point destroyer-vs-battleship sweep is what surfaced the
per-pair weights instead.

**Survivors** — Mathematics, Race Defense and Player Level, all multiplicative on your own
toughness (`1/lossFraction`), independent of each other and of win%:

```
lossFrac_own = min(1, enemyCV / ownToughness) / toughnessMultiplier

toughnessMultiplier = (1 + 0.0015·ownMath)                    OWN ABSOLUTE level, not the gap
                     × (1.25 or 0.75 if |ownMath−enemyMath| >= 6, else ×1)
                     × (1 + 0.12·ownRD)
                     × (1 + 0.01·max(0, ownPL−enemyPL))        only if this side has all 3 types
```

`ownToughness = Σ(att + 2·def)` over the fleet, or — for a starbase defending with **no**
fleet at all — its own `att + 2·def` (`att = def = floor(cv/2)`), since a fleet-only
denominator is 0 with nothing to fight with. Physics and Race Attack never touch
survivors. Player level never touches anything unless the side has destroyers **and**
cruisers **and** battleships.

**Annihilation**: the loser of a fight that hit the certainty cap is wiped to 0 survivors —
overriding whatever the CV-ratio formula alone would say. The winner is unaffected.
Separately, a side whose own `lossFrac` (after the toughness multipliers) reaches **or
exceeds** 1 — which needs a race-defense or mathematics malus, since the base ratio alone
is capped at 1 before the multiplier is applied — floors at exactly 1 survivor, never 0,
unless that side is also the certain loser above (which takes priority and zeroes it).
Landing on *exactly* 1.0, not just past it, still floors: five otherwise-identical
mathematics-bracket samples all showed 1 survivor at a malus that exactly cancelled the
base ratio, not 0.

**Two things that look similar but aren't** (both cost real accuracy the first way):

- The player-level win% term is applied to the **raw difference** `(PLatk − PLdef)` as one
  number, not as `ln(1+k·PLatk) − ln(1+k·PLdef)` computed per side. A 121-point two-sided
  grid showed the true term depends on the difference alone — same log-odds value for every
  pair sharing a difference, regardless of the absolute levels — and the two forms diverge
  by up to 2.7pp once both sides carry a large, comparable player level.
- `0.0015`/level is your **own absolute** math level, not a gap to the enemy. Every earlier
  test that found "0.0015/level of advantage" held the enemy's math at 0, so "gap" and "own
  level" were the same number. The `±6` bracket, unlike the slope, genuinely is gap-based.

**Known remaining gap**: fleets mixing 2-3 ship types on either side fit noticeably worse
than a pure single-type duel — mean error ~0.3pp, worst observed 5.8pp in a 1673-case
realistic-scale dataset, vs <0.1pp almost everywhere else. A CV-share-weighted average of
the pairwise weights was the natural next fix and made every mixed-fleet case **worse**, so
the flat 0.813 fallback stands as the best known approximation.

## Ground truth

`src/utils/battle-fixtures.json`. Every number in it is something the game reported.
**Never edit a fixture to make a test pass.**

The original 2026-06 recalibration used 24 in-game samples, but the raw samples were never
committed — only summary numbers inside commit messages. Nine of them state their inputs
clearly enough to replay, and those are the original 9 `winChance` fixtures. The rest are
lost. On 2026-09-06 the model was replaced (see above) and the fixtures file gained:

- 4 more `winChance` fixtures (mathematics/race-defense-don't-move-win% regression guards,
  a lone starbase, and a same-type force-ratio point inside the smooth 1×-1.5× zone), all
  pulled from `scripts/battle-harvest/results.jsonl` — real live-calculator observations,
  same provenance standard as the original 9.
- `survivors.cases`, previously empty, now has 8: a no-modifier baseline, the documented
  72.66% reference fight re-checked on survivors, race defense bonus/malus, mathematics
  below and above its bracket, a lone starbase, and the loser-of-a-certain-fight
  annihilation rule. `battle-calc.test.js` now actually validates these against
  `model.simulate()` (`survivorMaxErrorUnits` gate) — it used to only check the array was
  non-empty.

Current state of the harness:

- 13 win-% fixtures, worst error **0.75 pp** (a lone starbase — the win% side of the model's
  known mixed/starbase gap), gate at 1.5 pp
- 10 starbase CV levels, exact match required
- 8 survivor fixtures, worst error **0.005 units**, gate at 0.5 units

Adding these fixtures caught two real bugs before they shipped: a lone starbase (no
defending fleet) was taking zero losses regardless of attacker size (the fleet-only
toughness denominator was 0 with nothing to divide by), and the "floor survivors at 1, not
0" rule wasn't triggering when a malus landed *exactly* on a loss fraction of 1.0 — only
when it went strictly past. Both are fixed in `battle-model.js`; see its survivors() doc
comment.

One display quirk worth knowing about if you're reading the calculator's own screen rather
than harvested JSON: its "Starbase" survivor row does **not** show a CV fraction. For a
level-11 starbase (CV 342) reduced to 142 remaining CV, the calculator displays `8.85`,
not `0.4152` (the fraction) or `142` (the CV). That number is 142 re-expressed as a
fractional "effective level" by linearly interpolating between the two integer starbase
levels whose table CV brackets it (level 8 = 99 CV, level 9 = 150 CV →
`8 + (142−99)/(150−99) = 8.84`, matching to within rounding). `survSB` in the model is the
plain CV fraction (`0.4152` here) — converting that to the calculator's own display format
is a UI concern, not something the model itself needs to do.

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

| Commit / date | What changed |
|---|---|
| `db73cd5` (2026-06-26) | last version of the bot's inline copy (the one that went stale) |
| `fb2013f`–`2cc1467` (2026-06-27/28) | the original logistic-regression calibration: 24 in-game samples, survivors to `ΣenemyCV / Σ(att+2·def)`, power-law force/attack terms, mean error 0.97%, max 4.0% — see git history on this file for the individual commits, no longer reproduced here since none of those constants ship anymore |
| 2026-09-06 | **replaced entirely.** Reverse-engineered from ~4200 live-calculator POSTs across four rounds (`scripts/battle-harvest/`) instead of fit as a regression. Corrected: race defense 12% (not the pre-patch 11%), math bracket ±25% (not ±12.5% — the old regression had halved it), the starbase-alongside-fleet and asymmetric-mathematics cases (both now modelled exactly, see below), and two bugs the new fixtures caught immediately (lone-starbase toughness, the exact-lossFrac=1.0 floor boundary) |

## Known-approximate areas

- **Mixed 2-3-ship-type fleets** — the one substantial remaining gap, see "The model" above.
  Not present in single-type-vs-single-type fights or in any single-modifier test; only
  shows up when several ship types and several modifiers are all active on a realistic-scale
  fleet at once.
- The 0.813 mixed-fleet blend weight is the least-attested constant in the model (not a
  clean fraction, unlike everything else).

**No longer approximate, contra the old version of this section**: a starbase defending
alongside a fleet (mean ~0.06pp error across the harvested data) and a large mathematics
gap (mean ~0.00pp — the "iterative resolution" suspected here turned out to be the
absolute-level/gap mislabeling described above, not anything iterative). Both are now
modelled exactly rather than skipped past.
