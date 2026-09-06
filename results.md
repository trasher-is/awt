# Reverse-engineering the battle calculator — results & confidence

Built from three harvested rounds:

- **Round 1**: [`data.md`](data.md), 1760 observations, 2026-09-06 — small-to-moderate fleets
  (up to ~1000 ships/CV ~13k), used to derive the base formula.
- **Round 2**: `scripts/battle-harvest/mixed_results.jsonl`, 1002 observations — tested three
  user pointers: the allied flag (confirmed inert), a claimed player-level science gate, and
  realistic end-game scale (CV 50k–180k, physics/math 30–40, player level 1–30). Case generator:
  `mixed_fleet_cases.py`.
- **Round 3**: `scripts/battle-harvest/pl_science_results.jsonl`, 735 observations — targeted
  two open items round 2 left: both-sides player-level interaction (round 2 only ever swept one
  side with the other fixed), and physics/math generalization across the 15–40 range. This round
  **overturned two of round 2's own findings** (see below) — the survivor-side player-level
  formula and the math bracket's mechanism were both wrong in ways only visible once both sides'
  values were crossed properly. Case generator: `pl_science_cases.py`.
- **Round 4**: `scripts/battle-harvest/debs_results.jsonl`, 90 observations — a dense
  destroyer-vs-battleship-only sweep, aimed at a ~1pp systematic residual round 3's own
  full-dataset refit couldn't explain by reweighting or adding a third term. Found and fixed two
  real formula bugs; see "Win% push to 99.5%" below. Case generator: `debs_sweep.py`.

No browser re-run was done for any round — there is no Playwright MCP connected in this session,
only a Chrome extension tool, and replaying cases through point-and-click browser automation
would take hours against the same server endpoint the HTTP harness already hits.

## Win% push to 99.5% (round 4)

Starting point going into this round: 91.5% of all 3497 win% observations within 1pp
(96.85% within 2pp), with two identified, well-characterized bottlenecks. Both turned out to be
genuine formula bugs, not just imprecise constants — fixing them moved the needle far more than
a constant refit would have.

