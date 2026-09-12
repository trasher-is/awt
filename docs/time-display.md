# Local 24-hour time

Hub clock displays use the viewer's browser timezone and a `00–23` hour cycle,
including when the browser language is English (United States). This covers archives,
battle reports, player intelligence, fleet arrivals, sync status, route planning and
injected game-page estimates. Date order and month names still follow the browser locale.

`public/js/utils/sqlite-time.js` is the shared Node/browser boundary. It parses SQLite
UTC timestamps, ISO timestamps with explicit offsets, and epoch milliseconds into
instants. Hub ISO timestamps without a zone also mean UTC. Invalid timestamps and
locale-dependent display strings are not guessed. Formatters force `hourCycle: 'h23'`;
`hour12: false` alone can produce `24:00` at midnight in some locales.

UTC-backed game timestamp spans are formatted only when they already display a clock.
Native countdowns and date-only labels keep their meaning. Scrapers and fleet timers
read the canonical `data-utc` attribute before display text; invalid or ambiguous
metadata cannot fall back into a localized label. Legacy text parsing remains only for
pages with no canonical timestamp. Archived fleets without a usable canonical arrival
show "Time unknown"; their original source label is retained in an explicitly labelled
tooltip, rather than being presented as a local clock or a current countdown.

Route schedule entry uses a date picker and an explicit `HH:mm[:ss]` field, because a
native `datetime-local` control may still show AM/PM. Changing unrelated route fields
preserves the exact saved instant, including milliseconds and the repeated hour during
the autumn daylight-saving transition. Times in a spring clock gap are rejected.

The dated activity grid uses actual local calendar boundaries, including skipped and
repeated hours and fractional offsets. The all-time histogram is different: its source
contains only 24 aggregated UTC buckets, so it projects them using the viewer's current
offset and labels this limitation. Historical DST cannot be reconstructed from those
aggregates.

Storage, JSON/CSV exports and API timestamp fields remain UTC instants; the player
activity API now returns ISO UTC dates instead of server-local display labels. Explicit
UTC tooltips remain available where useful. Game rules tied to CET/CEST are calculated
in `Europe/Berlin`, then displayed in the viewer's timezone. Discord's native timestamp
markup uses each Discord client's timezone and hour-cycle preference, which the hub
cannot override.

Regression tests cover UTC, European and American daylight-saving transitions,
fractional offsets, invalid source metadata, local midnight and English/Polish UI
locales. Refresh open browser tabs after upgrading so both dashboard and injected game
documents load the same formatting code.
