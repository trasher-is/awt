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

**Win %** — force, race attack, physics and player level as log-odds terms:

```
lneff =  ln(S_att / S_def)                                    force
       + ln(1+0.08·RAatk) − ln(1+0.08·RAdef)                  race attack, 8% per pick
       + ln(1+0.015·PHatk) − ln(1+0.015·PHdef)                physics, 1.5% per level
       + ln(EDGEatk) − ln(EDGEdef)                            physics bracket + player level

S    = Σ ships × (3·attack + 2·defence)       destroyer 8, cruiser 56, battleship 156
     + starbase 3·att + 2·def                 att = floor(CV/2), def = CV − att

EDGEside = 1 + 0.25                       if this side is 6+ physics ahead
             + 0.01·(ownPL − enemyPL)     if this side is ahead in level AND fields all 3 types
```

The physics bracket and the level advantage are percentages that **add** inside one factor
per side. A side that is behind gets nothing from either; the enemy's factor carries the gap.

capped at `|lneff| <= ln(1.5)` (a certain win/loss beyond that), then run through a
saturating curve: `winFrac = 1 − 0.5·(1−x)^1.79375`, `x = 2·(R−1)`, `R = e^|lneff|`.

**The strength rule replaced every blend weight.** The model used to blend a CV ratio and an
attack ratio with a weight `w` that had to be fitted separately per pairing (0.807, 0.760,
0.816, 0.7745, 0.830, 0.7845) and approximated by 0.813 for any mix. Those per-pair weights
turned out to be transitive, the signature of one strength value per ship: they are exactly
`3·attack + 2·defence`. A starbase with an odd CV gives the extra point to defence (level 8:
attack 49, defence 50); using CV/2 for both was 0.36pp off at level 8 and 4.5pp at level 2.

With these rules, all 2,956 non-certain calculator readings on record (the September harvest,
the 641-case sweep, 206 bonus-free mixed fights and 17 hand readings) match within **0.01pp**,
the calculator's own display rounding. The constants are clean (8%, 1.5%, 25%, 1%) except the
curve exponent, a joint fit.

**Survivors** — Mathematics, Race Defense and Player Level on your own toughness
(`1/lossFraction`), independent of win %:

```
lossFrac_own = min(1, (enemyCV / ownToughness) / toughnessMultiplier)

toughnessMultiplier = (1 + 0.0015·ownMath)                    OWN ABSOLUTE level, not the gap
                     × (1 ± 0.25 [if |ownMath−enemyMath| >= 6]
                          + 0.01·max(0, ownPL−enemyPL))        level only if this side has all 3 types
                     × (1 + 0.12·ownRD)
```

The cap comes **after** the multiplier: a side facing far more enemy CV than its toughness is
wiped even with a large bonus. (Capping first, `min(1, ratio) / multiplier`, let a side with a
×2 multiplier keep half its fleet against any odds.) The maths bracket and the level advantage
add in one factor, as on the win side.

`ownToughness = Σ(att + 2·def)` over the fleet, **plus** the defending starbase's own
`att + 2·def` (`att = def = floor(cv/2)`) whenever there is one, with or without a fleet
beside it. The fleet and the starbase then lose the same fraction. Before 2026-10-04 the
starbase was left out whenever a fleet also defended; that put the starbase 0.49 levels off on
average across the 816 recorded starbase + fleet observations, and wiped starbases the
calculator leaves standing (100 destroyers vs 50 destroyers + level 9: the calculator shows
the starbase at level 6.11, the old formula at 0). Counting it gives 0.13 levels there and
0.01-0.05 on six new calculator readings. Physics and Race Attack never touch
survivors. Player level never touches anything unless the side has destroyers **and**
cruisers **and** battleships.

**Annihilation**: the loser of a fight that hit the certainty cap is wiped to 0 survivors —
overriding whatever the CV-ratio formula alone would say. The winner is unaffected.

**The one-survivor floor** (when the fight is not certain):

- A side of **5 or more ships** always keeps at least one ship of its type with the most total
  **defence** (destroyer 1, cruiser 16, battleship 24 per ship). That type is lifted to 1 when it
  would keep less; the other types keep their own fractions. 140 destroyers + 9 cruisers that are
  wiped keep 1 cruiser (defence 144 vs 140).
- A side of **4 ships or fewer** gets no floor and can lose everything.
- A **starbase defending alone** keeps level 1 when its loss reaches 100%. Beside 5+ ships the
  floor goes to a ship and the starbase can reach 0.

24 of 24 calculator cases with 5+ ships were lifted, 49 of 49 with 4 or fewer were not, and 16
of 16 lone starbases kept level 1.

**Two things that look similar but aren't** (both cost real accuracy the first way):

- The player-level term depends on the **difference** in level, not on each side's absolute
  level (a 121-point two-sided grid). It counts **only for the side that is ahead**, and only
  if that side fields all three ship types. Charging the whole gap whenever one side had all
  three types was up to 68pp wrong.