**Bug 1 — player level's win% term was combined the wrong way.** The formula used
`ln(1+k·PLa) − ln(1+k·PLd)` (two independent per-side terms, subtracted) because that's what a
one-sided sweep (enemy's PL near 0) fits almost exactly. But a 121-point two-sided grid
(`G1-plgrid-mid`, all pairs from `[1,3,5,8,...,30]²`) showed the win-probability term is a
function of the **raw difference `PLa − PLd`** alone — every pair sharing the same difference
lands within <0.001 of the same log-odds value, regardless of the absolute levels. That's
`ln(1+k·(PLa−PLd))`, and it is *not* the same function as `ln(1+k·PLa) − ln(1+k·PLd)` except in
the limit of small `k` — the two diverge by up to 2.7pp once both sides carry a large, comparable
player level. Switching to the direct-difference form, with the **same already-known `k=0.00995`**,
dropped max error on that grid from 2.7pp to **0.03pp**. This alone took round 3's win% accuracy
from 80.95% to **100.00%** within 1pp, and the full three-round combined figure (player level
≤30, the tested range) from 91.5%/1pp to 97.7%/1pp and 96.85%/2pp to 99.50%/2pp.

**Bug 2 — the CV-vs-attack-value blend weight isn't one global constant.** `P_CV_WEIGHT=0.813`
fit every ship-type pairing to within ~0.3pp except destroyer-vs-battleship, which sat at a
stubborn ~1pp mean / ~1.02pp max that neither reweighting the global constant nor adding a
defense-ratio third term could close (that third term's best fit came out to weight ≈0, i.e. no
improvement). A dense 90-point destroyer-vs-battleship-only sweep (ratios from 0.05 to 20,
including many points inside the non-degenerate 0.667–1.5 CV-ratio band) let the weight be
refit for that pairing in isolation: **p=0.760** fits it to 0.01pp max error. Re-fitting the
other two pairs the same way: destroyer-cruiser p=0.807, cruiser-battleship p=0.816 — each
essentially exact (<0.05pp) on its own, while the saturation exponent `n≈1.79–1.81` stays
constant across all three. **The blend weight genuinely depends on which two ship types are
fighting.** `win_pct` now looks up a pair-specific weight for pure single-type-vs-single-type
duels (no starbase) and falls back to the global 0.813 for anything with 2–3 types on a side.

That fallback isn't a placeholder of convenience — it was tested against an alternative. The
natural generalization (compute a mixed fleet's effective weight as a CV-share-weighted average
over all attacker-type × defender-type pairs) was tried against every mixed-fleet block and made
every single one worse — e.g. `R2-composition-invariance` mean error went from 0.36pp to 1.38pp,
`J1-plsurv-cr-heavy` from 0.26pp to 2.74pp. Whatever the calculator does for a genuinely mixed
fleet, it isn't resolving pairwise sub-fights weighted by CV share; the flat global constant is
the better approximation currently known for that case, and remains the residual to close.

**Net result across all three rounds, restricted to player level ≤30 (the tested range;
round 1 also tested up to 200, which is out of scope and excluded here — those 213 cases average
4.1pp error purely from extrapolation, vs 0.000pp for the 7 in-range cases in the same block):**

| | Before round 4 | After round 4 |
|---|---:|---:|
| within 0.5pp | 84.4% | 95.4% |
| within 1pp | 91.9% | **97.7%** |
| within 2pp | 97.7% | **99.5%** |
| within 5pp | 99.9% | 99.9% |
| mean error | 0.25pp | 0.09pp |
| max error | 50.0pp (trivial edge case, now also fixed) | 5.8pp |

**99.5% is reached at a 2pp tolerance. At 1pp it's 97.7%.** What's left, per the per-block
breakdown, is concentrated almost entirely in genuinely mixed-composition fleets (`R1`/`R6`
fully-random blocks, `R2`/`R4`/`R5` composition tests, `J1-plsurv-*`) — every pure-duel and
every isolated-modifier block is now at or below ~0.1pp. Closing the mixed-fleet fallback
further needs a real structural finding, not another constant tweak; two ideas neither tried nor
ruled out: (a) whether the blend weight for a mix is driven by whichever single ship type holds
the *plurality* of a side's CV, rather than a CV-share-weighted average across all pairs; (b)
whether the true mechanism resolves a multi-type fight sequentially by ship class (Lanchester-
style) rather than via aggregate CV/Attack sums at all — which the pure-duel pairwise weights
would only coincidentally reproduce.

The working model is [`scripts/battle-harvest/model.py`](scripts/battle-harvest/model.py); the
validator covering all three rounds against the current model is `validate_all.py`.

## Update: the survivor formula was restructured after round 3

Round 2 fit the player-level survivor bonus and reported it as "provisional — checked on only
one fleet shape." That caveat earned its keep. Testing a second fleet composition in round 3
didn't just fail to confirm the round-2 formula — it also exposed that round 2's math-bracket
mechanism was mislabeled. Both are now fixed and confirmed against multiple fleet shapes and
scales:

- **Mathematics' survivor bonus is about your OWN absolute level, not the gap to the enemy.**
  Round 1 and round 2 both found "0.0015 per level of math advantage" — but every test that
  produced that number held the enemy's math at exactly 0, so "gap" and "own absolute level"
  were literally the same number and impossible to tell apart. Round 3 crossed both sides' math
  independently (base levels 15/20/25/30/35/40, gap ±12 at each) and found the effect present
  **even when both sides have identical, nonzero math** — it's `1 + 0.0015·ownMath`, full stop,
  regardless of what the enemy has.
- **The ±6-level bracket, on the other hand, IS gap-based** (confirmed at 6 different absolute
  bases): a clean ×1.2498 multiplier when you lead by 6+, ×0.7499 when you trail by 6+ — both
  landing on the already-known `MATH_BRACKET = 0.25`, applied as a flat ±25%, not as reciprocal
  multipliers (1/1.25 ≠ 0.75, but +25%/−25% from 1.0 does).
- **The player-level survivor bonus is `1 + 0.01·max(0, ownPL − enemyPL)`** — proportional to the
  fleet's own baseline toughness (confirmed identical 0.01 ratio across 3 composition presets ×
  2 CV scales), zero when you're not ahead, and a **pure straight line through the origin** —
  no jump between a 0-level and a 1-level lead. Round 2's fit of "+0.09 jump, then +0.0154/level"
  was an artifact: that sweep held both sides' math equal but nonzero, so the (then-undiscovered)
  absolute math term was silently baked into what looked like a player-level offset.

Direct proof of the round-2 error, since it's worth being concrete about getting something
wrong and finding out: at the same 100k-CV, 3-type fleet, math=35 both sides, `aPL=15/dPL=0`
gives 4943 destroyer survivors (round 2's number, still correct) — but `aPL=15/dPL=15` gives
**3985**, not 4943. Round 2 never tested equal-nonzero player levels on both sides at all.

All four survivor multipliers (math absolute+bracket, race defense, player level) are applied as
one product on `1/lossFrac`; their relative order isn't independently confirmed (no harvested
case varies more than one from a nonzero baseline), but order doesn't matter for a pure product.

