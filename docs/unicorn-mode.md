# Unicorn ranking mode

[Map preview](previews/unicorn-mode-map.png) · [System on mobile](previews/unicorn-mode-mobile.png)
(hand-written synthetic systems and rankings, not captured game data).

Type **unicorn** outside text fields, in the dashboard or its embedded game, to enable
ranking annotations for **60 minutes**. Letters may cross between those two documents.
A three-second pause resets the word. Inputs, textareas, selects, editable content,
keyboard shortcuts, repeated keys and composition do not activate it.

The fixed control shows the remaining minutes and **Unicorn OFF**, which removes the
annotations immediately. The expiry is an absolute timestamp: frame navigation, reload
and opening another tab do not renew it. Tabs share ON/OFF through browser storage.
When storage is blocked, the current wrapper and its frame still work together; a full
reload then loses the temporary state. Typing the word again explicitly starts another
60-minute visit. The original Konami squadron remains unchanged.

- A **🦄** on the game's map marks a system containing a Top 50 Best Planets entry or a
  building leader.
- **[01] … [50]** beside a planet is its Best Planets rank.
- **🦄 HF**, **🦄 RF**, **🦄 GC**, **🦄 RL** identify the highest Hydroponic Farm, Robotic
  Factory, Galactic Cybernet and Research Lab levels **within that Top 50**. Ties select
  the better Best Planets rank, then planet id. A planet can win multiple categories.

Leaders require all 50 ranks and a known building level for every planet in that
category. Incomplete data never produces a guessed winner. The control reports missing
rankings, unmapped planets, stale syncs and missing building leaders. Marker labels also
carry the snapshot time. This is the game's daily ranking, not a live building scan.

The wrapper reads only `GET /hub-api/intel/unicorn`, once on activation and every five
minutes while active. The existing hourly Best Planets watcher remains responsible for
collecting the ranking. This feature makes no game requests and performs no game actions.
It adds isolated spans beside the existing labels, leaving native values and clicks
intact; OFF/expiry removes them. A debounced observer handles content replaced inside
the frame without requesting more data or reacting to its own markers.

Implementation lives in `public/js/ui/unicorn-mode.js`, `public/js/core/unicorn-markers.js`
and the dual-runtime `public/js/utils/unicorn-mode.js`. The stylesheet is shared by the
wrapper's control and the frame's annotations. All tests use synthetic data.

## Ranking observations and rollout

The existing Best Planets page read now records nullable HF/RF/GC/RL values along with
rank and planet id. Only exact abbreviations supplied for this feature and the established
English building names are recognized. Shuffled columns are supported; missing, spanning,
duplicate or unrecognized columns stay unknown. The generic parser used by secret bonus
goals is unchanged. No extra request to the game was introduced.

The database adds four nullable columns to the existing ranking snapshot on startup.
Older clients that send only rank/id remain compatible and replace building data with
unknown values. After deployment, refresh the wrapper and let its normal hourly Best
Planets watcher capture the next snapshot. A missing building leader means the required
50 observations have not been captured; it is not evidence that the maximum is zero.

The production Best Planets column layout has not been inspected in this change. Browser
verification used a synthetic map/system and ranking fixtures; any unsupported live header
will leave the corresponding building leaders unavailable until that wording is confirmed.
All source times are sync times, not a claim that the daily ranking changed at that moment.
