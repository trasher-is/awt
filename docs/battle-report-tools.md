# Battle report exports and race evidence

## Export the archive

Open **Battle Reports**, select **CSV** or **JSON**, then choose one of two actions:

| Action | Included records |
| --- | --- |
| Export all reports | Every row stored in `battle_reports`, including unpublished reports and reports without a known location. The search query is ignored. |
| Export filtered results | Every matching row in the current search and sort order, including unlinked population drops. This includes matches beyond the 150 rows displayed in the table. |

The existing search covers player names, alliance tags, and system names. Filtered export
uses the last successfully completed search; the button is unavailable while a replacement
search is pending or has failed. It exports the database state at download time, so reports
synced since the table loaded may also appear. Empty results produce a valid empty export.

Both formats include all stored report columns (ship counts, losses, combat values,
participants, timestamps, location, and report metadata) plus the normalized fields shown
in the feed. `record_type` distinguishes `battle_report` from `population_drop`; the latter
has null report-only fields and explicit old/new population values. Exports contain only
data already stored by the hub and never fetch missing details from the game.

JSON is a versioned object with `schema_version`, `exported_at`, `scope`, `filters`, `total`,
and `records`. It preserves nulls and exact text. CSV uses UTF-8 with a BOM, quoted text,
CRLF rows, and empty cells for nulls. Potential spreadsheet formulas in text cells receive
a leading apostrophe; use JSON when exact original text is required.

Authenticated members and guests can download the same shared intelligence they can
already view. Keep downloads private: they can contain player intelligence. Do not commit
them, attach them to public issues, or use captured reports as test fixtures.

## Update a player's race range

Player profiles now include **Race evidence from battle reports** and an **Update from
battle reports** button. The action recalculates from that player's stored reports and
saves a separate, dated assessment. A result saved by an earlier version of the method is
not shown; press the button again to recalculate. It shows percentage ranges for Attack and Defence,
the number of usable reports, links to evidence, and reasons other reports were excluded.

These are **conditional compatibility ranges**, not confidence intervals or probabilities.
The supported candidate set is the same `-4…+4` pick range used by the hub's calculators;
the full combat-trait range has not been separately verified. Under the v6 coefficients,
the starting Attack range is `-32%…+32%` and Defence is `-48%…+48%`. A single compatible
pick is still a model-based estimate, not confirmed bio.

Each eligible report intersects the remaining Defence candidates. More informative
reports can narrow the range; duplicate, incomplete, or uninformative reports cannot
manufacture certainty. If no candidate fits the observations, the card reports a model/data
conflict instead of choosing the nearest value. Recalculating after correcting or removing
evidence can widen the range.

**Bio always wins.** A previously recorded `has_intel=1` locks the button, including neutral
zero race picks and expired-but-recorded bio. Native live intel also locks the UI before
its background sync completes. The server checks the current bio flag inside an immediate
transaction and conditionally saves only when `has_intel=0`, returning HTTP 409 otherwise.
A later bio scan suppresses an older estimate. Inference never writes `race_*`, science,
`has_intel`, or `intel_updated_at`, and does not feed estimates into the battle calculator,
Discord, or confirmed race archives. Read-only guests can inspect saved results but cannot
update them.

## Why science and player level do not become a false race bonus

The existing [battle model](battle-model.md) separates win probability (Attack/Physics)
from survivor losses (Defence/Mathematics). Its constants are reused, not copied into a
second formula. The model includes these effects:

| Modifier | Existing standard-server model |
| --- | --- |
| Race Attack / Defence | `1 + 0.08 × ATK`; `1 + 0.12 × DEF` |
| Physics | Absolute-level factors `1 + 0.01491 × Physics`, plus a relative `1.25` advantage at a gap of at least 6 levels |
| Mathematics | Own absolute factor `1 + 0.0015 × Math`; toughness bracket `1.25` for a lead of at least 6, `0.75` for a deficit of at least 6, otherwise `1` |
| Player level, win probability | Approximately 1% per difference level (`0.00995` model coefficient), gated per side on fielding all three fighting ship types |
| Player level, survival | `1 + 0.01 × max(0, ownPL − enemyPL)`, only when the own fleet fields all three fighting ship types |

