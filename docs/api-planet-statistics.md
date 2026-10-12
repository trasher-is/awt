# Map statistics availability

The [official 6.0.2 changelog](https://astrowars.games/Changelog) names four optional
planet statistics categories: `bestPlanet`, `bestGuarded`, `strongestFleets` and
`recentBattles`. The overall `statistics` value is `null` when the planet has no
statistics. They also appear in the daily static map snapshot. Recent battle details
are permission-filtered by the game.

The nested schema has not been verified. The hub therefore transports only four
availability booleans, using data already returned by its existing map/system requests.
No additional game request is made. Non-null, nonempty category data means only that
category data is available; even a zero or `false` is data, without any inferred ranking
meaning. Nested fields, unknown categories and player/battle details are discarded.

`AWApi.mapPlanetsToSyncPayload` includes `api_statistics` only when the game actually
returns a valid `statistics` property. An explicit `null` clears the four flags. A
missing or malformed overall property makes no claim, so an old server/tab cannot erase
a newer observation. `AWApi.validatePlanetStatisticsAvailability` validates the minimal
transport again before storage.

Unicorn mode shows category icons labelled **“… statistics available”** alongside its
existing ranking markers. These flags do not establish ranks, building champions, combat
values, fleet counts, actual fleet sightings or battle report details. Best Planets HTML
snapshots continue to supply numbered ranks and building leaders.

The read path uses the statistics observation time, independently of the ranking sync
time. Unknown, unreadable or future observations do not generate markers. Recent battle
availability expires one hour after the snapshot; other category availability expires
after 26 hours, the same daily-snapshot tolerance used by Unicorn's ranking status.
The minute countdown and hub refresh both remove expired decorations.

Storage uses `planets.api_statistics` (the four boolean flags as JSON) and
`planets.api_statistics_observed_at` (the actual capture/live observation time). The
existing stale-observation guard applies before any write. Replacing a planet's game ID
at a slot must clear the old flags; missing/invalid statistics otherwise preserve the
same planet's observation. The read path tolerates older schemas during an update.

All regression data is synthetic. Live compatibility and richer interpretation of the
nested fields remain unverified until an official schema or an authorized example is
available.