- `0.0015`/level is your **own absolute** math level, not a gap to the enemy. Every earlier
  test that found "0.0015/level of advantage" held the enemy's math at 0, so "gap" and "own
  level" were the same number. The `±6` bracket, unlike the slope, genuinely is gap-based.

**Known remaining gap**: none measured in the win %. The curve exponent 1.79375 is fitted,
not derived; the game may compute the curve differently with the same values.

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

On 2026-10-04 it gained the starbase shapes real battles use (almost every stored report is
destroyers against a starbase, alone or with a destroyer fleet):

- 10 `winChance` fixtures read off the in-game calculator by hand: lone starbases at levels
  4-13 near 50%, one with sciences and race set, the physics ±6 bracket against a starbase
  (gap 6 vs gap 5), and two near-even starbase + fleet fights. Re-reading two September points
  first gave the same numbers to the last digit, so the calculator had not changed.
- 2 `survivors.cases` from the harvest (`block 4-sb-plus-fleet`): a starbase defending
  beside destroyers and beside cruisers. The calculator shows the starbase row as an effective
  level; those entries convert it to the CV fraction the model computes.

Against the model before that date, 7 of the new win fixtures and both survivor fixtures fail
(worst 2.29pp and 13.7 ships).

Later the same day a **641-case sweep** of the calculator, run from a member's logged-in hub tab
through the proxy and its 5/s gate (75% mixed fleets, sciences 10-40, level gaps to 40, every
race pick, plus the starbase shapes real battles use), surfaced the level, additive-bonus,
cap-after and floor rules above. It added 10 `winChance` and 6 `survivors.cases` fixtures, each
the case the previous model got most wrong for its rule (up to 68pp and 496 ships off).

A **second sweep** (206 mixed fights with all sciences, levels and race at 0) isolated the force
term and surfaced the strength rule and the odd-CV starbase split. It added 6 more `winChance`
fixtures (two-type, three-type, size-invariance, off-even, starbase level 2).

Current state of the harness:

- 39 win-% fixtures, worst error **0.07 pp** (`phys-diff-6-threshold`, a June sample), gate at
  1.5 pp; every fixture must also sit inside the band `winBand()` shows for that fight
  (±0.1pp, printed to one decimal, since 2026-10-04)
- 10 starbase CV levels, exact match required
- 16 survivor fixtures, worst error **0.024 units**, gate at 0.5 units

Against all recorded calculator data (2,956 non-certain readings), the win % is within 0.01pp
and the surviving CV within 0.5% of the calculator.

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
| 2026-10-04 (band) | Win-chance band narrowed ±1 → ±0.1pp and printed to one decimal; the hub calculator and `!battle` now pass the attacker's fleet to `winBand()`; their "survivors have no test coverage" notes replaced |
| 2026-10-04 (round 2) | Force term replaced by strength `Σ ships·(3·attack + 2·defence)` plus the starbase's own `3·att + 2·def` (odd CV: defence gets the extra point); every blend weight removed. Constants made clean: physics 1.5%/level, level 1%/level; curve exponent refitted to 1.79375. All 2,956 non-certain readings within 0.01pp. Mixed-fleet band +1pp → 0. 6 win fixtures added |
| 2026-10-04 (sweep) | Fitted to a 641-case calculator sweep: level term only for the side ahead with all three types; physics/maths bracket and level advantage add in one factor; survivor loss capped after the multiplier; one-survivor floor (5+ ships, largest-defence type; lone starbase keeps level 1); lone-starbase weights for cruisers and battleships; destroyers vs destroyers + starbase weight slides with fleet share. Mixed-fleet band ±6 → ±2pp. 10 win and 6 survivor fixtures added |
| 2026-10-04 | Starbase fights: destroyers vs a lone starbase get blend weight `0.7745` (was the mixed `0.813`, 1.4-2.3pp low on the attacker), and a defending starbase's toughness always counts in the defender's loss fraction (was left out beside a fleet). Confirmed on 17 hand-read calculator results; 10 win and 2 survivor fixtures added. `battle-race-inference.js` now also skips a defender whose starbase level is unknown, since its fleet losses depend on it |

## Known-approximate areas

- **Win %**: nothing measured above 0.01pp. The curve exponent (1.79375) is the one fitted
  constant left in it.
- The displayed starbase level differs from the model by about 0.06 in some starbase + fleet
  fights with sciences set.

**No longer approximate, contra the old version of this section**: a starbase defending
alongside a fleet (win% mean ~0.06pp across the harvested single-type data; survivors
corrected 2026-10-04, see above) and a large mathematics
gap (mean ~0.00pp — the "iterative resolution" suspected here turned out to be the
absolute-level/gap mislabeling described above, not anything iterative). Both are now
modelled exactly rather than skipped past.

## What the model is *not* asked, and what the archive answers instead

The model answers "who wins". The hub's own battle archive says that question is, for most
real attacks, already decided before anyone presses launch. Taking every recorded report
that carries both fleets' combat values and sorting by the attacker's CV over the
defender's (968 battles as of 2026-09-22, produced by
`src/utils/battle-ledger.js`, formerly shown by the retired `!price` command):

