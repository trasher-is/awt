# New player guide

This is a plain-language walkthrough of AstroWars for players who are new to the game or new
to this alliance's tools. It's ordered the way you'll actually encounter things, not by game
menu. For exact numbers and formulas, this guide links out to
[game-rules.md](game-rules.md) — that file is the technical ground truth; this one is the
friendly explanation of what those numbers mean for you.

> **Playing RedZone? Read [RedZone rounds](#redzone-rounds) first.** The unmarked numbers
> and strategy examples below describe the standard server. RedZone has ×10 economic
> output, different flight settings and higher prices; its differences are marked `RZ:`.

## How the game works

### Joining a round

You start with population level 1, culture level 1, biology level 0, and 300 production
points (**RZ:** 150 PP). If you join after a round has already started, you get catch-up
bonuses that grow the later you join: extra production points per day, plus faster culture and research growth
per day. The tradeoff is obvious — the later you join, the bigger your one-time catch-up, but
the further behind everyone else you start in absolute terms. See
[Late-joiner catch-up](game-rules.md#late-joiner-catch-up) for the exact rates.

You're randomly placed into a system alongside other players who joined around the same
time. Your starting planet spawns with two empty ("Free") planets right next to it — those
are yours to colonize with Colony Ships once you're ready. See
[Colonizing and conquering](game-rules.md#colonizing-and-conquering) for how the wider galaxy
opens up as more players join.

**RZ:** alliance assignment is automatic, resignation requires defeat, and 48 hours of
inactivity triggers automatic resignation. Treat the reroll and joining-day advice below
as standard-round advice. See the [dated comparison](#redzone-rounds) before joining.

If your starting position looks bad — surrounded by a strong established alliance, far from
your own alliance-mates — you have roughly your **first 30 minutes** to relog and reroll a
better one. After that window closes you're stuck there until the game opens the next block
of systems and the spawn point drifts back around, which can take days. If you're joining as
a group, starting together on **day 2-3** of a round tends to land everyone closer together
than day 0-1 (the map hasn't had time to spread out yet) or day 5+ (you're pushed to the
rim, further from everyone and from the more-developed core).

The game's code of conduct forbids **bots, AI systems or scripts that automate player
actions**. Outside tools that collect or enrich data, like this hub, are allowed within
reason, and the game admins ask that you tell them about such tools in advance.

### Your home planet: population and growth

Population is your most basic resource — more population means more production and more
science. It grows automatically at an hourly rate; to increase the base rate, build
**Hydroponic Farms**. Each farm adds to your growth rate, and then your race pick and
any bonuses (artifacts, trade rate) multiply that rate up. See
[Population growth](game-rules.md#population-growth) for the formula and the full level-cost
table.

**RZ:** growth, production, science and culture output run at **×10** for the same inputs.
RedZone applies that output in **one-minute updates**; this is different from making every
timer ten times shorter. Use the rate and next-level ETA shown in your current round.

Watch for a Hydroponic Farm showing **+0 growth** — that means your planet has hit its
population cap for your current Social science level, not that something's broken. You need
to research more Social to raise the cap. See
[Social (population cap)](game-rules.md#social-population-cap).

Social also drives **spontaneous growth** (the "baby boom" news item): at the daily update,
one random planet sitting **6 or more population levels below your Social level** gets +1
population for free — see [Science fields — effects](game-rules.md#science-fields--effects).
In practice that means **Social 15** lets a population-9 planet roll up to 10, and population
10 is the threshold for a planet to count toward your trade bonus. Social 14 stops the
lottery at 9, which gets your lower planets to 9 faster (fewer planets share the daily
roll), but nothing then carries them over the line to 10. Both are used in the alliance; with
a high-Growth race you'll pass through Social 14 quickly anyway, so 15 is the common target
during the trade-agreement phase.

Population and Social also cap your **fleet**: the most combat value you may field is your
total population levels × (Social + 3) × 11 (see
[Max Combat Value](game-rules.md#max-combat-value)). Farms that look slow early are what
let you build a big fleet late in the round. The alliance's rule of thumb is **at least 12
Hydroponic Farms** on planets you plan to keep.

### Production and buildings

**Robotic Factories** and your population level both generate production points per hour,
which you spend on buildings, ships, and science. Buildings get more expensive each level you
raise them — see the [Buildings](game-rules.md#buildings) cost table — and past a certain
point, you can no longer raise a building with production points at all; from then on you pay
with **Supply Units** instead, whose price rises and falls with how many other players are
buying them. See [Supply units](game-rules.md#supply-units).

### Science: the six fields

You research one science field at a time, and all six share the same research rate (culture
is separate). Each field does something different besides its raw growth rate — see
[Science fields — effects](game-rules.md#science-fields--effects) for the full rundown, but
in short:

- **Biology** lets you see further on the map, and at level 25 opens up the whole map, letting
  you send fleets by system ID instead of by name.
- **Economy** makes your ships cheaper to build. It adds up: the same PP buys about 23% more
  ships at Economy 27 than at Economy 10, and about 43% more at Economy 30 than at Economy 0
  (see [Economy (ship costs)](game-rules.md#economy-ship-costs)).
- **Energy** makes your fleets travel faster.
- **Mathematics** means fewer losses when you're attacked.
- **Physics** means a better chance of winning when you attack.
- **Social** raises how much population each of your planets can hold.

Energy's travel-time bonus has steep diminishing returns: each level only gets you to 91% of
the previous level's flight time, so the gains shrink fast the higher you go. On the standard
server, Energy 35 gets you down to roughly 3.7% of unmodified flight time, 40 to about 2.3%,
and 45 to about 1.4% — pushing past ~40 mostly buys you a few extra seconds per hop, not
minutes. **RZ:** Energy scales more gently there (95% per level instead of 91%), so higher
levels keep paying off for longer — see the [RedZone rounds](#redzone-rounds) table.

Biology also decides who can read **your** intel report — race picks, sciences, trade rate,
artifacts. Anyone whose Biology is **6 or more levels above yours** sees all of it (see
[Fleet and combat notes](game-rules.md#fleet-and-combat-notes)). Dedicated spies usually
stop around Biology 31-32, so sitting at **26-27** keeps most of them out; that is the level
the alliance aimed for in beta 6. Below that, assume a few opponents know your race. A
common research rhythm before Biology 25 is to alternate Biology and Energy one level at a
time rather than pushing either far ahead.

**RZ:** flights have their own settings. The fixed minimum is **10 minutes within a system /
25 minutes between systems**, compared with **20 / 45 minutes** on standard; the reducible
time coefficients are **2 / 5 hours**, compared with **4 / 10 hours**. Allied flights use
**75%** of the normal flight time, compared with **50%** on standard. Use the game's
current travel calculator; dividing a standard ETA by ten does not reproduce these rules.

### Culture and expansion

Your **culture level determines how many planets you're allowed to own** — see
[Culture and planet slots](game-rules.md#culture-and-planet-slots). Every time you level up
culture, you unlock one more planet slot, which you fill by sending a Colony Ship to an empty
planet.

Sending exactly one Colony Ship colonizes a planet with nothing on it — zero buildings, zero
production points. Sending more Colony Ships than you need lets the extras "disband" into
starting production points instead, but only once you send at least two extra ships — see
[Ship types](game-rules.md#ship-types) for the exact numbers. This is a common way to give a
new colony a real head start instead of leaving it at zero.

How many to send? Each Colony Ship costs 60 PP and returns only 15 PP when it disbands, so
it only pays off while the new planet's buildings are far below your developed planets'. A
rule of thumb from the alliance's research channel, which checks out against the
[Buildings](game-rules.md#buildings) cost table:

| Colony Ships sent | Enough to raise Robotic Factory, Cybernet and Lab to |
|---|---|
| 14 | level 5 |
| 22 | level 6 |
| 34 | level 7 |

Aim for about **22** and straight level 6 unless you have production to spare. Beyond about
level 7, each extra ship buys very little, so that production does more on your developed
planets or in Supply Units. A built-up planet pays for itself sooner, so sending generously
is rarely wasted while you're not fighting.

Another way to build up a new planet fast is a **Friendly Siege**: an ally sieges your
developed planets, so production you buy lands on a lower planet in your list instead (see
[Non-aggression pacts](game-rules.md#non-aggression-pacts) and
[Buying production points](game-rules.md#buying-production-points)). Spend everything on the
developed planet before the siege lands, since sieged planets lose some of what you sell.

### Ships and combat basics

There are five ship types: three combat ships (Destroyer, Cruiser, Battleship) and two
non-combat ships (Transport, Colony Ship). Combat ships get cheaper as your Economy science
rises — see [Economy (ship costs)](game-rules.md#economy-ship-costs) — and each has a fixed
attack/defense/combat-value profile, see [Ship types](game-rules.md#ship-types).

Transports have two jobs: capturing a planet that already has population (you need at least
as many transports as the target's population level), or bombing a planet to kill its
population and randomly damage its buildings. Both are options you tick at launch
(**Conquer** and **Bomb**): untick both and the transports land on any planet without
touching it, which is how you park them on a friendly planet before the last jump. Don't
park on a planet of the target's alliance: every member of an alliance is alerted to an
attack on any of them. See [Ship types](game-rules.md#ship-types) and
[Fleet and combat notes](game-rules.md#fleet-and-combat-notes).

A planet keeps growing population while your fleet is still in flight, so size your transport
count for what it'll have **on arrival**, not when you launched — especially against an
empty planet you're racing to colonize before someone else's Farms outgrow you. As a rough
guide: 2 transports is usually enough for a short hop landing before the next daily update,
3 if it lands after one; for a longer direct flight, send 3-4, since a fast-growing opponent
can add several population levels during the trip. And don't send colonization or transport
fleets unescorted through contested space — losing them to interception costs the ships and
the time both.

**RZ:** those transport counts are standard-round examples. Faster population growth and
different travel settings mean you must estimate the target's population at its actual ETA.

A battle's outcome depends on your fleet's combat value versus the defender's, modified by
your race picks and by your Mathematics/Physics science relative to theirs. Small fleets (under
4 ships) can lose everything even in a fight they technically "win," so don't assume a tiny
fleet is ever perfectly safe. See [Fleet and combat notes](game-rules.md#fleet-and-combat-notes)
for more of these edge cases, and [awt's Battle Calculator](../public/js/ui/battle-calc.js) if
you want to estimate a specific fight before committing.

**Don't split your fleet.** It's a cliché for a reason — dividing one fleet into several
smaller ones to cover more ground (or to intercept from multiple directions) usually just
means several fights you individually lose instead of one you'd have won. Keep it together,
and only commit to a fight the Battle Calculator says you're confident in; a target that
slips away is a better outcome than a fight you didn't need to take.

When a landing has to hit an exact second, such as a counter-attack in the attacker's fleet
cycle (see [Fleet and combat notes](game-rules.md#fleet-and-combat-notes)), **launch from a
computer**. Members have found mobile launches register about a second late.

### Player level and experience

Your **player level (PL)** decides which artifacts you can buy — Charcoal Diamond 1 needs
PL 5, Memory Jar 1 PL 6, Memory Jar 2 PL 13 (full table in
[Artifacts](game-rules.md#artifacts)) — and adds to your score and combat bonus. You level up
by winning fights: the winner gains XP equal to the **combat value the loser lost**, so
beating a starbase pays its whole CV. Full XP needs at least 2 of your ships to survive;
otherwise you get only 25%. See [Full XP from combat](game-rules.md#full-xp-from-combat) and
the [Player level](game-rules.md#player-level) table.

Without an enemy nearby, alliance members level each other with **Friendly Fire (FF)**:
you knock down an alliance-mate's starbase, which they agreed to let you hit. A few habits
from beta 6:

- **Run the Battle Calculator first** and send exactly what gives a 100% win. You're paying
  for those ships, and a loss pays nothing.
- **Starbases auto-grow by whole levels**, so a planet part-way through SB 8 grows the same
  as one at exactly SB 8. Ask the owner when their next level lands if you want the bigger XP
  payout.
- **A few big starbases are quicker than many small ones**: one SB 11 pays about as much as
  an SB 10 plus an SB 8, with one flight instead of two.
- **Count it as spending.** Gaining PL costs real production, so do it when it unlocks
  something you'll use, such as the next artifact, not just for the number.

**RZ:** battles between allies pay only **25%** of the normal XP
(`ExperiencePointsFactorFromAllied`), so Friendly Fire is a much weaker way to level there.

### Trade agreements, alliances, and NAPs

**Trade agreements** boost your economy-related bonuses and cost 20,000 A$ to both send and
accept (**RZ:** 120,000 A$ per side — see [RedZone rounds](#redzone-rounds)). You can have at
most 5 at once, and new agreements are only actually accepted at four fixed times a day
(00:00/06:00/12:00/18:00 CET) rather than instantly on the standard server. **RZ:** its
acceptance schedule still needs confirmation; do not divide these clock times by ten. See
[Trade agreements](game-rules.md#trade-agreements).

Only planets at **population 10 or more** count toward the trade bonus (**RZ:** 12). A planet
an enemy is sieging stops contributing while the siege lasts, plus up to one 5-minute update
after it ends.

Agreements need a partner who has the money **at the same time**, so the alliance plans them
together rather than first-come, first-served:

- **Save, don't spend, when you're close.** Once the plan has you sending or accepting soon,
  every PP you put into buildings or Supply Units pushes back your partner's agreement as well
  as yours. The goal is that nobody sits on 20,000 A$ for more than a day waiting.
- **Selling artifacts to fund an agreement early is normal.** An artifact holds its value on
  the market, so selling one to sign 1-2 days sooner and buying it back afterwards is usually
  worth it.
- **Convert PP to A$ early when you're saving.** While the whole galaxy is signing
  agreements, everyone sells PP for A$, so each PP buys fewer A$ the longer you wait. When the
  A$ price starts rising again, the trade-agreement season is ending.
- **If you'll wait several days for a partner anyway**, that gap is the time to buy Supply
  Units or do some Friendly Fire for player level.
- In a small alliance, everyone usually signs with the **dedicated trader** first, since that
  account lives on trade bonus, and then the rest pair up with each other.

The hub's **Trade agreements** panel has a **Schedule** tab that works out who should pair
with whom and when, and a **My Savings** tab where you mark the planets you're saving on and
the artifacts you're willing to sell. It only re-reads what you own when you visit the game's
Trade page or press Reload, so do that before you trust the date it shows.

**Alliances** pool players together for score, defense, and trade agreement partners. There's
no cap on how many members an alliance can have, and no built-in way to remove a member short
of asking a game admin — so choose who you invite carefully. See
[Alliance](game-rules.md#alliance).

**RZ:** the current round automatically assigns players to **4 alliances**, and alliance
name/tag changes are disabled.

**Non-Aggression Pacts (NAPs)** are informal promises between players or alliances not to
attack each other. They're not a hard game rule — they're backed by reputation. Breaking one
without warning ("backstabbing") will follow you. See
[Non-aggression pacts](game-rules.md#non-aggression-pacts) for the related "Friendly
Attack/Fire" and "Friendly Siege" tactics some players use even while at peace.

If you need to fight a NAP partner's alliance without ending the NAP outright, scoping the
fight to a single contested system rather than declaring war on the whole alliance tends to
be read as "we're clearing a system," not "we're at war with you" — it's a real diplomatic
distinction other alliances make, not just a technicality.

### Scoring and winning

Your score comes from population levels above 10, your player level, and science levels
above 20 — see [Score](game-rules.md#score) for the exact formula. A player wins a round by
holding 400+ points for 5 straight days; an alliance wins by averaging 300+ points across its
top members for 3 straight days. **RZ:** individual victory is disabled, and the current
alliance target is **1,000 points for 3 days** (checked 2026-10-10; the former round-7 target
was 750). See [RedZone rounds](#redzone-rounds) and
[Win conditions](game-rules.md#win-conditions).

"Top members" isn't literally the top 3 — it's roughly your **best three-quarters** of the
roster (`CountingMembers = totalPlayers - totalPlayers/4`, minimum 3), sorted by score. This
matters for planning: a handful of low-scoring accounts (a dedicated Trader, say) can sit
outside the counted group without dragging the average down, but you can't stack an alliance
with them — past a certain ratio they start getting counted anyway. See
[Alliance ranking and points](game-rules.md#alliance-ranking-and-points) for the exact
formula.

### RedZone rounds

RedZone is the separate server at `redzone.astrowars.games`. Its **×10 pace** is an economic
output setting: growth, production, science and culture accumulate faster. Flights, hosting
cycles, trade offers and victory durations have separate settings; ×10 is not a conversion
for every time printed in the game.

**How this guide marks them (issue #53):** one document, with an **`RZ:`** callout right next
to every standard-round value that is known to differ. A separate RedZone file was
considered and rejected — two documents drift apart, and the reader picks the wrong one.
A value with no `RZ:` callout is a standard-round reference, not a verified RedZone value.

The following comparison was checked on **2026-10-10** against the game's public
[standard Game Options](https://astrowars.games/About/GameOptions) and
[RedZone Game Options](https://redzone.astrowars.games/About/GameOptions). These are public
round settings, not captured player data. They can change between rounds.

| Topic | Standard round | RedZone | Game Options section |
|---|---|---|---|
| Growth, production, science and culture output | ×1 | **×10** for the same inputs | `Output.Factor` |
| Starting production points | 300 PP | **150 PP** | `Join` |
| Late-join catch-up, per day | +100 PP; +0.15 culture/research levels | **+1,000 PP; +1.5 culture/research levels** | `LateJoinBonus` |
| Startup Lab | 12 lab levels | **15 lab levels**, same 1-pick cost | `RaceOptions` |
| Trade agreement | 20,000 A$ per side | **120,000 A$ per side**, same maximum of 5 | `Trade` |
| Population threshold for trade bonus | 10 | **12** | `Trade.PopulationLevelForBonus` |
| Economy-bonus join cohort | 25 players | **10 players**, same +5% bonus | `Join` |
| Supply Unit starting price | 750 A$ | **1,000 A$**; later prices are market prices | `InitialStockPrices` |
| Energy factor per level | `0.91^level` | **`0.95^level`** | `Fleet.TravelTimeSpeedBase` |
| Map vision setting | `VisionFactor = 1` | **`VisionFactor = 2`**; separate scanning feature enabled | `Map` / `IntelsFeature` |
| Flight fixed minimum: same system / between systems | 20 / 45 minutes | **10 / 25 minutes** | `Fleet.FixedTravelTime*` |
| Flight reducible coefficient: same system / between systems | 4 / 10 hours | **2 / 5 hours** | `Fleet.TravelTime*` |
| Allied flight factor | 50% | **75%** | `Fleet.TravelTimeFactorAllies` |
| Player-level combat bonus cap | None | **15%** | `Battle` |
| Allied-battle XP factor | 100% | **25%** | `Fleet.ExperiencePointsFactorFromAllied` |
| Alliance victory | 300 points for 3 days | **1,000 points for 3 days**; minimum member score setting 15 instead of 0 | `AllianceWinningConditions` |
| Individual victory | 400 points for 5 days | **Disabled** | `PlayerWinningConditions.IsEnabled` |
| Alliance assignment | Player chooses | **Automatic; 4 alliances** | `Alliance` |
| Automatic resignation for inactivity | Disabled | **48 hours** | `PlayerOptions` |
| Starbase modules / combat artifacts | Disabled | **Enabled**; see the rules sections below | `Starbase` / `CombatArtefacts` |

RedZone's public hosting schedule lists **one-minute** growth, production, science, culture
and fleet-arrival updates. The standard hosting observations in this guide are **five-minute
economic updates** and **two-minute fleet cycles**. Neither schedule follows from dividing
a standard interval by ten. For a science level requiring `P` points, use `P / current
science rate` for an estimate, then allow for the hosting cycle; do the same for growth and
culture. Do not apply another ×10 multiplier to a rate already displayed by the game.

Flight constants and the 15% cap are also described in the
[official changelog](https://astrowars.games/Changelog) (4.1.0 / 5.3.0-beta). The current
options above replace the older round-7 notes; for example, its 750-point alliance target
is not the present 1,000-point target. awt's local travel and battle formulas implement the
standard rules, so use the game's RedZone calculators for RedZone decisions.

The matching callouts, artifact starting-price comparison, CV-limit settings and map/intel
differences are in [game-rules.md](game-rules.md). **Still awaiting a RedZone player's
review:** confirm the current trade-agreement acceptance clock times, how displayed rates
include output/planet bonuses, the point-cost tables, and any missing round differences.
This source check does not complete that player-review acceptance criterion in issue #53.

## Strategy

### Playstyle archetypes

Race picks and build orders vary a lot between players, and there's no single "correct" way
to play. A few archetypes that come up often — see
[Playstyles](game-rules.md#playstyles) for the exact race-pick numbers behind each:

- **Culture pushers** grow wide instead of tall, favoring Culture to unlock planet slots as
  fast as possible.
- **Speeders** run heavy +Speed with high Energy, prioritizing fleets that arrive faster than
  everyone else's over almost everything.
- **Production fighters** trade away growth, science and speed for strong production and a
  real edge on the attacking side of combat.
- **Farmers** trade away speed and both combat traits to maximize growth, science and
  production — a builder who isn't trying to fight, just to develop fast.
- **Interceptors** stay flexible rather than optimizing one stat hard, and treat their own
  availability as the real resource — willing to get up at odd hours to catch an incoming
  attack or jump on an opening the moment it appears. Suits whoever in the alliance keeps the
  least predictable schedule.
- **Hive-mums** (support traders) skip speed and combat entirely and focus on Trade
  Agreements, feeding trade-rate bonus to the alliance's fighters instead of fighting
  themselves. Because they're not racing anyone anywhere, they can afford to take longer to
  develop and still be useful once TAs land.
- **Spies** push Science, and Biology in particular, hard and early to keep vision on
  opponents before they get vision back — **+4 Science is close to a floor for this role**;
  much less and you risk getting scanned back within days instead of the other way around.
  Doesn't need Speed, since the job is watching, not arriving first.
- **Rolling deathballs** go aggressive early but keep Defense at 0 or better (rather than
  deep negative) on purpose, so a loss doesn't wipe the fleet out — the plan is to keep
  fighting and growing the fleet off of wins, not to gamble everything on one battle.

This list will grow as more archetypes get documented — it's not exhaustive.

### Race-pick advice for new players

If you don't know your preferred playstyle yet, the safe default is **no picks at all**
(`0/0/0/0/0/0/0`) — every trait at its baseline. It's a fine way to learn the game without
committing to a playstyle you might regret once you understand your options better.

A few mistakes worth avoiding even as a beginner:

- **Taking -4 Production.** It stalls your buildings, ships, and colony expansion right when
  you need production points the most.
- **Taking -4 Attack.** Weak attack makes you an easy target — other players will notice you
  can't retaliate effectively and pick on you accordingly.
- **Taking -4 Defense.** It's playable once you have a large fleet to absorb losses with, but
  as a beginner it makes every fight (including Friendly Fire practice) worse than it needs
  to be. -1 to -3 Defense is fine if you need those points elsewhere; -4 specifically is the
  one to avoid.

One stat that's fine to dump if you know you won't need it: **Growth**. Unlike Attack (a
direct multiplier) or Social (unlocks population you'd otherwise cap out on), Growth only
speeds up how fast you *approach* a level you'll eventually reach anyway — its payoff is slow
and compounding rather than immediate. That makes it the standard place to take -4 if you're
one of the alliance's members who won't count toward the alliance's score (see
[Scoring and winning](#scoring-and-winning) for why an alliance always has a few of those) —
put the points into Attack, Speed, or Culture instead.

**Production** is the one trait the alliance's strongest players never skimp on: take **+3
or +4**. +2 falls clearly behind, and the gap grows once trade-agreement bonuses multiply on
top of it. Between **Attack** and **Defence**, Attack lets you win with a smaller fleet, which
matters most early. Defence pays off mainly if you plan to hold your planets through a
countdown late in the round, since you keep more of your fleet in each fight.

Once you know the game, **+4 Production with +4 Culture** is still the alliance's go-to for a
strong early game (checked again in beta 6). Production pays for everything, and Culture is
the stat that keeps compounding as long as you have room to expand. If you take +Culture,
make sure you'll actually have the free planets and the production to fill the slots it
unlocks; otherwise those race points are wasted.

### Early build order

A common early building order: **Robotic Factory → Galactic Cybernet → Hydroponic Farm →
Research Lab.** The logic is production first — Robotic Factory and Galactic Cybernet get
your production points flowing before you spend on population growth (Hydroponic Farm) or
science (Research Lab).

The common mistake here is building the Hydroponic Farm or Research Lab too early — investing
in population growth or science before your production can actually support the rest of your
build queue just slows everything down.

Culture compounds, so the earlier your Galactic Cybernets go up, the sooner every later
planet arrives. A common habit is to keep Cybernet **one level above Robotic Factory**. Before
you start saving for trade agreements, getting Robotic Factories to about **level 12** on
every planet tends to finish all five agreements sooner than saving straight away. The
alliance's beta-5 calculations put it almost five days ahead of staying at level 9.

Losing a planet hurts most early on: with 6 planets, one planet is about a sixth of your
production, while with 21 it's under 5%. Defend early planets even when the fight isn't
perfect.

### Artifact priority

You can only have **one artifact active at a time** (see
[Artifacts](game-rules.md#artifacts) for the full cost/bonus table), so pick deliberately
rather than buying whatever's available. Early game, prioritize a **culture** artifact
(Basalt Monolith is culture-only; Crystal Rod combines it with growth) to keep expanding your
planet count. Later, switch priority to **production** (Charcoal Diamond is production-only;
Memory Jar combines it with science) once you have enough planets and need to fund a bigger
build queue.

### Taking contested territory

A few tactics that come up often once you're fighting over shared space rather than
uncontested Free planets:

- **Concentrate on one target.** Two attackers hitting the same lone defender at once forces
  them to choose which planet to actually defend — the other one falls almost regardless of
  the fight's outcome. Split your attention across many systems instead, and you both lose
  that guarantee.
- **Hit a growing enemy before it finishes growing.** A player or alliance that's farming
  quietly (building up rather than fighting) is at its weakest exactly then — once that fleet
  is fully built, only a coordinated mass attack does real damage. The earlier you strike a
  farmer, the cheaper the fight.
- **The Starbase (SB) trap.** Deliberately build up one planet's Starbase and defenses well
  past what it looks like it needs, so an opponent commits a fleet expecting an easy kill and
  loses it instead. Costs production and a planet you're not otherwise developing, so it's
  usually set up in parallel with — not instead of — normal growth. It's a one-shot: it can
  only catch whichever single fleet actually attacks that planet, so an opponent who commits
  several fleets at once only sacrifices one or two of them, not the whole attack.
- **Guard fresh planets once opponents have Mathematics 12.** Mathematics 12 lets a player
  choose a lower energy at launch (see
  [Science fields — effects](game-rules.md#science-fields--effects)), so a slow fleet can
  already be on its way to a planet before you colonize it. The alliance calls these
  "ghosts". RAID's rule of thumb is to keep **at least 200 CV** on a newly colonized planet
  for its **first 3 days** once anyone nearby has Mathematics 12.
- **Position as a "road bump," not just a defender.** Rather than only reacting once you're
  attacked, put a fleet somewhere the enemy is likely to pass through on their way to a
  softer target — it costs them a fight (or a detour) even if that fleet was never the
  actual target.
- **A forward planet is worth more than its own loot** if it shortens everyone else's route
  — landing on a planet you or an ally control halves standard flight time (decided by who
  owns it when you launch; the flight time never changes mid-flight) (**RZ:** allied
  flight factor 75%; see
  [Science fields — effects](game-rules.md#science-fields--effects)), so a captured "airport"
  near the frontier lets your whole alliance jump through it and reach further than any single
  fleet's range would otherwise allow. Prioritize taking and holding one over a richer planet
  further from the action, and keep at least one alliance culture slot dedicated to grabbing
  airports as they open up rather than assuming someone will get to it. The same logic makes
  a well-placed border system worth cutting an enemy's territory in half over: it's not about
  the planets in it, it's about what falls out of everyone's reach once you hold it.

### Knowing when to stop investing

Every building and Supply Unit is an investment. It only pays off if it earns back its cost
**before the round ends**, so the closer the end is, the less long-term building is worth.

- **Work out the payback time.** In beta 6, with about three weeks left, a Supply Unit cost
  about 1,000 PP and took 450-500 hours (around three weeks) to earn that back in extra
  production. That was the alliance's signal to stop buying Supply Units and Robotic Factories
  for production, and to save PP for fleet instead. One earlier round, the alliance kept
  farming about a week too long and had nothing to fight with when it counted.
- **Watch the leading alliance.** A round ends once an alliance holds the win condition (see
  [Scoring and winning](#scoring-and-winning)), and its last stretch is the **countdown** ("CD"
  in chat), when everyone else attacks the leader. When a ranking alliance's farms and scores
  start climbing fast, the round may be only weeks from ending. Plan your last big
  investments against that date, not against a normal round length.
- **Artifacts are a safer place for late money than buildings.** An artifact can be sold
  back on the market, so buying one late is closer to parking money than spending it. Sell
  it before you need the A$ for a fight, and buy it back if the round carries on.
- **Don't enter the countdown by accident.** Being the alliance that triggers it makes you
  everyone's target. If you're not ready to defend for the whole countdown, keep your score
  under the threshold, for example by holding back +Growth artifacts or killing some of your
  own population, until you are.
