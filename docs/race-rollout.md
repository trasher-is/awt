# Race evidence rollout and API statistics

The repository owner confirmed full game-administration approval on 2026-10-10.
The implementation therefore includes automatic **local** inference after ordinary
member syncs, and manual, admin-approved checks of pseudonymized evidence at Anthropic.
It creates no additional game requests and changes no game traffic budget.

Merge and deployment still follow `AGENTS.md`: a human reviews and merges the PR.
Provider checks are disabled by default with `RACE_LLM=0`. Enabling them needs a
server-side key and an explicit owner configuration change. Browser page loads never
initiate a provider call.

## Implemented sequence

| Issue | Delivered behavior | Acceptance still outstanding |
|---|---|---|
| #277 | Separate probability/dice columns; persisted consistency reasons; shared resign cutoff; dated public/planet history; nearest pre-battle combat snapshots; readonly aggregate measurement tool | Confirm the true probability selector and dice equality against production observations; measure last-day context coverage |
| #282 | Captured historical intel stays authoritative when today's intel changes; missing/stale captures stay unknown; current hard ranges include the subject level when the known opponent has all three ship types | Production-copy before/after counts, losing-side loss comparison and three blurred real hub screenshots |
| #278 | Shared deterministic likelihood matrices, 48-hour science windows, prior disclosure, conflicts/admin exclusions, model invalidation, calibration pairs and an admin-only shadow view | Raw posterior coverage is not calibrated; synthetic noise coverage was 99.26%, outside the requested 88–92% |
| #280 | Approval queue, direct admin check, pseudonymization, schema/reference/envelope checks, holds, replay tests, daily reservations/cost ledger and provider retention documentation | Paid quality evaluation on 30–50 synthetic packages, separately approved by the hub owner |
| #281 | Labelled cards, calculator comparisons, advisory incoming comparison, estimated True Power and read-only `!race`; current AI proof and calibration gates | Real later bio pairs must establish the calibration gate; checks remain off until configured |
| #315 | Optional `planet.statistics` availability for four categories; identity/observation-safe storage and opt-in Unicorn labels | The nested category schema has not been supplied/confirmed; no numeric rank, fleet or battle meaning is inferred |

These issues are referenced by the PR rather than automatically closed. Local test
success establishes code behavior; it does not establish the outstanding live or paid
acceptance measurements.

## Context interpretation

Existing report snapshots are immutable. New snapshots prefer the most recent observed
combat intel **before** the battle, within 48 hours and after that side's resign boundary.
The observation timestamp preserves its age. Legacy current-intel fallback remains age
checked, and cannot use a new race for a battle before the known side's restart.

A confirmed Joined/resign/rejoin transition invalidates the current bio flag while
retaining every historical race/science value and its observation timestamp. The
heuristic restart reset still preserves that data; a shared UTC eligibility rule
keeps observations before the identity boundary out of both estimators, member
calculations and estimated True Power. Fresh bio captured in the same sync is saved
normally, and real Bio/IR visible on the game page remains authoritative.

A dated public read after a battle supplies a science/level **upper bound**, not an
exact battle-time value. Earlier reads are lower bounds and never substitute for a
ceiling. Reported levels gained are removed from a later player-level ceiling.

Starbase history is recorded with the actual planet observation time. A report's own
combat value can identify its starbase; an undated or later planet scan cannot prove
the former level after a battle destroyed or replaced it. The shared builder retains
its named unknown/starbase skip reasons in that case. The history table alone is not
claimed as reconstructed battle-time starbase evidence.

The confirmed Victory cell remains legacy `win_chance`/new `dice_roll`. No verified
selector for the separate attacker probability was available during implementation;
`att_win_chance` is accepted when explicitly supplied, and otherwise stays NULL.
The proposed inclusive equality is labelled provisional, not claimed as verified.

## Calibration and labels

The uncalibrated output range contains all hard-compatible picks. It is labelled a
**compatible range**, even after calibration; it never claims empirical 90% coverage.
Admin details separately show the raw prior-based 90% posterior mass set. The measured
evaluation and its limitations are in `race-inference-evaluation.json`.

Use in calculations requires at least 30 distinct players with calibration pairs,
ECE at most 5 percentage points, a nonempty high band with at least 90% accuracy,
raw posterior set coverage between 88% and 92%, the current model version, and a
current agreeing AI check of both traits with matching evidence hash. AI lowering a
band also lowers its eligibility. Bio intel remains authoritative. Incoming defence
keeps its existing worst-case headline and adds an eligible estimate as a comparison.

## Operator verification

Run `npm test` with Node 22. All suites use temporary databases and synthetic inputs;
provider tests replay responses, without network access or charges.

On an operator-provided **copy** of the production database:

```bash
node scripts/battle-context-measure.js /path/to/copy-of-awt.db
node scripts/battle-race-measure.js /path/to/copy-of-awt.db
```

Both tools report aggregate diagnostics; do not commit the copy or captured responses.
No new disk-state filename is introduced. The nine additive tables live in the existing,
ignored `awt.db`. Back it up before deployment. Round reset removes evidence, estimates,
checks, approvals and context histories while retaining `llm_calls` cost accounting.

Further details: [AI checks](race-ai-check.md),
[estimator and evaluation](battle-model.md),
[display policy](race-estimate-display.md),
[API statistics](api-planet-statistics.md).
