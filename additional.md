# Additional data — status update

## Round 3 resolved the two items this file used to list

The prior version asked for: (1) a second fleet composition to confirm the player-level survivor
formula, and (2) a denser two-sided player-level grid. Round 3
(`scripts/battle-harvest/pl_science_cases.py` / `pl_science_results.jsonl`, 735 cases) did both,
and the results **overturned** rather than confirmed round 2's formula — see `results.md`'s
"survivor formula was restructured" section. Short version: the player-level survivor bonus is
`1 + 0.01·max(0, ownPL−enemyPL)` (a clean line through the origin, no jump), and mathematics'
"diff-based" survivor bonus from rounds 1–2 was actually an absolute-own-level effect that had
never been separated from the gap because the enemy's math was always 0 in every test that found
it. Both are now fixed in `model.py` and confirmed against multiple fleet compositions and CV
scales.

## What's still open

1. **`K1-triple-interaction`'s extreme-combination misses.** 120 fully-random cases crossing
   player level, physics, and mathematics simultaneously (no race mods) mostly fit to a few
   thousandths of a ship, but a handful of cases with a large player-level gap (~26) stacked with
   a math malus and a physics gap near the win% certainty threshold miss by hundreds of ships —
   in one case because the model's win% call incorrectly landed on the deterministic 0%/100%
   annihilation boundary when the true fight was close but not deterministic. Worth a dense grid
   right around where `|lneff|` approaches `ln(1.5)` with several modifiers active at once, to
   pin down whether the calculator's own boundary is slightly different from the pure two-scalar
   force term's boundary once race attack/physics/player-level are all pushing at once.

2. **Round 2's `R1-realistic-random`/`R6-realistic-random-2` blocks** (2600+780 cases combining
   race attack/defense with player level and math/physics on fully random 3-type fleets) still
   show real survivor error (mean 33–53 ships) in the latest validation run. This predates the
   round-3 survivor-formula fix and hasn't been re-examined since — worth checking whether
   re-running those specific cases through the corrected model closes most of the gap (a lot of
   it may have been the same math-term mislabeling) or whether something else is still missing,
   before generating any new cases for it.

3. **Multiplier order.** All four survivor multipliers (math absolute level, math ±6 bracket,
   race defense, player level) are currently applied as one product; no harvested case varies
   more than one of them away from a shared baseline at once, so the order (irrelevant for a
   pure product, but relevant if any of them turns out not to be purely multiplicative) has never
   been independently tested.

4. **The 0.813 CV/attack-value blend weight for win%** is still the least-attested constant in
   the whole model — not a clean fraction, and composition-invariance testing is reassuring but
   doesn't pin it down tighter than roughly ±0.01.

## Superseded files

`scripts/battle-harvest/additional_cases.py` (159 cases, the original mixed-fleet
composition-invariance question — answered a different way, see `results.md`) is kept for
reference but was never run and isn't part of current confidence figures.
