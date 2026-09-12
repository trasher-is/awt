# Road to TA

Road to TA compares three development policies for the signed-in player's **current
planets**. It produces a planet-by-planet build order, the point at which each planet
stops construction and starts accumulating saleable PP, and funding/activation estimates
for the remaining trade agreements. It is a planning calculator; it does not place game
orders, sell resources, initiate agreements or contact another player.

## Money and production points

A standard-server trade agreement costs **20,000 A$ per side**, with at most five
agreements. The current public [Game Options](https://astrowars.games/About/GameOptions)
confirms `Trade.AgreementFee = 20000`, `MaxAgreements = 5` and
`PopulationLevelForBonus = 10` (checked 2026-09-12). The separate RedZone planner and its
120,000 A$ price are not used here.

**20,000 A$ is not 20,000 PP.** At a sale price of 0.80 A$/PP, raising 20,000 A$ requires
25,000 PP. With 5,000 A$ already available, the shortfall is 15,000 A$, requiring
18,750 PP at the same price:

```text
cash deficit = max(0, 20,000 A$ - available cash)
required saleable PP = cash deficit / price in A$/PP
sale proceeds = sold PP × price in A$/PP
```

The selected price is held constant for each forecast. Alternative prices are scenarios,
not predictions. The official [changelog](https://astrowars.games/Changelog) describes
PP-price convergence toward 1.0 in version 3.1, but does not publish enough information
to predict future prices or their reaction to the player's sales. A stale market snapshot
must therefore remain visible and editable. The UI compares the chosen sale price with
20% lower and higher constant-price scenarios.

Production points stay on the planet that earned them. The official
[Production Points guide](https://portal.astrowars.mudflatgames.com/glossary/production-points/)
explicitly says that Spend All does not pool PP for construction. Consequently, a rich
planet cannot pay for a poor planet's factory or lab in this model.

The model uses the documented **Spend All → Interstellar Trade** sale operation. It waits
until construction has finished on **every** supplied planet, then sells all current PP
when the next fee can be funded. Surplus sale proceeds remain in the shared A$ balance
for the following agreements. Existing A$ may fund an agreement earlier without a sale.
This avoids assuming a selective or partial sale facility, and protects the PP reserved
for unfinished development. Each planet's earlier `savingAt` means it has stopped
building and is accumulating PP; the global `savingAt` is when every planet is ready.

The sale gate follows the repository's recorded game rules: Player Level at least 1,
a planet at population 5 or above, and at least 150 total PP. Future Player Level growth
is not predicted. A sieged planet continues producing and growing, but only 70% of its
sold PP is converted. The latter rule is also confirmed by version 2.6 of the official
[changelog](https://astrowars.games/Changelog). No construction is scheduled on a planet
whose supplied snapshot says it remains under siege.

A confirmed Trader can **accept** an agreement for free. Initiating still costs 20,000 A$;
this distinction is confirmed by version 3.2 of the
[changelog](https://astrowars.games/Changelog). The optional Trader-acceptance scenario
assumes all forecast agreements are incoming offers the player will accept. It does not
predict whether those offers will exist.

## Development policies

The population thresholds below are the requested strategy policies. They are **not game
eligibility rules**. Population 10 makes a planet contribute a bonus to the player's
partners; it is not an additional payment requirement imposed by the game.

| Policy | Minimum current planets at population 10 | Candidate completed building floors (HF / RF / RL / GC) | Purpose |
| --- | ---: | --- | --- |
| Rush | 2 | 0/0/0/0; 6/8/0/0; 8/10/0/0; 10/12/0/0 | Compare saving immediately with limited growth/factory investment. |
| Normal | 3 | 8/10/10/8; 10/12/12/10; 12/13/13/12 | Preserve a lab and culture development baseline before liquidating PP. |
| Slow | 6 | 10/12/12/12; 12/13/13/13; 12/14/14/14 | Require broader population development and higher lab/culture floors. |

These floors are deliberate planner heuristics, not recommended levels published by the
game. Existing buildings are never removed. Farms are targeted only on the first required
number of promising planets, ordered by current population and then existing farms. Farm
purchases stop when that planet reaches population 10. Other supplied planets can still
grow naturally and contribute to the gate.

Each planet buys the cheapest next building level within its candidate floors. Equal-cost
upgrades use the policy's priorities: Rush favors RF/HF, Normal RL/RF/HF/GC, and Slow
GC/RL/RF/HF. PP always comes from that particular planet. The selected candidate has the
earliest next funded TA, then the next one, with lower building expenditure breaking equal
schedules. This bounded comparison is reproducible; it does **not** prove a globally
optimal build order.

Science production continues under all three policies. Research spends science points,
not PP. Normal's extra lab construction protects development rather than inventing a
fictional PP cost for science. If Social is below 10, the forecast assumes research switches
to Social until 10, using the measured science rate plus increases from additional labs and
population. No existing research progress is credited; that makes an incomplete snapshot
conservative. After Social 10, generated science is counted without assuming a specific
future research queue.

If the player already has five completed agreements, the result schedules no new spending.
The same applies when current cash covers all remaining fees and the selected population
policy is already satisfied. If too few current planets are supplied for the selected
policy, the result asks for expansion and a refreshed snapshot; it does not invent colonies.

## Formulas and trade bonuses

The production and growth rates use the completed levels on each planet:

```text
PP/hour     = (RF + population) × production multiplier
Growth/hour = (HF + 1) × growth multiplier
```

The [Production Points guide](https://portal.astrowars.mudflatgames.com/glossary/production-points/)
confirms production from both factories and population. The
[Hydroponic Farm guide](https://portal.astrowars.mudflatgames.com/glossary/hydroponic-farm/)
confirms one extra growth point per farm; the
[Population guide](https://portal.astrowars.mudflatgames.com/glossary/population/)
confirms the base growth point and the population contribution to science.

Building, population and science costs come from the existing shared
[`game-tables.js`](../public/js/utils/game-tables.js), checked against
[`game-rules.md`](game-rules.md). Public
[Development Tables](https://portal.astrowars.mudflatgames.com/glossary/development-tables/)
confirm that costs are incremental and that their displayed values are rounded. Social
limits growth; Social 10 permits population 10, as listed in the
[Social Science guide](https://portal.astrowars.mudflatgames.com/glossary/social-science/).

The UI keeps trade revenue and the economy bonus separate. The API does not establish
whether the player currently holds the cohort bonus, so the user must confirm 0% or 5%.
The optional saved-bio growth calculation requires both explicit bonuses and a recognized
artifact; missing artifact data is not interpreted as no artifact. Changing either bonus
invalidates a growth multiplier derived by that action. Production/science multipliers can
be calibrated from observed hourly rates only when the supplied planet count is complete;
otherwise explicit multipliers are required.

The initial production, growth and science multipliers must already include the player's
current race, artifact and trade/eco effects. Bonuses stack multiplicatively, following
version 5.0 of the [changelog](https://astrowars.games/Changelog). When a future agreement
activates, one additional percentage point is added to trade revenue for every supplied
partner planet at population 10 or above. The
[Trade Agreement guide](https://portal.astrowars.mudflatgames.com/glossary/trade-agreement/)
describes this direction of the benefit: **the partner's qualifying planets benefit this
player**, while this player's planets benefit the partner.

To avoid counting the current trade bonus twice, subsequent rates are adjusted by:

```text
future adjustment = (1 + (current trade/eco percent + newly received percent) / 100)
                  / (1 + current trade/eco percent / 100)
```

Unknown future partner counts contribute zero additional bonus in the forecast. An entered
count is held constant and assumes the partner accepts and can pay. The planner never
substitutes the player's own qualifying planet count for the partner's.

Funding and activation are distinct. Activation uses the repository's recorded acceptance
schedule, **00:00, 06:00, 12:00 and 18:00 Europe/Berlin**, followed by a conservative
five-minute allowance for the separate trade-bonus recalculation. An action exactly at a
boundary is assigned to the next boundary. UTC instants are used internally; the UI shows
the viewer's local 24-hour time. DST gaps and repeated hours are handled by searching real
UTC minutes for the next Berlin boundary.

**Source limitation:** the older public Trade Agreement glossary still describes a daily
activation and obsolete GMT times. It does not verify today's six-hour schedule. The
schedule used here comes from [`game-rules.md`](game-rules.md#trade-agreements); actual
partner acceptance, hosting delays and any changed round schedule can move activation.
The estimate is not a promise of an active agreement at that instant.

## Input contract and limits

`AWRoadToTA.plan(input)` is a pure dual-runtime module. The input is not mutated.
Required inputs are:

- `mode`: `rush`, `normal` or `slow`.
- `planets`: 1–100 unique current planets, each with `id`, completed integer `population`,
  `HF`, `RF`, `RL`, `GC`, and its own unspent `pp`. Existing building levels up to 100 are
  accepted and preserved, including levels funded by Supply Units beyond the PP cost table.
  The input limit of 100 is a model bound, not a claim about the game's building cap.
  A name and siege flag are optional.
- `social`, `playerLevel`, current measured `scienceRate`, `productionMultiplier`,
  `growthMultiplier`, `scienceMultiplier`, and `currentTradeBonusPct` including eco bonus.
- Current `cash` in A$, `ppPrice` in A$/PP, and `completedTas` from 0 to 5.

Optional values are `now` (an epoch, Date or ISO/SQLite timestamp parsed by the shared
UTC timestamp helper; timezone-free hub timestamps mean UTC), `horizonDays` (default 60, maximum 180),
`traderAccept`, and `partnerQualifiedPlanets` in the order of the remaining agreements.
Per-planet `growthPoints` is progress toward the next population level; omission explicitly
assumes zero. Fractions of a partially constructed building are not inferred from a
completed level. Exclude already committed construction PP from the unspent balance.

Missing mandatory values are errors, never zero-valued facts. Aggregate player buildings
and aggregate PP cannot reconstruct their allocation across planets. When the hub's snapshot
lacks per-planet details, enter them from the current own-planet screen; do not distribute
a player's totals equally or silently replace saved values from an older scan.

The result contains the selected candidate, per-planet ordered builds, population and saving
milestones, every remaining agreement's funding and activation estimate, and resource totals.
Unknown milestones are `null`. `horizonHours` is the permitted horizon;
`totals.simulatedHours` is the actual simulated duration, ending at the last funded agreement
or the horizon. Totals obey both resource identities:

```text
initial PP + earned PP = building PP + sold PP + remaining PP
initial A$ + sale proceeds = TA fees paid + remaining A$
```

The simulator advances between affordability, growth, Social-research, sale and activation
events. It does not claim precision beyond the rounded game tables or hosting cycles.
No future colonisation, conquest, transfer, fleet spending, Supply Units, artifact purchases,
market movement or random spontaneous growth is assumed. Existing production queues must be
reconciled with the proposed build order. Refresh after ownership, siege, market or bonus
changes before following the plan.

## Verification

`npm test -- road-to-ta-model` covers independent A$/PP funding calculations, local-planet
construction, PP and cash conservation, thresholds, Social-before-growth behavior, Trader
fees, 150-PP sales, siege loss, delayed partner bonuses, horizon exhaustion, completed plans,
input validation and Berlin activation windows across both DST changes.
