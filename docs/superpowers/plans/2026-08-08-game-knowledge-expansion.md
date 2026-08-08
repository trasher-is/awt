# Game Knowledge Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close known gaps in `docs/game-rules.md` (the technical ground-truth reference for
awt's calculators) and produce a new, separate `docs/player-guide.md` for new players — all
facts entering either doc only after explicit user confirmation.

**Architecture:** This is a documentation project, not a code project. There is no code to
write and no automated test suite — the "test cycle" for every task is the same discipline
used throughout this project's history: extract a candidate fact from a source, present it to
the user as a direct question, get an explicit answer, and only then edit the doc. A task's
"verification" step is diffing the edited doc against the user's actual answer, not running a
test command.

**Tech Stack:** Markdown files (`docs/game-rules.md`, new `docs/player-guide.md`), the
`WebFetch` tool for the glossary portal, `git` for commits. No application code is touched
unless gap-closing research incidentally surfaces a real code bug (matches this project's
history — e.g. a previous session's economy/ship-cost formula fix) — if that happens, it's a
one-off task added on the spot, not planned in advance here.

## Global Constraints

- Never write a specific number, formula, or mechanic into `docs/game-rules.md` or
  `docs/player-guide.md` without either (a) explicit user confirmation in this conversation,
  or (b) a direct cross-check against something already established as authoritative (the
  live config API, the official changelog, or an existing calibrated model file such as
  `battle-model.js`/`travel-model.js`).
- Anything sourced from `https://portal.astrowars.mudflatgames.com/glossary` is presumed
  stale until confirmed — same treatment as the earlier "Astro Wars Glossary" CSV.
- `docs/game-rules.md` keeps its existing terse, technical style (tables, formulas, short
  prose) — no onboarding tone creeps in.
- `docs/player-guide.md` is plain-language, second-person, ordered by new-player journey. It
  cites `game-rules.md` by section for exact numbers rather than duplicating them.
- Every task ends with a commit. Commit messages describe what was learned/added, not
  "update docs."
- If the user flags an existing error in `game-rules.md` at any point (in any task), fix it
  immediately as part of that task's commit rather than deferring it.

---

### Task 1: Mine the glossary portal for candidate facts

**Files:**
- Read-only research task; no doc edits yet.

**Interfaces:**
- Consumes: nothing from earlier tasks (first task).
- Produces: a written list of candidate facts (topic, old/stale claim, and whether it
  conflicts with anything already in `docs/game-rules.md`) that Task 2 batches into questions
  for the user. Keep this list as your own working notes for this task — it does not need to
  be saved as a file.

- [ ] **Step 1: Fetch the glossary portal**

Use the `WebFetch` tool:

```
url: https://portal.astrowars.mudflatgames.com/glossary
prompt: Return the full raw text of this page verbatim, including every heading, table, and
        numeric value. Do not summarize or omit any section.
```

If the fetch tool truncates or summarizes (as it did for the config API earlier in this
project), re-fetch with a narrower prompt asking for one section at a time (e.g. "list every
key/value pair" or "return only the Combat/Battle section verbatim") until you have the full
content.

- [ ] **Step 2: Cross-reference against `docs/game-rules.md`**

Read the current `docs/game-rules.md` in full. For each topic in the fetched glossary page,
check whether it:
- (a) matches what's already in `docs/game-rules.md` exactly — no action needed, skip it;
- (b) contradicts something already in `docs/game-rules.md` — flag as a conflict to raise
  with the user, do not silently prefer either source;
- (c) is new information not covered anywhere in `docs/game-rules.md` — candidate to add,
  pending confirmation.

- [ ] **Step 3: Write the candidate list**

Produce a plain list, grouped by topic, of every (b) and (c) item found in Step 2. For each
item note: the exact claim, why it's uncertain (stale source), and — for conflicts — what the
existing doc currently says. This list is the input to Task 2's batches; it does not get
committed to git.

- [ ] **Step 4: Commit checkpoint**

No file changes happen in this task, so there is nothing to commit. Proceed directly to
Task 2 with the candidate list in hand.

---

### Task 2: Batch-confirm and add glossary findings

**Files:**
- Modify: `docs/game-rules.md`

**Interfaces:**
- Consumes: the candidate list produced by Task 1, Step 3.
- Produces: confirmed additions/corrections in `docs/game-rules.md`, committed. Any items
  the user explicitly declines are dropped — do not carry them forward to later tasks.

- [ ] **Step 1: Split the candidate list into batches of 4-8 related items**

Group by topic (e.g. "combat," "economy," "alliance") the same way earlier sessions in this
project batched the CSV glossary review — small enough that the user isn't asked to verify
more than a handful of unrelated facts at once.

- [ ] **Step 2: Present the first batch to the user**

For each item in the batch, state the exact claim from the glossary and ask directly whether
it's still accurate, what the correction is, or whether to skip it. Use plain conversational
text (matching the pattern already established in this project) or the `AskUserQuestion` tool
where the question has a small number of discrete answers — free-form answers are common here
and don't need to be forced into multiple choice.

- [ ] **Step 3: Edit `docs/game-rules.md` with only the confirmed items from that batch**

Follow the existing section structure — add a new subsection if the topic doesn't have one
yet, or extend an existing section. Match the file's existing table/formula/prose style. Do
not add anything the user didn't explicitly confirm in Step 2.

- [ ] **Step 4: Update the table of contents**

`docs/game-rules.md` has a `## Contents` section near the top with one `- [Section
Name](#anchor)` line per `##`/`###` heading. Add a line for any new section created in Step 3,
in the same position the section appears in the body.

- [ ] **Step 5: Commit**

```bash
git add docs/game-rules.md
git commit -m "$(cat <<'EOF'
<one line: what was confirmed and added from the glossary portal, batch N>

<optional body: any conflicts the user resolved between the glossary and the existing doc>
EOF
)"
```

- [ ] **Step 6: Repeat Steps 2-5 for each remaining batch**

Continue until every batch from Task 1's candidate list has been presented and resolved (add,
correct, or explicitly skip).

---

### Task 3: Close the known gap list

**Files:**
- Modify: `docs/game-rules.md`

**Interfaces:**
- Consumes: nothing from Task 1/2 directly — this is an independent gap list from the spec.
- Produces: confirmed additions to `docs/game-rules.md` covering the eight listed gaps,
  committed incrementally (one commit per gap, or per small cluster of related gaps — do not
  batch all eight into a single commit).

The eight gaps, in priority order (ask about each one directly; skip to the next if the user
doesn't know an answer — do not guess or invent a plausible-sounding number):

- [ ] **Step 1: Battleship attack/defense**

Current code (`public/js/utils/battle-model.js`) has Battleship at 36 attack / 24 defense,
flagged in `docs/game-rules.md`'s "Ship types" section as unverified. Ask the user to confirm
these against the in-game Battle Calculator. If confirmed, remove the "still needs a check"
caveat from that section. If corrected, update both the table and (if the user wants the code
fixed too) `SHIPS[2]` in `battle-model.js` — but only touch the code if the user asks; the
spec's default is docs-only.

- [ ] **Step 2: Commit Step 1's result**

```bash
git add docs/game-rules.md
git commit -m "Confirm battleship attack/defense values in Ship types section"
```

(Adjust the message if the answer was a correction rather than a confirmation.)

- [ ] **Step 3: Player-level autogrowth formula**

`docs/game-rules.md`'s "Player level" section already has an "Autogrowth (unverified — needs
a thorough check)" subsection. Ask the user whether they've since checked awt's existing
autogrowth calculation against real player data (this ties to the code the user mentioned in
an earlier session as "somewhat calculated and injected into player profiles, but I feel it
is off a bit" — find that code via `grep -rn` for terms like "growth" or "xp" in
`src/routes/sync.js` and `public/js/core/page-injections.js` if you need to locate it). If the
user provides real numbers or a corrected formula, update the subsection and remove the
"unverified" flag. If not, leave the flag in place — do not invent a formula.

- [ ] **Step 4: Commit Step 3's result (only if the doc changed)**

```bash
git add docs/game-rules.md
git commit -m "Update player-level autogrowth section with confirmed data"
```

Skip this commit if the user had no new information — leave the doc as-is.

- [ ] **Step 5: Artifact acquisition mechanism**

`docs/game-rules.md`'s "Artifacts" section has a cost/bonus table but never explains how a
player actually obtains an artifact (bought with A$? found via exploration? something else?).
Ask the user directly. Add a short prose paragraph above the existing table explaining the
acquisition mechanism once confirmed.

- [ ] **Step 6: Commit Step 5's result**

```bash
git add docs/game-rules.md
git commit -m "Document how artifacts are actually acquired"
```

- [ ] **Step 7: Non-Aggression Pact (NAP) rules**

Not covered anywhere in `docs/game-rules.md` yet. Ask the user to explain how NAPs work: how
they're formed, what they prevent, duration, cost if any, how they're broken/expire. Add a new
`## Non-aggression pacts` section (placed near `## Trade agreements`, since both are
inter-player agreements) once confirmed, and add it to the `## Contents` list.

- [ ] **Step 8: Commit Step 7's result**

```bash
git add docs/game-rules.md
git commit -m "Add Non-aggression pacts section"
```

- [ ] **Step 9: Market/price volatility config values**

The live config API (already fetched in an earlier session, see the `game-constants` memory
file for the raw dump if you need to re-check exact values) includes
`VolatilityFactors.Artefacts: 100`, `VolatilityFactors.ProductionPoints: 0.3`,
`VolatilityFactors.SupplyUnits: 4`, and `StaticProductionPointsPriceIncrease: 1`. Ask the user
whether they know what these control (likely: how much A$/PP/SU/artifact prices swing over
time or with demand). If they can explain the mechanism, add a short subsection near
`## Economy (ship costs)` or `## Supply units` (wherever it fits best given what the
explanation turns out to be). If the user doesn't know, leave a one-line note in the relevant
existing section flagging these as "raw config values, meaning not yet confirmed" rather than
adding a new section for unexplained numbers.

- [ ] **Step 10: Commit Step 9's result (only if the doc changed)**

```bash
git add docs/game-rules.md
git commit -m "Document market/price volatility config values"
```

- [ ] **Step 11: Exact Unknown-planet count per spawn cluster**

`docs/game-rules.md`'s "Colonizing and conquering" section already documents that systems
open in clusters of 5 (20 player-assignable slots total) and that "some" slots are
game-created Unknowns with an unconfirmed exact count. Ask the user if they now know the exact
count. If confirmed, replace "exact count per cluster not yet confirmed" with the real number.

- [ ] **Step 12: Commit Step 11's result (only if the doc changed)**

```bash
git add docs/game-rules.md
git commit -m "Confirm Unknown-planet count per spawn cluster"
```

- [ ] **Step 13: Solo/Unknown vs. enemy capture — building differences**

The same "Colonizing and conquering" section has a blockquote: "Still to confirm: whether
colonizing a solo/Unknown-owned planet vs. conquering one from an active enemy gives different
starting buildings (e.g. a flat 4/4/4/4 vs. percentage combat damage to existing buildings)."
Ask the user if they've verified this since. If confirmed, replace the blockquote with a firm
statement of the mechanic.

- [ ] **Step 14: Commit Step 13's result (only if the doc changed)**

```bash
git add docs/game-rules.md
git commit -m "Confirm building differences between solo/Unknown and enemy capture"
```

- [ ] **Step 15: Alliance member cap and kick/removal rules**

`docs/game-rules.md`'s "Alliance" section currently only lists fees (create/rename/retag/
recolor). Ask the user: is there a maximum alliance size? What are the rules for kicking or
removing a member (who can do it, any cooldown, does it free up space immediately)? Add these
as new bullet points in the existing "Alliance" section once confirmed.