| attacker CV / defender CV | battles | attacker won | attacker's fleet lost |
|---|---:|---:|---:|
| under 0.9x | 557 | 1.8% | 99.8% |
| 0.9–1.2x | 34 | 82.4% | 69.7% |
| 1.2–1.6x | 50 | 96.0% | 59.4% |
| 1.6–2.5x | 100 | 100.0% | 40.6% |
| 2.5–5x | 105 | 100.0% | 26.4% |
| 5–10x | 63 | 100.0% | 14.6% |
| 10x+ | 59 | 100.0% | 3.3% |

From 1.6x upward the attacker has not lost once in this archive. The column that still
varies — and that no calculator in this tool reports — is the one on the right: what
overkill buys is not the win, it is the fleet that comes home.

These are observed frequencies over one round's reports, not a law of the game. They are
also not a substitute for the model: the model knows about race bonuses, sciences and
starbases, which a CV ratio flattens. Where they disagree about a specific fight, the model
is the one with the mechanism; where the model has never been checked against outcomes,
this table is the check.

### The `win_chance` column is the dice roll

`battle_reports.win_chance` is scraped from the report's "Victory" row
(`public/js/scrapers/battle-report-parser.js`, whose comment calls that cell
"dice/win-chance"). It does not behave like a win chance:

- battles where it read 0–10 were won by the attacker **44%** of the time; battles where it
  read 90–100 were won **45%** of the time
- its Brier score against the outcome is **0.338**, worse than always guessing the base rate
  (**0.243**) — a calibrated probability scores below that, not above it
- it tracks `random_number` instead: mean absolute difference **0.47** over 1025 rows, and
  **42%** of rows match it exactly

Nothing renders the column today, so nothing is currently lying to anyone. It must not be
wired to a "win chance" label later. `storedWinChanceCheck()` in
`src/utils/battle-ledger.js` re-runs all three checks against live rows (it was the
Discord `!price check` until that command was retired), so this section can be verified
rather than believed.

### Per-battle stats snapshot

The inputs a battle needs beyond its ship counts (race attack and defense, Physics,
Mathematics, player level) are not on the report, and `players` only holds the **current**
value. Physics and Mathematics can climb several levels in a day or two, so a report read
a day later cannot be replayed through the real in-game calculator with any confidence.
Reports stored from 2026-10-01 on therefore carry a snapshot of both sides, taken in the
same request that first stores them:

| Column | Meaning |
|---|---|
| `stats_snapshot_at` | When the capture ran. **NULL = a legacy row**, never captured and never backfilled |
| `att_race_attack`, `att_race_defense`, `att_physics`, `att_mathematics`, `att_player_level` (and `def_…`) | The player's intel values at capture. **NULL = no intel on that player then**; a real `0` is stored as `0` |
| `att_intel_at`, `def_intel_at` | `players.intel_updated_at` at capture: how old the read already was |

Reading it:

- It is captured when the report is *synced*, normally minutes after the battle, not at
  battle time. Compare `*_intel_at` with `started_at`: sciences and level only rise, so a
  read from before the battle is a lower bound and one from after it an upper bound.
- Race attack and defense never change, so they are exact whenever present.
- The stamp dates the intel read. It does not promise that every science inside was
  re-read then, so a large gap is a reason for caution and a small one is not a guarantee.
- Old rows stay NULL on purpose: today's stats are not the stats of a battle last week.
- Nothing consumes the snapshot yet. It exists so battles can be checked against the
  real calculator while their stats are still known:

```sql
-- Reports with both sides' stats captured, newest first, with the calculator inputs
SELECT id, started_at, winner, random_number, att_luckiness,
       att_destroyers, att_cruisers, att_battleships,
       def_destroyers, def_cruisers, def_battleships, def_starbases,
       att_race_attack, att_physics, att_mathematics, att_player_level, att_intel_at,
       def_race_attack, def_physics, def_mathematics, def_player_level, def_intel_at
FROM battle_reports
WHERE stats_snapshot_at IS NOT NULL AND att_physics IS NOT NULL AND def_physics IS NOT NULL
ORDER BY id DESC;
```

### Race evidence runs the survivor model backwards

The battle-report race card (`src/utils/battle-race-inference.js`,
[battle-report-tools.md](battle-report-tools.md#why-science-and-player-level-do-not-become-a-false-race-bonus))
does not carry its own formula. For each Defence pick it calls `simulate` with the
opponent's recorded intel and every Mathematics level up to the player's public science
level, and keeps the pick when the winner's surviving ships come out within 1.5 ships of the
report. It uses only the survivor half of the model: Attack waits for a real win chance
(above).

Only the **winner's** losses are used. The official changelog calls losing-side losses
approximate, and they have not been checked against stored reports yet: comparing the
loser's losses with the model, for fights that were not at the certainty cap and did not
annihilate the loser, needs a copy of the production database (#282). Until that check is
done and written down here, the loser's losses stay out of the inference.