These modify combat factors; they are not flat percentage points added to the displayed
win chance. The specific science/PL formulas are documented calculator observations in
the existing model, not claims that the changelog publishes the complete formula.
The official [Player Level](https://portal.astrowars.mudflatgames.com/glossary/player-level/),
[Mathematics](https://portal.astrowars.mudflatgames.com/glossary/mathematics/), and
[Physics](https://portal.astrowars.mudflatgames.com/glossary/physics/) glossary entries
corroborate the mixed-fleet 1% PL rule and six-level 25% science brackets. Those entries
predate v5's switch to multiplicative bonuses; the calibrated model supplies the detailed
formula. The live [GameOptions](https://astrowars.games/About/GameOptions), checked on
2026-09-12, has no standard-server PL cap (`MaxPlayerLevelBonus=null`) and disables combat
artefacts (`CombatArtefacts=False`).

Reports do not record historical sciences or player levels, and the hub keeps only
current values, not their history (#277). Using today's values as the values at an older
battle would create false precision. The inference therefore measures each report against
a **known side** and treats the player's own historical stats as unknowns under ceilings:

- **Known side.** The opponent in the report must have bio intel recorded within 48 hours
  of the battle: our own member (same alliance means full intel) or a scouted player
  outside the alliance. That intel supplies the opponent's race, Physics, Mathematics and
  player level. A report whose opponent has no bio is skipped as `no_known_side`; one whose
  opponent intel is further than 48 hours from the battle is skipped as
  `ally_stats_unknown`. The largest gap used is saved as `known_side_intel_max_age_hours`.
- **Ceilings for the player.** Their Mathematics at the battle is anywhere from 0 to their
  current public science level, and their player level anywhere from 0 to their current
  level. Both are assumed not to go down within one incarnation of an account; the resign
  cutoff below ends an incarnation. An unfilled or zero science level is unknown, not a
  ceiling of zero (`science_level_unknown`). Player level matters only when the player's
  fleet fields all three fighting ship types; then a missing level is
  `player_level_unknown`.
- **The model, backwards.** For each Defence pick, the card runs `AWBattleModel.simulate`
  with the known side's stats and every Mathematics level up to the ceiling (and both ends
  of the player-level range). A pick stays when some combination reproduces the player's
  surviving ships of every type within 1.5 ships. The model's constants are reused, not
  copied into a second formula.

Because the opponent's Mathematics and the player's ceiling are known, the Mathematics
bracket and the player-level bonus are bounded on both sides. Observed winning losses then
exclude high **and** low Defence picks: heavy losses rule out high picks, good survival
rules out low ones. With large, clean reports a single compatible pick is common. It is
still a model-based estimate, not confirmed bio.

Attack remains at the full supported range. The stored `win_chance` column holds the dice
roll, not the win chance (see [battle-model.md](battle-model.md#the-win_chance-column-is-the-dice-roll)),
so the stored reports carry no usable win chance. Attack can be estimated only after the
report-page capture records the real win chance (#277). Wins, losses and dice are not used
as a substitute.

Only published, consistently identified winning sides with complete fleet and loss counts
are eligible. Losing-side losses are approximate in the game and are not used. Both fleets
must have internally consistent CV. A defender's starbase is allowed: its fleet's losses do
not depend on the starbase level. An attacker's losses do, so the starbase level must follow
from the defender's stored CV (fleet CV plus the CV of exactly one starbase level); when the
stored CV covers the fleet only, the report is skipped as `starbase_level_unknown`. Civilian
ships, an attacking starbase, unopposed encounters, winners with fewer than four fighting
ships, annihilated winners, and losses below rounding resolution are excluded. Each
fighting ship type allows 1.5 ships of rounding/model tolerance. No real player data is
used in tests.

To see how the current method behaves on real data without publishing it, run
`node scripts/battle-race-measure.js <copy-of-awt.db>` on a copy of the hub database. It
opens the file read-only and prints counts only: players narrowed, skip reasons, and the
results saved by earlier versions as a baseline.

The [official changelog](https://astrowars.games/Changelog), checked on 2026-09-12, confirms
the v6 race coefficients changed on 2026-08-28. The deployment hour is unknown, so inference
uses reports from 2026-08-29 UTC onward. The changelog also records fractional-survivor
random rounding and approximate losing-side losses in v5, and identifies battle artefacts
and the later 15% PL cap as RedZone-specific changes. This inference supports the standard
server; RedZone reports return an unsupported-ruleset assessment.

An ISO/SQLite Joined date or a detected restart sets a newer evidence boundary. Restart
clears the saved estimate and records a UTC cutoff; a subsequently changed Joined boundary
also hides an old estimate. Localized dates are never guessed. Undetected restarts or
unrecorded game-rule changes remain limitations of the stored evidence.

## API and deployment

- `GET /hub-api/intel/battle-reports-export?scope=all|filtered&format=csv|json`
  accepts the same `q`, `sort`, and `dir` as the search endpoint. Exports ignore pagination.
- `GET /hub-api/intel/player/:id/battle-race-inference` returns `has_bio` and the saved
  `inference`, or null when no current estimate is available.
- `POST` to the same player URL recalculates on the server. It accepts no client-supplied
  evidence or candidates. Authentication and write-role permissions apply.

Restart the hub after deploying and refresh open browser tabs. Startup applies additive
`players.battle_race_inference` and `players.battle_race_not_before` columns plus indexes on
both report participant IDs. There are no new state files, dependencies, production game
requests, or changes to the game's traffic budget. The existing database backup covers
the new columns. A round wipe deletes them with the player rows.

Exports materialize and sort the matching local archive in memory. There is no silent
record cap; very large archives can require noticeable server memory and response time.

Run `npm test` on Node 22. Focused suites cover complete exports beyond the old 5,000-row
source cap, both formats, CSV escaping, authentication, asynchronous search/download
behavior, interval containment across science/PL/rounding combinations, bio precedence,
restart boundaries, and profile states. All evidence is synthetic; production deployment
and live-profile acceptance require the human review/deployment workflow in `AGENTS.md`.