- [ ] **Step 16: Commit Step 15's result**

```bash
git add docs/game-rules.md
git commit -m "Document alliance member cap and kick/removal rules"
```

---

### Task 4: `docs/player-guide.md` — Part 1 (mechanics)

**Files:**
- Create: `docs/player-guide.md`
- Read (do not modify): `docs/game-rules.md`

**Interfaces:**
- Consumes: every confirmed fact in `docs/game-rules.md` as of the end of Task 3.
- Produces: `docs/player-guide.md` with a `## How the game works` top-level section
  (subsections below), ready for Task 5 to append a `## Strategy` section to the same file.

- [ ] **Step 1: Draft the section order**

Re-read `docs/game-rules.md` in full. Draft an ordered list of subsections following the
journey a brand-new player actually goes through, e.g.:

1. Joining a round (late-joiner catch-up, starting stats)
2. Your home planet (population, growth, hydroponic farms)
3. Production and buildings
4. Science (the six fields, what each one does)
5. Culture and expansion (planet slots, colonizing)
6. Ships and combat basics (ship types, battle calculator basics)
7. Trade agreements and alliances
8. Scoring and winning

Adjust the exact list based on what's actually in `docs/game-rules.md` by the time this task
runs (Task 3 will have added new sections) — this is a starting point, not a fixed
requirement.

