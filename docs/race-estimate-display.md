# Stored race estimates in member views

The battle-report evidence card keeps its existing hard compatible range. The stored
estimate card alongside it reads the hub's saved Attack and Defence estimates; opening
the profile does not recompute evidence or call an AI provider. Confirmed Bio intel,
including intel already visible on the open game page, takes precedence.

Before calibration passes, estimates are visible only to admins. Their range is labelled
**compatible range (uncalibrated)** and the raw posterior mass set is explicitly
uncalibrated. Members see calibration progress and keep the existing worst-case numbers.
No empirical accuracy or coverage is claimed from synthetic tests.

Presentation distinguishes probable, unchecked estimates from **Estimate confirmed by
LLM**. The latter requires an agreeing review of both traits with matching nonempty
evidence hashes and matching current model versions. It describes a review of the
estimator's calculations and evidence; Bio remains the observed source. Outdated
reviews revert to a probable label, unresolved disagreements are withheld, and an
inconclusive review says the LLM could not confirm. These labels do not bypass either
the calibration gate or the calculation eligibility rules below.

An estimate enters a calculation only when all these conditions hold:

- The current battle model has at least 30 distinct calibrated players and 30 pairs,
  nonzero high-band samples, calibration error at most 5 percentage points and verified
  high-band accuracy at least 90%. Every calibration pair must also measure the raw
  posterior 90% mass set, with actual coverage between 88% and 92%.
- Both trait estimates belong to this player and current model, share an evidence hash,
  have valid distributions and no withheld conflict.
- Both traits meet the configured minimum band (medium by default), including any
  lowering made by the current AI check. AI cannot raise the stored evidence band.
- Both AI verdicts agree, and the saved input hash matches the current input hash.

Observed intel remains the first tier. Eligible estimates are the second. Otherwise
`resolveStats` retains the agreed unknown-race +4/+4 and public science ceiling.
The Node resolver derives the expected model version from current code rather than a
submitted envelope.

The battle calculator labels Intel, Estimate and Worst case separately. Its estimated
range enumerates each selected Attack compatible set using the same unchanged
battle formulas. Compatibility is never labelled as 90% coverage, including after
the calibration gate passes. Raw posterior 90% mass sets stay separate in admin details.
Editing a side's inputs clears its saved player selection, so a late response cannot
overwrite manual values.

Incoming alerts retain their original worst-case headline and decisions. A fully gated
enemy estimate may add a separate estimated planet-defence result. True Power can show
`~` only for an eligible estimate with independently observed member-sheet sciences;
an unknown Physics observation still produces `?`.

Members may explicitly request an AI check for admin approval. The admin control says
**Run AI check (paid)**. Reading a card, refreshing it, using the calculator, viewing
incoming alerts or computing a rating never initiates a paid call.

Regression suites use hand-written evidence, synthetic player IDs and mocked hub
responses. They verify gating and presentation; they do not establish live calibration,
provider quality or real-game acceptance.