**Confidence after the fix**, per round, own-side survivors within tolerance:

| Round | Win% within 1pp | Survivors within 1 ship | Survivors mean error |
|---|---:|---:|---:|
| 1 (`results.jsonl`) | 97.33% | 95.82% | 0.70 ships |
| 2 (`mixed_results.jsonl`) | 89.02% | 78.60%* | 32.7 ships* |
| 3 (`pl_science_results.jsonl`) | 80.95%** | 94.81% | 4.37 ships |

\* Round 2's remaining survivor error is almost entirely the two fully-random blocks
(`R1`/`R6`, 4260 of 5976 observations) — every *targeted* round-2 block (player-level gate,
boundary, composition-invariance) matches survivors to within a few thousandths of a ship.
\*\* Round 3's win% figure is pulled down by `K1-triple-interaction` (random PL × physics ×
math, no race mods) hitting the same win% annihilation-boundary sensitivity noted below; every
*other* round-3 block matches survivors to a few thousandths and win% to well under 1pp.

## What's still open (much smaller than before)

- **`K1-triple-interaction`** (120 fully-random PL×physics×math combos, no race mods): median
  survivor error is ~0.0003% of fleet size, 99.17% of observations land within 5% of fleet size
  — but a few extreme combinations (player-level gap near 26 stacked with a math malus and a
  physics gap near the win% cap) miss by up to several hundred ships or, in one case, trip the
  annihilation floor when the true fight wasn't actually deterministic. This looks like the
  win%/survivor annihilation-clip boundary being slightly mis-located under compound extreme
  inputs, not a new mechanic — worth a denser sweep right at the ln(1.5) boundary with PL/math/
  physics all simultaneously near their brackets.
- **Round 2's `R1`/`R6` random blocks** (which combine race attack/defense with player level and
  math/physics) still show real survivor error (~33–53 ships mean) that predates the round-3
  fix and hasn't been re-examined since — worth revalidating now that the survivor formula
  itself is corrected, since a chunk of that error may have been the same mislabeled-math-term
  bug rather than anything to do with race mods.