- [ ] **Step 2: Write the file header and Part 1 content**

Create `docs/player-guide.md` with a title, a one-paragraph introduction explaining what the
guide is for, and a `## How the game works` section containing the subsections drafted in
Step 1. Write each subsection in plain, second-person language ("You start with...", "Your
planet's population grows by..."). For every specific number or formula, cite the
`docs/game-rules.md` section it came from using a markdown link, e.g.:

```markdown
Your population grows by (1 + your Hydroponic Farm count) points per hour, multiplied by
your growth bonus — see [Population growth](game-rules.md#population-growth) for the exact
formula.
```

Do not restate exact formulas verbatim if a plain-language description is clearer — link to
the precise version instead of duplicating it. This keeps `player-guide.md` from drifting out
of sync with `game-rules.md` when the latter is corrected later.

- [ ] **Step 3: Present the draft to the user for review**

Before committing, show the user the drafted subsections (or a summary of what each covers)
and ask if the tone, ordering, and level of detail are right. Revise based on feedback before
committing — this step has no fixed pass/fail check the way code does; the user's approval is
the verification.

- [ ] **Step 4: Commit**

```bash
git add docs/player-guide.md
git commit -m "Add docs/player-guide.md with mechanics walkthrough (Part 1)"
```

---

### Task 5: `docs/player-guide.md` — Part 2 (strategy)

**Files:**
- Modify: `docs/player-guide.md`

**Interfaces:**
- Consumes: the file structure created in Task 4 (this task appends a new top-level section).
- Produces: a `## Strategy` section appended to `docs/player-guide.md`, covering playstyle
  archetypes, race-pick advice, build-order priorities, and artifact priorities.

- [ ] **Step 1: Interview — playstyle archetypes**

`docs/game-rules.md`'s "Playstyles" subsection already names two archetypes ("culture
pushers" and "speeders") as user-confirmed examples from an earlier session. Ask the user: are
there other common archetypes worth naming? What distinguishes each one in practice (what a
new player would notice if they looked at a culture-pusher's vs. a speeder's empire)? Draft a
short paragraph per archetype from the answers.

- [ ] **Step 2: Interview — race-pick advice**

Ask the user: for a brand-new player who doesn't yet know their preferred playstyle, is there
a "safe default" race-pick allocation worth suggesting, or is that inherently a personal
choice with no good default? What race-pick mistakes do new players commonly make (e.g.
over-investing in one trait, not understanding the zero-sum constraint)? Draft a short
paragraph from the answers — if the user says there's no good default, say that plainly rather
than inventing one.

- [ ] **Step 3: Interview — build-order priorities**

Ask the user: in roughly what order should a new player prioritize their first buildings
(Hydroponic Farm vs. Robotic Factory vs. Research Lab vs. Galactic Cybernet)? Is there a
common early mistake (e.g. building population buildings before ensuring enough production to
support the build queue)? Draft a short paragraph from the answers.

- [ ] **Step 4: Interview — artifact priorities**

Ask the user: for a new player who finds/can afford their first artifact, is there a
priority order among the six artifact types (Astrolabe, Basalt Monolith, Celestial Prism,
Charcoal Diamond, Crystal Rod, Memory Jar — per the existing "Artifacts" table in
`docs/game-rules.md`)? Draft a short paragraph from the answer, or note "no strong preference"
if that's the honest answer.

- [ ] **Step 5: Write the Strategy section**

Append a `## Strategy` section to `docs/player-guide.md` with subsections for each of the
four interview topics above, in the same plain second-person tone as Part 1. Link back to
`docs/game-rules.md` sections wherever a claim depends on an exact number (e.g. race-pick
percentages).

- [ ] **Step 6: Present the draft to the user for review**

Same as Task 4 Step 3 — show the drafted section, revise based on feedback.

- [ ] **Step 7: Commit**

```bash
git add docs/player-guide.md
git commit -m "Add strategy section to docs/player-guide.md (Part 2)"
```
