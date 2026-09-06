# Operations

What the person running the hub needs to know that is not about the game: what a round
reset removes, and how to back the database up and prove the backup restores.

## Round-scoped records

"Nuke data" in the admin panel (`POST /hub-api/admin/nuke-intel`, `src/routes/admin.js`)
ends a round. It takes a snapshot into the round archive first and then deletes, in one
SQLite transaction, everything that only means something on **this round's map**. If any
step fails — the snapshot included — nothing is deleted.

The map reshuffles between rounds but **system ids come back**. Anything keyed by a system
or planet id that survives a reset silently reattaches to the new map: a route from last
round shows this round's coordinates with last round's travel times, an old takeover
assignment appears on a planet nobody assigned. That is why the list below is explicit
rather than "whatever cascades from `systems`".

| Table | Round-scoped? | Why |
|---|---|---|
| `systems`, `planets`, `planet_events`, `best_guarded` | **removed** | the map itself |
| `players`, `player_name_history`, `player_logins` | **removed** | the roster of this round (who they *were* is kept in the archive) |
| `alliances`, `alliance_member_stats` | **removed** | this round's alliances; member stats are keyed by the stable player id and would otherwise rejoin as "Unknown" |
| `fleets` | **removed** | positions on the wiped map |
| `planet_plans` | **removed** | notes about planets on the wiped map (cascades from `systems`) |
| `routes`, `route_legs` | **removed** (since #128) | plans over system ids that the next round reuses |
| `planet_takeovers` | **removed** (since #128) | assignments keyed by `(system_id, planet_index)`, no foreign key to `systems` |
| `system_claims` | **removed** | territory earmarks for this round's map (cascades from `systems`) |
| `battle_reports`, `news_events` | **removed** | battles and conquests on the wiped map |
| `incoming_alerts`, `incoming_msgs` | **removed** | keyed by attack identities of this round |
| `trade_agreements` | **removed** | pairs of this round's player names |
| `app_users`, `discord_link_codes` | kept | accounts and their Discord links |
| `app_settings`, `alliance_broadcasts` | kept | hub configuration and announcements |
| `discord_timers` | kept | a member's `!timer` is not about the map |
| `rz_plans` | kept | the RedZone planner is a different game |
| `starbase_order_audit` | kept | an operations record of who sent what through the hub |
| `rounds`, `round_players`, `round_systems` | kept, **grows by one** | the archive the reset writes to |

The regression test for this list is `src/routes/admin-round-reset.test.js`: it seeds a
round, runs the real reset endpoint, reseeds the same system ids and checks that nothing
from the previous round is visible through the route and takeover endpoints. When a table
is added to the schema, decide which row of this table it belongs in and, if it is
round-scoped, add its delete to the reset transaction **after** `archiveRound`.
