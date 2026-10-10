# Manual AI checks of race estimates

An AI check reviews the mathematical Attack/Defence estimate. It does not change
race or science values, choose targets, plan movement, or send requests to the game.
The feature is disabled by default (`RACE_LLM=0`). Approval to build the integration
does not demonstrate that a provider model reliably detects estimator errors.

A member requests a check; an administrator approves or rejects it in the queue.
Administrators can run checks directly. Guests cannot request them. Only a manual
approval or direct administrator action can start a provider call. There is no
scheduled processing or automatic retry. An approved request blocked by the switch,
budget or provider gate stays queued and can be retried manually.

The result belongs to the exact evidence, estimate, model and prompt version it saw.
A newly received report, evidence exclusion or recomputation invalidates the check,
including a report that arrived before the estimator recomputed. The old explanation
remains visible as outdated; it grants no AI-checked status. A supported disagreement
holds the estimate until an administrator explicitly releases it or keeps the hold.
A hold survives becoming outdated. A rejected response or unsupported numeric
contradiction never creates a hold. A provider failure leaves the numeric estimate.

Both traits must agree for `AI-checked`. `cannot_check` leaves the estimate alone.
The provider can request a one-step reduction of the displayed confidence band
(`high` → `medium` → `low` → `none`), with a reason, and can never increase it.
The confidence adjustment applies only to current evidence and does not rewrite the
stored distribution, range or most likely value. Calculation eligibility uses the
adjusted band. Explanations are AI-written text, not HTML or instructions.

## What leaves the server

The request builder uses an explicit allowlist. The subject is `S`; reports are
`R1`, `R2`, etc. It sends numeric distributions, candidate sets, fleets, whole-ship
losses, the attacker's observed win chance, relative intel age, science/level ranges,
inclusion flags, and model predictions at the selected estimate. It never forwards
database objects, names, tags, game/report ids, coordinates, system names or absolute
dates. The dice roll is not substituted for a win probability.

Predictions use the shared battle model. Unknown historical Physics and Mathematics
are enumerated from zero through their public ceiling, and historical player-level
endpoints bound the level effect. The envelope includes certainty/annihilation and
the estimator's own observation tolerances. The frozen system prefix reads constants
and ship statistics from the model; no battle coefficient is copied into a prompt.
Evidence not used by the estimator is explicitly marked as such.

Identifiers and dates are allowed only in a local fingerprint. Its digest invalidates
old checks; the source material never enters the provider body. The cost ledger keeps
token counts, model, cost, latency, error categories and hashes, not prompts or replies.
Round reset deletes requests and checks while preserving the accounting ledger. A
response that arrives after reset cannot recreate deleted intelligence.

## Configuration and cost

The credential is read only by the server's provider boundary. Set it through the
server environment; never put it in browser configuration. The checked settings are:

| Setting | Default |
| --- | --- |
| `RACE_LLM` | `0` |
| `RACE_LLM_MODEL` | `claude-opus-5-5` |
| `RACE_LLM_EFFORT` | `low` |
| `RACE_LLM_DAILY_BUDGET_USD` | `2` |
| `RACE_LLM_LANG` | `en` |

The first-party Opus 5.5 model id and prices were verified on 2026-10-10:
input $4, output $20, five-minute cache write $5, cache read $0.20 per million tokens.
See the [official model page](https://platform.claude.com/docs/en/models/opus-5-5/overview)
and [price list](https://platform.claude.com/docs/en/about-claude/pricing).

Before any network access, an immediate database transaction reserves the worst-case
cost of 32,768 input tokens at the cold-cache write price and 8,000 output tokens,
including thinking: $0.32384 for Opus 5.5. Input packages whose UTF-8 size plus framing
margin exceeds this bound are rejected locally. Reservations and completed charges
share the hard UTC-day budget, so concurrent calls cannot spend the same allowance.
Reported usage replaces the reservation; refusal/truncation still records billed
tokens. Missing credentials and other definite preflight failures cost zero. An
ambiguous provider failure retains the full reservation as a conservative charge.
An interrupted process's reservation is retained, while its request is failed after
two minutes to permit future manual calls. The ledger describes these conservative
charges; use the provider invoice for final billing reconciliation.

The provider gate allows one call in progress and at most one start per second,
independently of the game's traffic gate. SDK retries are disabled. The client timeout
is one minute. No provider call changes the agreed game API allowance.

Opus 5.5 and Sonnet 5 use adaptive thinking and structured JSON output. Optional legacy
Haiku 4.5 uses its documented manual thinking budget and omits unsupported effort:
1,024/2,048/4,096 thinking tokens for low/medium/high, all inside the same 8,000-token
output ceiling. See [Haiku compatibility](https://platform.claude.com/docs/en/models/haiku-4-5/overview).
Unknown or unpriced model ids are refused before network access. Changing models or
effort requires a quality comparison on the evaluation set first. No such comparison
has been performed here.

## Verification and remaining evaluation

The offline tests inject a synthetic transport and deny live provider fetches. They
exercise permissions, database canaries, duplicate reservations, the switch and daily
budget, current/outdated checks, holds, resolution, confidence reduction, unknown
refs, unsupported mismatches, schema rejection, refusal, truncation and round reset.
A matrix of 40 synthetic reply replays covers correct responses and the three seeded
error labels (too wide, too narrow, wrong most likely). These verify server handling;
they are not a measurement of the provider's detection quality.

The paid acceptance evaluation remains outstanding and requires the owner's explicit
approval. Use 30–50 hand-written synthetic packages containing correct estimates and
seeded estimator errors. Independently review expected outcomes before calling the
provider. Every seeded error must be identified with the correct problem; no more
than 10% of correct estimates may receive `disagrees`. Also check contradiction
causes, valid refs, absence of invented facts/advice, and no confidence increase.
Record model, prompt/model versions, counts and actual ledger cost. Keep only synthetic
evaluation inputs in this public repository. Keep the feature off until that review
supports enabling the chosen model/effort.

## Provider retention

Checked on 2026-10-10 against Anthropic's commercial/API retention terms. Standard API
inputs and outputs are deleted within 30 days, with exceptions for agreed retention,
usage-policy enforcement and legal requirements. Flagged material may be kept longer;
zero retention is a separate agreement and must not be assumed. Pseudonymization
does not itself create zero retention. See the
[commercial retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
and [covered-model exceptions](https://privacy.claude.com/en/articles/15425996-data-retention-practices-for-covered-models).
This integration uses the first-party Messages API and does not upload files or submit
provider feedback. Recheck current terms and the organization's contract before enabling.
