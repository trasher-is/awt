# New player guide

This is a plain-language walkthrough of AstroWars for players who are new to the game or new
to this alliance's tools. It's ordered the way you'll actually encounter things, not by game
menu. For exact numbers and formulas, this guide links out to
[game-rules.md](game-rules.md) — that file is the technical ground truth; this one is the
friendly explanation of what those numbers mean for you.

## How the game works

### Joining a round

You start with population level 1, culture level 1, biology level 0, and 300 production
points. If you join after a round has already started, you get catch-up bonuses that grow
the later you join: extra production points per day, plus faster culture and research growth
per day. The tradeoff is obvious — the later you join, the bigger your one-time catch-up, but
the further behind everyone else you start in absolute terms. See
[Late-joiner catch-up](game-rules.md#late-joiner-catch-up) for the exact rates.

You're randomly placed into a system alongside other players who joined around the same
time. Your starting planet spawns with two empty ("Free") planets right next to it — those
are yours to colonize with Colony Ships once you're ready. See
[Colonizing and conquering](game-rules.md#colonizing-and-conquering) for how the wider galaxy
opens up as more players join.

If your starting position looks bad — surrounded by a strong established alliance, far from
your own alliance-mates — you have roughly your **first 30 minutes** to relog and reroll a
better one. After that window closes you're stuck there until the game opens the next block
of systems and the spawn point drifts back around, which can take days. If you're joining as
a group, starting together on **day 2-3** of a round tends to land everyone closer together
than day 0-1 (the map hasn't had time to spread out yet) or day 5+ (you're pushed to the
rim, further from everyone and from the more-developed core).

### Your home planet: population and growth

Population is your most basic resource — more population means more production and more
science. It grows automatically every hour, and the only way to make it grow faster is to
build **Hydroponic Farms**. Each farm adds to your growth rate, and then your race pick and
any bonuses (artifacts, trade rate) multiply that rate up. See
[Population growth](game-rules.md#population-growth) for the formula and the full level-cost
table.

Watch for a Hydroponic Farm showing **+0 growth** — that means your planet has hit its
population cap for your current Social science level, not that something's broken. You need
to research more Social to raise the cap. See
[Social (population cap)](game-rules.md#social-population-cap).

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
- **Economy** makes your ships cheaper to build.
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

### Ships and combat basics

There are five ship types: three combat ships (Destroyer, Cruiser, Battleship) and two
non-combat ships (Transport, Colony Ship). Combat ships get cheaper as your Economy science
rises — see [Economy (ship costs)](game-rules.md#economy-ship-costs) — and each has a fixed
attack/defense/combat-value profile, see [Ship types](game-rules.md#ship-types).

Transports have two jobs: capturing a planet that already has population (you need at least
as many transports as the target's population level), or bombing a planet to kill its
population and randomly damage its buildings.

A planet keeps growing population while your fleet is still in flight, so size your transport
count for what it'll have **on arrival**, not when you launched — especially against an
empty planet you're racing to colonize before someone else's Farms outgrow you. As a rough
guide: 2 transports is usually enough for a short hop landing before the next daily update,
3 if it lands after one; for a longer direct flight, send 3-4, since a fast-growing opponent
can add several population levels during the trip. And don't send colonization or transport
fleets unescorted through contested space — losing them to interception costs the ships and
the time both.

A battle's outcome depends on your fleet's combat value versus the defender's, modified by
your race picks and by your Mathematics/Physics science relative to theirs. Small fleets (under
4 ships) can lose everything even in a fight they technically "win," so don't assume a tiny
fleet is ever perfectly safe. See [Fleet and combat notes](game-rules.md#fleet-and-combat-notes)
for more of these edge cases, and [awt's Battle Calculator](../public/js/ui/battle-calc.js) if
you want to estimate a specific fight before committing.

### Trade agreements, alliances, and NAPs

**Trade agreements** boost your economy-related bonuses and cost 20,000 A$ to both send and
accept (**RZ:** 120,000 A$ per side — see [RedZone rounds](#redzone-rounds)). You can have at
most 5 at once, and new agreements are only actually accepted at four fixed times a day
(00:00/06:00/12:00/18:00 CET) rather than instantly. See
[Trade agreements](game-rules.md#trade-agreements).

**Alliances** pool players together for score, defense, and trade agreement partners. There's
no cap on how many members an alliance can have, and no built-in way to remove a member short
of asking a game admin — so choose who you invite carefully. See
[Alliance](game-rules.md#alliance).

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
top members for 3 straight days (**RZ:** the alliance target was 750 points for 3 days in
round 7 — see [RedZone rounds](#redzone-rounds)). See
[Win conditions](game-rules.md#win-conditions).

"Top members" isn't literally the top 3 — it's roughly your **best three-quarters** of the
roster (`CountingMembers = totalPlayers - totalPlayers/4`, minimum 3), sorted by score. This
matters for planning: a handful of low-scoring accounts (a dedicated Trader, say) can sit
outside the counted group without dragging the average down, but you can't stack an alliance
with them — past a certain ratio they start getting counted anyway. See
[Alliance ranking and points](game-rules.md#alliance-ranking-and-points) for the exact
formula.

### RedZone rounds

Some rounds run on the separate RedZone server (`redzone.astrowars.games`) at **×10 pace** —
the round simply moves about ten times faster than a standard one, so plan in hours where
you'd normally plan in days. Rounds there have lasted 12–21 days. Several numbers differ from
the standard server, and a newcomer reading this guide mid-RedZone-round would otherwise be
misled exactly where it is trying to help.

**How this guide marks them (issue #53):** one document, with an **`RZ:`** callout right next
to every standard-round value that is known to differ. A separate RedZone file was
considered and rejected — two documents drift apart, and the reader picks the wrong one.
A value with no `RZ:` callout is *believed* to be the same on both servers, not confirmed.

Known differences, and how sure we are of each:

| Topic | Standard round | RedZone | Source / status |
|---|---|---|---|
| Round pace | 1 game hour = 1 real hour | **×10** — hourly growth, production and science rates run ten times faster in real time | RedZone server description; which timers scale (travel, research, the 6-hourly trade-agreement cycle) still needs checking mechanic by mechanic |
| Trade agreement | 20,000 A$ per side | **120,000 A$ per side** (the Trader pick still waives only the *accept* fee) | confirmed in game, round 7 (July 2026) |
| Energy science | each level = 91% of the previous flight time (`0.91^lvl`) | **95% per level** (`0.95^lvl`) | RedZone changelog 5.2–5.3 — verify in game |
| Flight time | full | **halved** base flight time; a flight to an allied planet at **75%** instead of 50% | RedZone changelog 4.1 / 5.x — verify in game |
| Player-level combat bonus | uncapped in the model | **capped at 15%** | RedZone changelog 5.2–5.3 — verify in game |
| Alliance win | 300 average points for 3 days | **750 points for 3 days** (round 7) | round 7 win screen; may change per round |
| Starbases | vision / defence | additionally give **vision, night-time safety and trade** | RedZone changelog 5.2–5.3 — verify in game |

Anything marked *verify* was recorded from the RedZone changelog for round 7 (beta 5.3,
July 2026) and has not been re-checked in a later round — RedZone rules change between
rounds more often than the standard server's do. If you play RedZone and know a value on
this page is wrong or missing, fix the `RZ:` callout in place and extend this table.

The same callouts appear in [game-rules.md](game-rules.md) next to the affected sections.

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

### Early build order

A common early building order: **Robotic Factory → Galactic Cybernet → Hydroponic Farm →
Research Lab.** The logic is production first — Robotic Factory and Galactic Cybernet get
your production points flowing before you spend on population growth (Hydroponic Farm) or
science (Research Lab).

The common mistake here is building the Hydroponic Farm or Research Lab too early — investing
in population growth or science before your production can actually support the rest of your
build queue just slows everything down.

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
  usually set up in parallel with — not instead of — normal growth.
- **A forward planet is worth more than its own loot** if it shortens everyone else's route
  — landing on a planet you or an ally control always halves flight time (see
  [Science fields — effects](game-rules.md#science-fields--effects)), so a captured "airport"
  near the frontier lets your whole alliance jump through it and reach further than any single
  fleet's range would otherwise allow. Prioritize taking and holding one over a richer planet
  further from the action, and keep at least one alliance culture slot dedicated to grabbing
  airports as they open up rather than assuming someone will get to it. The same logic makes
  a well-placed border system worth cutting an enemy's territory in half over: it's not about
  the planets in it, it's about what falls out of everyone's reach once you hold it.