- The order of the four survivor multipliers (math, race defense, player level) relative to each
  other is assumed commutative (they're a pure product) but never independently isolated.
- The 0.813 CV/attack-value blend weight for win% remains the least-attested constant in the
  model.

## Update: player level, and the realistic-scale mixed-fleet gap

The original version of this document found the model broke down badly on fleets mixing
multiple ship types (85.57% within 1pp, mean error 4.37pp, worst miss 89.6pp) and flagged it as
the main open gap. Round 2 explains **and mostly closes** that gap — it wasn't really about ship
mixing; it was a completely undiscovered mechanic that round 1 had no way to see.

**Player level does something after all — round 1 said it didn't, because round 1 only ever
tested it on pure-destroyer fleets.** The user's pointer was exactly right about the trigger,
half right about the extra condition:

- **Confirmed: player level only affects anything when a side fields all three ship types.**
  A destroyer+cruiser fleet (no battleships) shows zero effect from player level at any value
  1–30, under any science combination — flat 50.00% every time. A destroyer+cruiser+battleship
  fleet shows a strong, smooth effect: attacker win% goes 51.78% → 90.34% as its own player
  level goes 1 → 30 (other side fixed), and survivors scale up with it too.
- **Not confirmed: the "Mathematics ≥ 15 (cruisers) / Physics ≥ 15 (battleships)" science gate.**
  Tested directly at the boundary (math/physics = 13, 14, 15, 16, 17, all 25 combinations) with
  player level at both 1 and 30: **identical win% on both sides of every boundary** — e.g.
  math=14/phys=14 and math=16/phys=16 both give exactly 51.78% at pl=1 and 90.34% at pl=30. The
  calculator does not enforce ship-buildability against the science fields at all; it only cares
  whether the ship counts are nonzero. (The user's in-game experience of this gate is very likely
  real — you can't field cruisers below Math 15 in the actual game — it just isn't a rule the
  standalone calculator itself checks.)

The formula (added to `model.py`, same architecture as every other modifier — additive in
log-space for win%, added to the earlier findings):

```
# win%, only if ALL THREE ship types are present on that side:
lneff += ln(1 + 0.00995·PL_atk)   -  ln(1 + 0.00995·PL_def)      # fit: max err 0.035pp, mean 0.010pp

# survivors, own side only, same 3-type gate, fit against ONE fleet composition:
1/lossFrac(pl) = 1/lossFrac_base + 0.09239 + 0.015423·(pl−1)     # pl >= 1
```

The survivors formula is **provisional** — it reproduces the one tested fleet composition to
within 0.15 ships across pl=1..30, but the `+0.09239` jump between an unobserved pl=0 and the
first tested pl=1 hasn't been checked against a second fleet shape, so it's unclear whether that
offset is a fleet-independent constant or specific to the composition it was fit on.

**Confidence at the user-specified realistic scale (CV 50k–180k, physics/math 30–40, player
level 1–30, mixed fleets, starbase, race mods) is now:**

| Tolerance | % of 1002 round-2 observations |
|---|---:|
| within 0.5pp | 79.94% |
| within 1pp | **89.02%** |
| within 2pp | **97.21%** |
| within 5pp | 99.90% |

Mean error 0.29pp, max 5.32pp — no case worse than that. Compare to the round-1-only mixed-fleet
figure this replaces (85.57% within 1pp, max 89.6pp): the player-level fix alone took the
*existing* round-1 dataset's worst mixed-fleet block from a 5.87pp/89.6pp mean/max down to
3.99pp/76.4pp too (that data still has some fleets with player level up to 200, far outside the
1–30 range this round calibrated, which explains the remaining large residuals there — not a
new failure mode, just an out-of-range extrapolation).

**Composition-invariance, re-tested at real scale**: the round-1 hypothesis that a mixed fleet
reduces to two scalars (aggregate CV, aggregate attack value) **holds much better than round 1's
catastrophic misses suggested**. Three fleet shapes matched to the identical total CV, fought
against the same defender, at 60k/100k/150k CV: de-heavy wins 52.7%, bs-heavy 50.6%, cr-heavy
44.2%, de+bs-only 56.8% — a real, composition-driven, non-flat spread (not the flat 50% a "CV is
all that matters" model would give), and **the existing 0.813/0.187 CV-vs-attack-value blend
already predicts this spread to within 0.07–1.1pp**, identically at all three scales. So the
two-scalar reduction was basically right all along; round 1's 89pp misses were something else
combining with mixed fleets, not the blend itself, and that something else turned out to be the
unmodeled player-level term.

## What's still open

- The survivor-side player-level formula's `+0.09239` offset needs a second fleet
  composition/CV to confirm it's universal, not fit-to-one-case (see "what to test next" below).
- The two P4-plevel-cross rows where *both* sides had large player levels simultaneously
  (15 vs 30) show ~2.7pp residual — small, but slightly worse than the ~0.01pp fit on isolated
  one-sided sweeps, hinting the log-additive combination of two player-level terms might not be
  perfectly clean at both being large. Not investigated further this round.
- The still-uncalibrated CV-vs-attack blend constant (0.813, not a clean fraction) remains the
  single least-attested constant in the whole model, though composition-invariance testing
  above is reassuring.
- Player level above 30 and mixed-fleet CV above 180k were explicitly out of scope this round
  (per the user's own note on realistic ranges) and are untested.

## Headline confidence (round 1, single/mixed split)

**Not at 95%. Split cleanly by fleet shape:**

| Scenario | Share of dataset | Win% within 1pp | Mean win% error |
|---|---:|---:|---:|
| **Single ship type per side** (destroyer-only, cruiser-only, etc., possibly + starbase/modifiers) | 1462/1760 (83%) | **99.45%** | 0.07pp |
| **Mixed fleets** (2–3 ship types on at least one side) | 298/1760 (17%) | **85.57%** | 4.37pp (max 89.6pp) |
| **All 1760 rows combined** | 100% | 97.10% | 0.80pp |

Survivors: **84.67%** of 4326 nonzero-fleet observations match within 1 ship overall (mean error
6.35 ships, dragged up by the same mixed-fleet cases).

So: every isolated mechanic — starbase, race attack, race defence, physics, mathematics, XP,
player level, the allied flag — is now solved to near-exact precision (see table below, several
components match **100% of samples exactly**). What is **not** solved is how those mechanics
combine when a fleet actually contains more than one ship type. That gap is concentrated in
17% of the dataset but is large where it occurs (worst single miss: 89.6 percentage points).
[`additional.md`](additional.md) lays out the next data-collection round aimed squarely at it.

## Per-component results

| Component | Formula | Confidence |
|---|---|---|
| Starbase CV | `round(4·1.5ⁿ) − 4` | **Exact**, 21/21 levels (`3-sb-alone`, `3-sb-frac`) |
| Starbase attack/defence | `cv/2` each | Exact, matches `4-sb-plus-fleet` residuals |
| Ship CVs | destroyer 3, cruiser 24, battleship 60 | Exact (unchanged from `battle-model.js`) |
| Survivors (isolated fleets) | `lossFrac = min(1, ΣenemyCV / Σ(attack+2·defence)_own)` | Exact to <0.01 ships, `2-*` blocks |
| Race defence | divides own loss by `(1+0.12·RD)` — **not** the old 0.11 | Exact, `8-racedef-1v1` all 9 values exact |
| Mathematics slope | `×(1+0.0015·Δ)` below the bracket | Exact, `6-math-grid` |
| **Mathematics +6 bracket** | `×1.25`, **not** `battle-model.js`'s `0.125`(current code is 2× too weak) | Exact — flat 1.25000 across Δ=6…12 |
| XP | `enemyCV` if own side ends with ≥2 surviving units, else `ceil(enemyCV/4)` | 3491/3492 side-observations (only miss: overflow probe) |
| Player level | no effect on anything | Exact, 78/78 samples bit-identical |
| Allied flag | no effect on anything | Exact, 40/40 matched pairs identical |
| Annihilation floor | loser of a **deterministic** (0%/100%) fight is wiped to 0 survivors, winner unaffected | Exact — confirmed at the single race-attack point that flips a fight from 0.31% to 0.00% |
| Win% — single ship type per side | see below | 99.45% within 1pp |
| Win% — mixed fleets | same formula, extrapolated | 85.57% within 1pp, **not reliable** |

## The win% formula (single ship type per side — high confidence)

```
lneff =  0.813·ln(CV_atk/CV_def) + 0.187·ln(Atk_atk/Atk_def)      [fitted: 151 points, max err 0.72pp]
       + ln(1+0.08·aRA) − ln(1+0.08·dRA)                          [confirmed exact vs 6.0.0-beta]
       + ln(1+0.0149·aPh) − ln(1+0.0149·dPh)
       + (ln(1.25) if aPh−dPh≥6 else (−ln(1.25) if aPh−dPh≤−6 else 0))

R = exp(min(|lneff|, ln(1.5)))         # the "1.5×" certainty threshold
x = 2·(R−1)
top = 1 − 0.5·(1−x)^1.805
winFrac = top if lneff≥0 else 1−top    # attacker's win chance if lneff was computed atk/def
```

This was derived, not guessed:

- **The 1.5× threshold is exact and scale-invariant.** Same-type mirror fights (`1-devde` etc.)
  are a clean **step function** of the force ratio: 0% below 1:1.5, 50% at parity, 100% above
  1.5:1 — confirmed by live probing every 0.01 of ratio near the boundary (win 99.20% at
  ratio 1.45, 100.00% at 1.4999+), and confirmed **independent of absolute fleet size** (ratio
  1.05 gives 58.61% whether the fleets are 20 ships or 20,000).
- **Reciprocal symmetry is exact**: `win(r) + win(1/r) = 100.00` to 3 decimals across 10 tested
  ratio pairs — this is what let the model use a signed `lneff` with one saturation curve
  instead of two.
- **The saturation curve `1 − 0.5·(1−x)^n` with n≈1.805** was fit from same-type ratio sweeps
  (`n` consistent to ±0.003 across 10 points from ratio 1.02 to 1.45) and holds for the
  race-attack and physics channels too when inverted through the same curve — that
  cross-validation is why the three channels are trusted to be additive in log-space.
- **The 0.813/0.187 CV-vs-attack-value blend** was fit against all 130 cross-type duels
  (destroyer vs cruiser, cruiser vs battleship, etc.) plus the documented 8-destroyer-vs-
  1-cruiser reference case (72.66%, exactly reproduced by this session's own harvest at
  both small and 1000×-scaled versions). Max residual 0.72pp, mean 0.02pp. **This is the
  weakest-attested constant in the model** — 0.813 isn't a clean fraction, and an
  `Attack^a·Defense^(1-a)` reparameterization fits 10× worse (SSE 0.0058 vs 0.0001), which is
  reassuring but doesn't rule out a cleaner form nobody tried yet.
- **Race attack is `ln(1±0.08·RA)` added at full weight**, not routed through the 0.187 channel —
  confirmed because routing it through that channel under-predicts the observed swing by
  30+ points (a hypothesis this session tested and rejected before finding the right one).
- **Physics has its own, much weaker slope (~1.49%/level) plus a separate `+25%` bracket at a
  6-level gap** — the full 13×13 grid (`5-phys-grid`) shows the bracket triggers on the
  **difference**, not either side's absolute level, and confirms the old in-game help text's
  "25% bonus at 6 levels" was right where `battle-model.js`'s halved math-bracket constant
  suggested a general distrust of that help text.

Max error across all 151 fitting points: 0.72pp. Max error across the full 462-row validation
set restricted to single-ship-type fleets (`1-*`, `2-*`, `7-*`, `8-racedef-1v1`, `9-*`,
`10-*`, `11-*`, math/physics grids): well under 1pp almost everywhere (see per-block table).

## Where it breaks: mixed fleets

Every block that isolates one variable (same-type mirrors, cross-type duels, race-attack grids,
physics grids, starbase alone) fits to well under 1pp mean error. The two blocks that combine
several ship types **and** several modifiers **at once** are dramatically worse:

| Block | n | Mean win% error | Max |
|---|---:|---:|---:|
| `12-random` (full-space random fleets + modifiers) | 220 | **5.87pp** | **89.62pp** |
| `13-edge` (1v1s, CV boundaries, maxed stats, overflow) | 38 | 1.49pp | 50.00pp |
| `8-racedef-mix` (race defence across ship *types*) | 54 | 0.33pp | 0.98pp |
| `4-sb-plus-fleet` (starbase + fleet, docs' known-approximate case) | 54 | 0.07pp | 1.17pp |

The worst single miss (`#1622`, 89.6pp) is not an edge case: 999 destroyers + 1 cruiser +
27 battleships attacking 400 destroyers + 1 cruiser + 80 battleships, both sides carrying
physics/math/race modifiers. The model says 10.38% attacker win; the calculator says 100.00%.

Two things are already ruled out as explanations:

1. **It isn't the additive log-combination of race attack/physics itself failing** — those
   channels validate to <0.1pp mean error whenever tested against a *single* ship type
   (`7-*`, `8-racedef-1v1`, `5-*`, `6-*`), including at fleet sizes of 1000+.
2. **It isn't starbase-alongside-fleet alone** — `4-sb-plus-fleet` (which mixes a fleet with a
   defending starbase, no multi-type mixing) is only mildly worse (0.07pp mean), not
   catastrophically wrong like `12-random`.

That leaves the CV/Attack-ratio blend itself: `0.813·ln(CV_atk/CV_def) + 0.187·ln(Atk_atk/Atk_def)`
was fit purely from single-type-vs-single-type duels, where "CV" and "Attack" are each a scalar
per side. The moment a side fields two or three ship types, this session doesn't know whether
the true calculator still reduces the fight to two scalar ratios, or resolves it some other way
(e.g. ship-class-by-ship-class, Lanchester-style) that only coincides with the scalar blend when
each side has one ship type. [`additional.md`](additional.md) is built to distinguish these.

## What changed vs. `battle-model.js` / `docs/battle-model.md`

- **Mathematics +6 bracket: `+25%`, not `+12.5%`.** `MATH_BRACKET = 0.125` in
  `public/js/utils/battle-model.js` is half the value this dataset supports (flat 1.25000×
  toughness across Δ=6…12, five decimal places of agreement). The old in-game help text the
  docs dismiss was right on this one.
- **Race defence divisor: `(1+0.12·RD)`, not `(1+0.11·RD)`** — expected, since
  `docs/game-rules.md` already documents the 6.0.0-beta patch raising this from 11% to 12%;
  this dataset confirms the *survivor* code hasn't been updated to match yet.
- **Race attack's true effect is far larger than the fitted logistic in `battle-model.js`
  assumes** — the docs already flagged this (fit against the pre-patch 7% value); this dataset
  is what a refit should use. At equal 1000-destroyer fleets, attacker win% goes
  8.00/15.47/25.03/36.57/50.00/64.51/78.85/91.66/99.69 across aRA = −4…+4.
- **Player level and the Allied flag have zero effect** in this calculator — not previously
  documented either way. Worth confirming whether `battle-model.js` reads either; if so, it's
  modelling behavior the live calculator doesn't have.
- **XP threshold is 2 surviving units, not 1**, and doesn't require owning a starbase — refines
  `docs/game-rules.md`'s "at least 1 starbase and at least 1 surviving ship" note.
