# Game knowledge expansion — design

## Purpose

`docs/game-rules.md` has grown over several sessions into a terse, technical ground-truth
reference for awt's calculators and tools (formulas, tables, exact percentages). This project
has two goals:

1. Close known gaps in that technical reference so future tool code has more to work with.
2. Produce a second, separate document — `docs/player-guide.md` — aimed at new players
   joining an alliance, written in plain language rather than as a technical spec.

These stay separate files with different audiences and tone. `game-rules.md` never gains
onboarding prose; `player-guide.md` never becomes the technical source of truth — it cites
`game-rules.md` for exact numbers instead of duplicating them.

## Scope

### 1. Mine the old official glossary portal

`https://portal.astrowars.mudflatgames.com/glossary` (found via the `GlossaryUrl` key in the
live config API) is old and known to contain stale numbers, but may still hold mechanics not
described anywhere else. Treat it exactly like the "Astro Wars Glossary" CSV mined earlier
this session: extract candidate facts, present them to the user in batches, add only what's
explicitly confirmed. Never add a number from this source unconfirmed.

(`.../help-items`, the sibling URL from the same config key, 404s — dropped from scope.)

### 2. Close known gaps in `game-rules.md`

In priority order:

- Battleship attack/defense (currently 36/24 in `battle-model.js`, unverified against the
  in-game Battle Calculator)
- Player-level autogrowth formula (flagged unverified in the doc already — needs real data,
  not guesswork)
- Artifact acquisition mechanism — the doc has a cost/bonus table but never says how a player
  actually obtains an artifact
- Non-Aggression Pact (NAP) rules — not covered at all yet
- Market/price volatility — `VolatilityFactors.Artefacts` (100), `.ProductionPoints` (0.3),
  `.SupplyUnits` (4), and `StaticProductionPointsPriceIncrease` (1) are raw values pulled from
  the config API; their actual effect on live pricing is unconfirmed
- Exact count of game-created Unknown planets per 5-system spawn cluster (cluster mechanic
  itself is already documented; the Unknown count within a cluster is not)
- Solo/Unknown-owner vs. active-enemy planet capture — whether starting buildings differ
  (flat 4/4/4/4 vs. percentage combat damage) — flagged unconfirmed, still open
- Alliance member cap and kick/removal rules

Each item follows the same discipline used throughout this session: present the specific
claim, get explicit confirmation or correction, only then edit the doc. Fixes to existing doc
content the user flags along the way (independent of the above list) are handled inline as
they come up, not deferred to a separate pass.

### 3. `docs/player-guide.md`

New file. Two parts:

- **Part 1 — How the game works.** A plain-language walkthrough ordered the way a new player
  actually encounters the game (joining → home planet → population/growth → production →
  science → culture/expansion → economy/ships → combat basics → alliances/trade →
  scoring/winning). Sourced from facts already confirmed in `game-rules.md` — this is mostly
  a translation/reorganization pass, not new research, so it needs comparatively little
  back-and-forth. Cites `game-rules.md` by section rather than re-deriving numbers.
- **Part 2 — Strategy.** Playstyle archetypes, race-pick advice, common early mistakes,
  build-order priorities, artifact priorities. This is the user's personal play experience,
  not something derivable from mechanics alone — built via targeted interview questions,
  one topic at a time, drafted into prose for the user to correct/approve.

## Sequencing

1. Fetch and mine the glossary portal (batch-confirm).
2. Work through the gap list via targeted Q&A, in the priority order above.
3. Fix flagged doc issues ad hoc, whenever spotted, without blocking the rest.
4. Write `player-guide.md` Part 1 (mechanics translation).
5. Write `player-guide.md` Part 2 (strategy interview).

## Out of scope

- No changes to `game-rules.md`'s existing style/structure (still tables + formulas + terse
  prose, no onboarding tone creeping in).
- No code changes are anticipated by this spec itself — if gap-closing research surfaces an
  actual code bug (as it has in earlier sessions, e.g. the economy/ship-cost formula), that
  gets fixed as its own small change when found, same as before, not planned in advance here.
- No commitment to fetching further external sources beyond the glossary portal unless the
  user surfaces one.

## Verification

Same standard used throughout this session: never write a specific number or mechanic into
either doc without either (a) explicit user confirmation, or (b) a direct code/config
cross-check already established as authoritative (live config API, changelog, existing
calibrated model files). Anything sourced from the glossary portal is presumed stale until
confirmed, exactly like the earlier CSV batches.
