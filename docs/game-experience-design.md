# Game visibility: review and design

Reviewed from `origin/main` at `1457c4e` on 2026-09-28. This is a repository-wide
architecture and feature review, not a claim that every existing feature was exercised
against the live game. The review covers the proxy and two browser documents, shared
models, scrapers, API routes, repositories, map/intel, routes/fleets, science/population,
trade planning, notifications, and the synthetic test setup.

## Shipped in this change: building value at the decision point

An optional, small `SU ↓23%` badge sits alongside an eligible building on its planet page.
The member can open the calculation with a mouse, touch, or keyboard. It is advice only;
the existing `+1 SU` and `+All SU` buttons remain separate game actions.

Compare the **remaining** production cost, not the full cost of the next building level:

```
PP market value = remaining PP × observed Production Point price
SU market value = observed Supply Unit price − observed building refund
```

For example, synthetic prices of 1 A$/PP and 750 A$/SU with a 100 A$ refund make an SU
worth comparing when 1,200 PP remain: 1,200 A$ versus 650 A$, a 550 A$ difference.
If only 250 PP remain on the same building, no SU badge appears. Equal displayed costs
also produce no badge. Starbases and ships are excluded.

The price beside a building on Trade is the refund obtained when spending an SU, as
documented in [game-rules.md](game-rules.md#supply-units). It is not an extra purchase fee.
A missing refund supports only a conservative estimate explicitly marked **before refund**.
No historical price or assumed fee is substituted for an observation.

The existing Trade inventory read supplies a shared browser cache containing only
whitelisted prices and its observation timestamp. No new game request is needed. Quotes
expire after 15 minutes, and malformed/new-incomplete quotes invalidate the old advice.
The hint updates across wrapper and iframe, on changed remaining PP, and at expiry.

Unknown prices or an unrecognized cost column produce a neutral explanation. The parser
uses the confirmed `PP to next level` header and suppresses advice for ambiguous cells,
spanning columns, `N/A`, or unsupported wording. It never guesses a translated header or
derives remaining cost from the full building-cost table.

This is an observed market-value comparison, not a guaranteed transaction price or a
recommendation to liquidate production. Prices change; siege affects PP sale proceeds,
and trade eligibility applies. The disclosed comparison explains these limits and links
to the game's Trade page.

## Useful next improvements

These are proposals, not implemented behavior in this PR. Existing Social cap warnings,
Biology threat pills, map freshness/vision layers, airport routing, TA schedules, and
Discord timers are already present and should be extended rather than duplicated.

| Priority | Proposed behavior | Existing foundation | Required evidence or limit |
| --- | --- | --- | --- |
| P1 | Show separate ages for ownership, population, and fleet intelligence; make mixed-age system data visible. | `galaxy-map.js` displays a single age; `systems.js` aggregates `MAX(updated_at)`. | A latest system timestamp does not prove every field is fresh. Field-level provenance is needed. |
| P1 | Compare a saved route with the latest recorded intel and show changed launch/arrival times, ownership, SB, and siege status before saving a revision. | `route-planner.js` deliberately preserves a saved timing snapshot and already evaluates airports. | Never overwrite the plan on refresh. Older plans may lack enough provenance for a complete comparison. |
| P1 | Warn before population reaches its cap: “cap in ~8 h; Social completes in ~11 h,” sorted by expected delay. | `social-hint.js`, `planetBanking.js`, and research-time models already capture cap, progress, growth, and research inputs. | Missing growth/progress means unknown. Changed bonuses, farms, or research queue invalidate the forecast. |
| P2 | Show alliance workflow and observed in-game TA state separately: planned, sent, establishing, active. | Trade Board and Schedule exist; `trade.js` intentionally treats several game states as workflow `done`. | Preserve that workflow meaning. Capture confirmed status wording and observation time before claiming the bonus is active. |
| P2 | Add a per-account “Needs attention” list with source, deadline, destination link, snooze, and deduplication. | Dashboard toasts, incoming identity, and persistent Discord timers already exist. | Build from existing observations, not continuous game polling. Distinguish scheduled reminders from confirmed events. |

## Validation boundary

Use hand-written price and building fixtures, including partially completed buildings,
reordered columns, locale number formats, expiry, and unavailable data. Exercise keyboard
and touch disclosure, ensure a badge click cannot select a building row, and verify that
the feature emits no game request. Production markup beyond the documented header has
not been inspected during this change; unsupported markup intentionally hides advice.
