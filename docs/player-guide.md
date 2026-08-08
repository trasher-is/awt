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

- **Biology** lets you see further on the map, and eventually (level 25) lets you send fleets
  by system ID instead of by name.
- **Economy** makes your ships cheaper to build.
- **Energy** makes your fleets travel faster.
- **Mathematics** means fewer losses when you're attacked.
- **Physics** means a better chance of winning when you attack.
- **Social** raises how much population each of your planets can hold.

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

A battle's outcome depends on your fleet's combat value versus the defender's, modified by
your race picks and by your Mathematics/Physics science relative to theirs. Small fleets (under
4 ships) can lose everything even in a fight they technically "win," so don't assume a tiny
fleet is ever perfectly safe. See [Fleet and combat notes](game-rules.md#fleet-and-combat-notes)
for more of these edge cases, and [awt's Battle Calculator](../public/js/ui/battle-calc.js) if
you want to estimate a specific fight before committing.

### Trade agreements, alliances, and NAPs

**Trade agreements** boost your economy-related bonuses and cost 20,000 A$ to both send and
accept. You can have at most 5 at once, and new agreements are only actually accepted at four
fixed times a day (00:00/06:00/12:00/18:00 CET) rather than instantly. See
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

### Scoring and winning

Your score comes from population levels above 10, your player level, and science levels
above 20 — see [Score](game-rules.md#score) for the exact formula. A player wins a round by
holding 400+ points for 5 straight days; an alliance wins by averaging 300+ points across its
top members for 3 straight days, with at least 3 members counted. See
[Win conditions](game-rules.md#win-conditions).
