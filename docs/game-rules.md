# Game rules

Reference tables and formulas for AstroWars, transcribed from the **in-game info pages**
(the `/Info/*` modals) plus notes from playing. The game's own help is outdated and there
are no external guides, so this file is the closest thing to ground truth we have.

**These numbers are the game's, not ours.** When a calculator in this repo disagrees with a
table here, the calculator is wrong. Treat that the same way as
[`battle-fixtures.json`](../src/utils/battle-fixtures.json): do not edit a number here to
make code agree — fix the code, or re-check the table in game.

Levels not listed in a table are levels the game does not show; where a table skips numbers
(the economy table lists 0, 4, 7, 10 …) those are the only breakpoints that change anything.

## Contents

- [Race picks](#race-picks)
- [Bonuses stack multiplicatively](#bonuses-stack-multiplicatively-not-additively)
- [Population growth](#population-growth)
- [Production](#production)
- [Buildings](#buildings)
- [Supply units](#supply-units)
- [Culture and planet slots](#culture-and-planet-slots)
- [Science](#science)
- [Science fields — effects](#science-fields--effects)
- [Social (population cap)](#social-population-cap)
- [Economy (ship costs)](#economy-ship-costs)
- [Starbase](#starbase)
- [Artifacts](#artifacts)
- [Alliance](#alliance)
- [Trade agreements](#trade-agreements)
- [Max Combat Value](#max-combat-value)
- [Spending production points](#spending-production-points)
- [Buying production points](#buying-production-points)
- [Colonizing and conquering](#colonizing-and-conquering)
- [Fleet and combat notes](#fleet-and-combat-notes)
- [Score](#score)
- [Late-joiner catch-up](#late-joiner-catch-up)
- [Win conditions](#win-conditions)
- [Alliance ranking and points](#alliance-ranking-and-points)
- [Player level](#player-level)

---

## Race picks

At race creation you spend points across seven scalable traits, each an integer (known
range: **-4 to +4** for growth/science/culture/production, confirmed elsewhere in this
game's own trait descriptions; speed/attack/defence are very likely the same range but that
has not been separately confirmed). **All picks must sum to exactly 0** — the creation
screen enforces this directly, so a bonus anywhere is a malus somewhere else.

| Trait | %/point |
|---|---|
| Growth | 8% |
| Science | 8% |
| Culture | 4% |
| Production | 4% |
| Speed | 11% |
| Attack | 7% |
| Defence | 11% |

Two additional picks are one-time toggles rather than a scalable stat — each has a fixed
point **cost** that must be offset by the seven traits above summing correspondingly
negative, so the grand total still lands on 0:

| Pick | Cost | Effect |
|---|---|---|
| **Startup Lab (SUL)** | 1 | Starts with 12 research-lab buildings already built |
| **Trader** | 6 | Can accept trade agreements for free (no A$ cost to accept) |

    (sum of the 7 trait picks) + (1 if SUL) + (6 if Trader) = 0

Worked example — `-4 Growth, +4 Science, 0 Culture, 0 Production, -4 Speed, +3 Attack, 0
Defence, + SUL`: the seven traits sum to `-4+4+0+0-4+3+0 = -1`, and SUL's cost of `1` brings
the total to `-1 + 1 = 0`.

### Playstyles

Players build very different races and build orders around the same trait pool — there is
no single "correct" allocation. Two archetypes that come up a lot:

- **Culture pushers** — favour Culture to unlock planet slots faster and grow the empire
  wide rather than tall.
- **Speeders** — run heavy +Speed (e.g. +4) alongside high Energy (40+), trading other
  traits away for fleets that arrive faster than everyone else's.

This section is about what players *choose to do*, not a game mechanic — it will not be
consistent across an alliance and is not something a calculator should assume.

## Bonuses stack multiplicatively, not additively

Every growth/production/science/culture bonus in this doc — race pick %, artifacts, trade
rate (TR%), economy bonus — combines with the others by **multiplying `(1 + bonus)` factors
together**, not by adding percentages.

Worked example: +4 Science race pick (`4 × 8% = 32%`), plus a Memory Jar 3 artifact
(`+30%` production and science), plus 85% TR (80% trade rate + 5% economy bonus, which is
**additive to TR%**, see [Economy bonus](#economy-bonus) below):

    total bonus = (1 + 0.32) × (1 + 0.30) × (1 + 0.85) − 1 = +217%

not `32 + 30 + 85 = 147%`.

## Population growth

A planet has a base growth of **1.0 point**, and each **Hydroponic Farm** generates
**1.0 growth point per hour**. That base is then multiplied by the growth bonus/malus from
race, trade agreements and artifacts.

    growth/h = (hydroponic farms + 1) × growth bonus

Worked example from the info page: a planet with 10 hydroponic farms has a base of 11.0
growth points; with a +93% growth bonus that is `11 × 1.93 = 21.23` points per hour. At
population level 20 the next level needs 3,783 points, so `3,783 / 21.23 = 7d 10h:11m:28s`.

| Level | Growth Points | Aggregated |
|---|---|---|
| 1 | 0 | 0 |
| 2 | 21 | 21 |
| 3 | 57 | 78 |
| 4 | 111 | 189 |
| 5 | 183 | 372 |
| 6 | 273 | 645 |
| 7 | 381 | 1,026 |
| 8 | 507 | 1,533 |
| 9 | 651 | 2,184 |
| 10 | 813 | 2,997 |
| 11 | 993 | 3,990 |
| 12 | 1,191 | 5,181 |
| 13 | 1,407 | 6,588 |
| 14 | 1,641 | 8,229 |
| 15 | 1,893 | 10,122 |
| 16 | 2,163 | 12,285 |
| 17 | 2,451 | 14,736 |
| 18 | 2,757 | 17,493 |
| 19 | 3,081 | 20,574 |
| 20 | 3,423 | 23,997 |
| 21 | 3,783 | 27,780 |
| 22 | 4,161 | 31,941 |
| 23 | 4,557 | 36,498 |
| 24 | 4,971 | 41,469 |
| 25 | 5,403 | 46,872 |
| 26 | 5,853 | 52,725 |
| 27 | 6,321 | 59,046 |
| 28 | 6,807 | 65,853 |
| 29 | 7,311 | 73,164 |
| 30 | 7,833 | 80,997 |
| 31 | 8,373 | 89,370 |
| 32 | 8,931 | 98,301 |
| 33 | 9,507 | 107,808 |
| 34 | 10,101 | 117,909 |
| 35 | 10,713 | 128,622 |
| 36 | 11,343 | 139,965 |
| 37 | 11,991 | 151,956 |
| 38 | 12,657 | 164,613 |
| 39 | 13,341 | 177,954 |
| 40 | 14,043 | 191,997 |
| 41 | 14,763 | 206,760 |
| 42 | 15,501 | 222,261 |
| 43 | 16,257 | 238,518 |
| 44 | 17,031 | 255,549 |
| 45 | 17,823 | 273,372 |
| 46 | 18,633 | 292,005 |
| 47 | 19,461 | 311,466 |
| 48 | 20,307 | 331,773 |
| 49 | 21,171 | 352,944 |
| 50 | 22,053 | 374,997 |
| 51 | 22,953 | 397,950 |
| 52 | 23,871 | 421,821 |
| 53 | 24,807 | 446,628 |
| 54 | 25,761 | 472,389 |
| 55 | 26,733 | 499,122 |
| 56 | 27,723 | 526,845 |
| 57 | 28,731 | 555,576 |
| 58 | 29,757 | 585,333 |
| 59 | 30,801 | 616,134 |
| 60 | 31,863 | 647,997 |
| 61 | 32,943 | 680,940 |
| 62 | 34,041 | 714,981 |
| 63 | 35,157 | 750,138 |
| 64 | 36,291 | 786,429 |
| 65 | 37,443 | 823,872 |
| 66 | 38,613 | 862,485 |
| 67 | 39,801 | 902,286 |
| 68 | 41,007 | 943,293 |
| 69 | 42,231 | 985,524 |
| 70 | 43,473 | 1,028,997 |
| 71 | 44,733 | 1,073,730 |
| 72 | 46,011 | 1,119,741 |
| 73 | 47,307 | 1,167,048 |
| 74 | 48,621 | 1,215,669 |
| 75 | 49,953 | 1,265,622 |
| 76 | 51,303 | 1,316,925 |
| 77 | 52,671 | 1,369,596 |
| 78 | 54,057 | 1,423,653 |
| 79 | 55,461 | 1,479,114 |
| 80 | 56,883 | 1,535,997 |
| 81 | 58,323 | 1,594,320 |
| 82 | 59,781 | 1,654,101 |
| 83 | 61,257 | 1,715,358 |
| 84 | 62,751 | 1,778,109 |
| 85 | 64,263 | 1,842,372 |
| 86 | 65,793 | 1,908,165 |
| 87 | 67,341 | 1,975,506 |
| 88 | 68,907 | 2,044,413 |
| 89 | 70,491 | 2,114,904 |
| 90 | 72,093 | 2,186,997 |
| 91 | 73,713 | 2,260,710 |
| 92 | 75,351 | 2,336,061 |
| 93 | 77,007 | 2,413,068 |
| 94 | 78,681 | 2,491,749 |
| 95 | 80,373 | 2,572,122 |
| 96 | 82,083 | 2,654,205 |
| 97 | 83,811 | 2,738,016 |
| 98 | 85,557 | 2,823,573 |
| 99 | 87,321 | 2,910,894 |
| 100 | 89,103 | 2,999,997 |

## Production

Each **Robotic Factory** and each **population level** generates **1.0 production point per
hour**, then the production bonus/malus applies.

    PP/h = (robotic factories + population level) × production bonus

Worked example: 11 factories and population level 20 is a base of `(11 + 20) × 1.0 = 31.0`,
and with +62.1% that is `31 × 1.62 = 50.26` production points per hour.

## Buildings

Cost to raise any building one level. **Aggregated** is the running total from level 0.

| Building Level | Production Points | Aggregated |
|---|---|---|
| 1 | 5 | 5 |
| 2 | 8 | 13 |
| 3 | 11 | 24 |
| 4 | 17 | 41 |
| 5 | 25 | 66 |
| 6 | 38 | 104 |
| 7 | 57 | 161 |
| 8 | 85 | 246 |
| 9 | 128 | 374 |
| 10 | 192 | 566 |
| 11 | 288 | 854 |
| 12 | 432 | 1,286 |
| 13 | 649 | 1,935 |
| 14 | 973 | 2,908 |
| 15 | 1,460 | 4,368 |
| 16 | 2,189 | 6,557 |
| 17 | 3,284 | 9,841 |
| 18 | 4,926 | 14,767 |
| 19 | 7,389 | 22,156 |
| 20 | 11,084 | 33,240 |
| 21 | 16,626 | 49,866 |
| 22 | 24,939 | 74,805 |
| 23 | 37,409 | 112,214 |
| 24 | 56,114 | 168,328 |
| 25 | 84,171 | 252,499 |
| 26 | 126,256 | 378,755 |
| 27 | 189,384 | 568,139 |
| 28 | 284,076 | 852,215 |
| 29 | 426,113 | 1,278,328 |
| 30 | 639,170 | 1,917,498 |

## Supply units

Past the point production points can no longer raise a building (the PP cost table above
tops out), further levels are bought with **Supply Units (SU)** instead. Each building type
has its own current SU cost, which **drops as more players spend SU** on that building type
galaxy-wide and rises again over time — it isn't a fixed price:

| Building | SU cost |
|---|---|
| Galactic Cybernet | 200 |
| Hydroponic Farm | 300 |
| Research Lab | 250 |
| Robotic Factory | 150 |

Not currently used anywhere in awt's code — general reference only.

## Culture and planet slots

**Culture level is the number of planets you may own.** Reaching the next culture level is
what unlocks the next colony slot.

| Culture Level | Max Planets |
|---|---|
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |
| 4 | 4 |
| 5 | 5 |
| 6 | 6 |
| 7 | 7 |
| 8 | 8 |
| 9 | 9 |
| 10 | 10 |
| 11 | 11 |
| 12 | 12 |
| 13 | 13 |
| 14 | 14 |
| 15 | 15 |
| 16 | 16 |
| 17 | 17 |
| 18 | 18 |
| 19 | 19 |
| 20 | 20 |
| 21 | 21 |
| 22 | 22 |
| 23 | 23 |
| 24 | 24 |
| 25 | 25 |
| 26 | 26 |
| 27 | 27 |
| 28 | 28 |
| 29 | 29 |
| 30 | 30 |
| 31 | 31 |
| 32 | 32 |
| 33 | 33 |
| 34 | 34 |
| 35 | 35 |
| 36 | 36 |
| 37 | 37 |
| 38 | 38 |
| 39 | 39 |
| 40 | 40 |
| 41 | 41 |
| 42 | 42 |
| 43 | 43 |
| 44 | 44 |
| 45 | 45 |
| 46 | 46 |
| 47 | 47 |
| 48 | 48 |
| 49 | 49 |
| 50 | 50 |
| 51 | 51 |
| 52 | 52 |
| 53 | 53 |
| 54 | 54 |
| 55 | 55 |
| 56 | 56 |
| 57 | 57 |
| 58 | 58 |
| 59 | 59 |
| 60 | 60 |
| 61 | 61 |
| 62 | 62 |
| 63 | 63 |
| 64 | 64 |
| 65 | 65 |
| 66 | 66 |
| 67 | 67 |
| 68 | 68 |
| 69 | 69 |
| 70 | 70 |
| 71 | 71 |
| 72 | 72 |
| 73 | 73 |
| 74 | 74 |
| 75 | 75 |
| 76 | 76 |
| 77 | 77 |
| 78 | 78 |
| 79 | 79 |
| 80 | 80 |
| 81 | 81 |
| 82 | 82 |
| 83 | 83 |
| 84 | 84 |
| 85 | 85 |
| 86 | 86 |
| 87 | 87 |
| 88 | 88 |
| 89 | 89 |
| 90 | 90 |
| 91 | 91 |
| 92 | 92 |
| 93 | 93 |
| 94 | 94 |
| 95 | 95 |
| 96 | 96 |
| 97 | 97 |
| 98 | 98 |
| 99 | 99 |
| 100 | 100 |

### Culture growth

| Level | Points | Aggregated |
|---|---|---|
| 1 | 0 | 0 |
| 2 | 318 | 318 |
| 3 | 765 | 1,083 |
| 4 | 1,315 | 2,398 |
| 5 | 2,084 | 4,482 |
| 6 | 2,985 | 7,467 |
| 7 | 4,059 | 11,526 |
| 8 | 5,320 | 16,846 |
| 9 | 6,785 | 23,631 |
| 10 | 8,467 | 32,098 |
| 11 | 10,382 | 42,480 |
| 12 | 12,547 | 55,027 |
| 13 | 14,979 | 70,006 |
| 14 | 17,697 | 87,703 |
| 15 | 20,721 | 108,424 |
| 16 | 24,071 | 132,495 |
| 17 | 27,768 | 160,263 |
| 18 | 31,835 | 192,098 |
| 19 | 36,298 | 228,396 |
| 20 | 41,179 | 269,575 |
| 21 | 46,507 | 316,082 |
| 22 | 52,310 | 368,392 |
| 23 | 58,616 | 427,008 |
| 24 | 65,456 | 492,464 |
| 25 | 72,863 | 565,327 |
| 26 | 79,610 | 644,937 |
| 27 | 87,319 | 732,256 |
| 28 | 95,415 | 827,671 |
| 29 | 103,900 | 931,571 |
| 30 | 112,772 | 1,044,343 |
| 31 | 122,032 | 1,166,375 |
| 32 | 131,680 | 1,298,055 |
| 33 | 141,715 | 1,439,770 |
| 34 | 152,138 | 1,591,908 |
| 35 | 162,949 | 1,754,857 |
| 36 | 174,148 | 1,929,005 |
| 37 | 185,734 | 2,114,739 |
| 38 | 197,708 | 2,312,447 |
| 39 | 210,069 | 2,522,516 |
| 40 | 222,819 | 2,745,335 |
| 41 | 235,956 | 2,981,291 |
| 42 | 249,481 | 3,230,772 |
| 43 | 263,393 | 3,494,165 |
| 44 | 277,693 | 3,771,858 |
| 45 | 292,381 | 4,064,239 |
| 46 | 307,457 | 4,371,696 |
| 47 | 322,920 | 4,694,616 |
| 48 | 338,771 | 5,033,387 |
| 49 | 355,010 | 5,388,397 |
| 50 | 371,637 | 5,760,034 |
| 51 | 388,651 | 6,148,685 |
| 52 | 406,053 | 6,554,738 |
| 53 | 423,843 | 6,978,581 |
| 54 | 442,020 | 7,420,601 |
| 55 | 460,585 | 7,881,186 |
| 56 | 479,538 | 8,360,724 |
| 57 | 498,879 | 8,859,603 |
| 58 | 518,607 | 9,378,210 |
| 59 | 538,723 | 9,916,933 |
| 60 | 559,227 | 10,476,160 |
| 61 | 580,118 | 11,056,278 |
| 62 | 601,397 | 11,657,675 |
| 63 | 623,064 | 12,280,739 |
| 64 | 645,118 | 12,925,857 |
| 65 | 667,561 | 13,593,418 |
| 66 | 690,391 | 14,283,809 |
| 67 | 713,608 | 14,997,417 |
| 68 | 737,214 | 15,734,631 |
| 69 | 761,207 | 16,495,838 |
| 70 | 785,588 | 17,281,426 |
| 71 | 810,356 | 18,091,782 |
| 72 | 835,513 | 18,927,295 |
| 73 | 861,057 | 19,788,352 |
| 74 | 886,988 | 20,675,340 |
| 75 | 913,308 | 21,588,648 |
| 76 | 940,015 | 22,528,663 |
| 77 | 967,110 | 23,495,773 |
| 78 | 994,592 | 24,490,365 |
| 79 | 1,022,463 | 25,512,828 |
| 80 | 1,050,721 | 26,563,549 |
| 81 | 1,079,366 | 27,642,915 |
| 82 | 1,108,400 | 28,751,315 |
| 83 | 1,137,821 | 29,889,136 |
| 84 | 1,167,630 | 31,056,766 |
| 85 | 1,197,826 | 32,254,592 |
| 86 | 1,228,411 | 33,483,003 |
| 87 | 1,259,383 | 34,742,386 |
| 88 | 1,290,742 | 36,033,128 |
| 89 | 1,322,490 | 37,355,618 |
| 90 | 1,354,625 | 38,710,243 |
| 91 | 1,387,148 | 40,097,391 |
| 92 | 1,420,058 | 41,517,449 |
| 93 | 1,453,357 | 42,970,806 |
| 94 | 1,487,043 | 44,457,849 |
| 95 | 1,521,116 | 45,978,965 |
| 96 | 1,555,578 | 47,534,543 |
| 97 | 1,590,427 | 49,124,970 |
| 98 | 1,625,664 | 50,750,634 |
| 99 | 1,661,289 | 52,411,923 |
| 100 | 1,697,301 | 54,109,224 |

## Science

One science is researched at a time and all sciences share the same science rate; culture
has its own. The rate shown in game **already includes** the percentage bonus badge next to
it, so the pre-bonus base is `rate ÷ (1 + bonus)`.

    sci/h = (research labs + population) × science bonus

| Level | Science Points | Aggregated |
|---|---|---|
| 1 | 29 | 29 |
| 2 | 74 | 103 |
| 3 | 138 | 241 |
| 4 | 221 | 462 |
| 5 | 325 | 787 |
| 6 | 451 | 1,238 |
| 7 | 603 | 1,841 |
| 8 | 780 | 2,621 |
| 9 | 986 | 3,607 |
| 10 | 1,223 | 4,830 |
| 11 | 1,492 | 6,322 |
| 12 | 1,796 | 8,118 |
| 13 | 2,138 | 10,256 |
| 14 | 2,520 | 12,776 |
| 15 | 2,945 | 15,721 |
| 16 | 3,415 | 19,136 |
| 17 | 3,934 | 23,070 |
| 18 | 4,505 | 27,575 |
| 19 | 5,131 | 32,706 |
| 20 | 5,816 | 38,522 |
| 21 | 6,563 | 45,085 |
| 22 | 7,377 | 52,462 |
| 23 | 8,261 | 60,723 |
| 24 | 9,221 | 69,944 |
| 25 | 10,260 | 80,204 |
| 26 | 11,382 | 91,586 |
| 27 | 12,595 | 104,181 |
| 28 | 13,901 | 118,082 |
| 29 | 15,400 | 133,482 |
| 30 | 16,715 | 150,197 |
| 31 | 18,866 | 169,063 |
| 32 | 20,863 | 189,926 |
| 33 | 23,056 | 212,982 |
| 34 | 25,465 | 238,447 |
| 35 | 28,109 | 266,556 |
| 36 | 31,014 | 297,570 |
| 37 | 34,203 | 331,773 |
| 38 | 37,705 | 369,478 |
| 39 | 41,551 | 411,029 |
| 40 | 45,774 | 456,803 |
| 41 | 50,411 | 507,214 |
| 42 | 55,504 | 562,718 |
| 43 | 61,096 | 623,814 |
| 44 | 67,237 | 691,051 |
| 45 | 73,980 | 765,031 |
| 46 | 81,385 | 846,416 |
| 47 | 89,517 | 935,933 |
| 48 | 98,447 | 1,034,380 |
| 49 | 108,252 | 1,142,632 |
| 50 | 119,020 | 1,261,652 |
| 51 | 130,845 | 1,392,497 |
| 52 | 143,829 | 1,536,326 |
| 53 | 158,088 | 1,694,414 |
| 54 | 173,746 | 1,868,160 |
| 55 | 190,940 | 2,059,100 |
| 56 | 209,821 | 2,268,921 |
| 57 | 230,555 | 2,499,476 |
| 58 | 253,323 | 2,752,799 |
| 59 | 278,326 | 3,031,125 |
| 60 | 305,781 | 3,336,906 |
| 61 | 335,931 | 3,672,837 |
| 62 | 369,039 | 4,041,876 |
| 63 | 405,395 | 4,447,271 |
| 64 | 445,319 | 4,892,590 |
| 65 | 489,160 | 5,381,750 |
| 66 | 537,302 | 5,919,052 |
| 67 | 590,169 | 6,509,221 |
| 68 | 648,223 | 7,157,444 |
| 69 | 711,973 | 7,869,417 |
| 70 | 781,978 | 8,651,395 |
| 71 | 858,852 | 9,510,247 |
| 72 | 943,269 | 10,453,516 |
| 73 | 1,035,969 | 11,489,485 |
| 74 | 1,137,765 | 12,627,250 |
| 75 | 1,249,549 | 13,876,799 |
| 76 | 1,372,301 | 15,249,100 |
| 77 | 1,507,098 | 16,756,198 |
| 78 | 1,655,122 | 18,411,320 |
| 79 | 1,817,669 | 20,228,989 |
| 80 | 1,996,166 | 22,225,155 |
| 81 | 2,192,176 | 24,417,331 |
| 82 | 2,407,420 | 26,824,751 |
| 83 | 2,643,783 | 29,468,534 |
| 84 | 2,903,338 | 32,371,872 |
| 85 | 3,188,361 | 35,560,233 |
| 86 | 3,501,350 | 39,061,583 |
| 87 | 3,845,050 | 42,906,633 |
| 88 | 4,222,474 | 47,129,107 |
| 89 | 4,636,931 | 51,766,038 |
| 90 | 5,092,055 | 56,858,093 |
| 91 | 5,591,836 | 62,449,929 |
| 92 | 6,140,655 | 68,590,584 |
| 93 | 6,743,325 | 75,333,909 |
| 94 | 7,405,129 | 82,739,038 |
| 95 | 8,131,869 | 90,870,907 |
| 96 | 8,929,917 | 99,800,824 |
| 97 | 9,806,271 | 109,607,095 |
| 98 | 10,768,612 | 120,375,707 |
| 99 | 11,825,379 | 132,201,086 |
| 100 | 12,985,836 | 145,186,922 |

## Science fields — effects

Each of the six science fields does something different besides its raw growth rate:

- **Biology** — increases vision range on the map (1 square per level, `VisionFactor = 1`;
  see [Fleet and combat notes](#fleet-and-combat-notes) for the ≥6-level intel-report rule).
  Fleets can only be sent to systems currently visible on the map. **At level 25**, fleets can
  be sent by System ID directly instead of needing the system's name.
- **Economy** — reduces ship construction cost (see [Economy (ship costs)](#economy-ship-costs)
  for the exact curve and the 8×/20× destroyer-cruiser-battleship ratio, and
  [Economy bonus](#economy-bonus) for the join-cohort +5%).
- **Energy** — reduces fleet travel time. Each level is **91% of the previous level's time**
  (`0.91^energy`), and this only applies **at launch** — fleets already in flight don't
  benefit until they land and launch again. Landing on a planet you or an ally controls
  **always halves** the flight time. (Matches `public/js/utils/travel-model.js` exactly —
  `ENERGY_BASE = 0.91`, alliance/own-destination ×0.5.)
- **Mathematics** — reduces combat losses (more survivors). **Level 12** lets you manually
  choose any energy level from 1 up to your max at launch, instead of always launching at
  max energy. **Level 15** is required to build Cruisers.
  > The old help text claims a flat **25%** survivor bonus/malus once the mathematics gap
  > between two players reaches 6 levels (plus a smaller, unlisted bonus below that gap).
  > `public/js/utils/battle-model.js` instead uses a **12.5%** toughness multiplier
  > (`MATH_BRACKET = 0.125`) fitted against real battle-fixture data — see
  > `docs/battle-model.md`. Treat the fitted 12.5% as authoritative; the 25% in the old help
  > text may describe an earlier, unrebalanced version of the mechanic.
- **Physics** — increases win chance. **Level 15** is required to build Battleships. The old
  help text claims a flat **25%** win-chance bonus at a 6-level physics gap; the calibrated
  model in `battle-model.js` (`WIN_PHYS_BASE6`/`WIN_PHYS_SLOPE`) uses a logit-space term
  fitted to real outcomes rather than a flat linear percentage — same caveat as Mathematics
  above, don't treat "25%" as literal.
- **Social** — raises the population cap per planet (see the table below). If a Hydroponic
  Farm shows **+0 growth**, the planet has hit its population cap and needs a higher Social
  level to grow further. **Spontaneous growth**: at the 00:00 CET daily update, if any of
  your planets sits 6+ population levels below your Social level, one such planet is chosen
  at random and instantly gains **+1 population level** for free.

## Social (population cap)

Social level caps population per planet, and also feeds the
[max combat value](#max-combat-value) formula.

| Level | Max Population |
|---|---|
| 0 | 5 |
| 1 | 5 |
| 2 | 6 |
| 3 | 6 |
| 4 | 7 |
| 5 | 7 |
| 6 | 8 |
| 7 | 8 |
| 8 | 9 |
| 9 | 9 |
| 10 | 10 |
| 11 | 11 |
| 12 | 12 |
| 13 | 13 |
| 14 | 14 |
| 15 | 15 |
| 16 | 16 |
| 17 | 17 |
| 18 | 18 |
| 19 | 19 |
| 20 | 20 |
| 21 | 21 |
| 22 | 22 |
| 23 | 23 |
| 24 | 24 |
| 25 | 25 |

## Economy (ship costs)

Economy level lowers ship cost in production points. Only the levels listed change the
price. The cruiser is always **8×** the destroyer and the battleship **20×**, at every level.

> **Floor at 1 PP.** The table stops at economy 97, where a destroyer costs 1 PP. Economy
> 98–100 do **not** continue down to 0 — they stay at the level-97 price. Any formula for
> this must clamp at a minimum of 1 PP per destroyer.

The prices below are matched exactly by:

    destroyer PP = max(1, 30 - floor(economy × 0.3))
    cruiser PP   = destroyer × 8
    battleship PP = destroyer × 20

| Level | Destroyer | Cruiser | Battleship |
|---|---|---|---|
| 0 | 30 | 240 | 600 |
| 4 | 29 | 232 | 580 |
| 7 | 28 | 224 | 560 |
| 10 | 27 | 216 | 540 |
| 14 | 26 | 208 | 520 |
| 17 | 25 | 200 | 500 |
| 20 | 24 | 192 | 480 |
| 24 | 23 | 184 | 460 |
| 27 | 22 | 176 | 440 |
| 30 | 21 | 168 | 420 |
| 34 | 20 | 160 | 400 |
| 37 | 19 | 152 | 380 |
| 40 | 18 | 144 | 360 |
| 44 | 17 | 136 | 340 |
| 47 | 16 | 128 | 320 |
| 50 | 15 | 120 | 300 |
| 54 | 14 | 112 | 280 |
| 57 | 13 | 104 | 260 |
| 60 | 12 | 96 | 240 |
| 64 | 11 | 88 | 220 |
| 67 | 10 | 80 | 200 |
| 70 | 9 | 72 | 180 |
| 74 | 8 | 64 | 160 |
| 77 | 7 | 56 | 140 |
| 80 | 6 | 48 | 120 |
| 84 | 5 | 40 | 100 |
| 87 | 4 | 32 | 80 |
| 90 | 3 | 24 | 60 |
| 94 | 2 | 16 | 40 |
| 97 | 1 | 8 | 20 |

## Starbase

**Costs** is the cost of that level; **aggregated** is the running total.

| Level | Attack | Defence | Combat Value | Costs | Aggregated |
|---|---|---|---|---|---|
| 1 | 1 | 1 | 2 | 5 | 5 |
| 2 | 2 | 2 | 5 | 8 | 13 |
| 3 | 5 | 5 | 10 | 11 | 24 |
| 4 | 8 | 8 | 16 | 17 | 41 |
| 5 | 13 | 13 | 26 | 25 | 66 |
| 6 | 21 | 21 | 42 | 38 | 104 |
| 7 | 32 | 32 | 64 | 57 | 161 |
| 8 | 49 | 49 | 99 | 85 | 246 |
| 9 | 75 | 75 | 150 | 128 | 374 |
| 10 | 113 | 113 | 227 | 192 | 566 |
| 11 | 171 | 171 | 342 | 288 | 854 |
| 12 | 257 | 257 | 515 | 432 | 1,286 |
| 13 | 387 | 387 | 774 | 649 | 1,935 |
| 14 | 582 | 582 | 1,164 | 973 | 2,908 |
| 15 | 874 | 874 | 1,748 | 1,460 | 4,368 |
| 16 | 1,311 | 1,311 | 2,623 | 2,189 | 6,557 |
| 17 | 1,968 | 1,968 | 3,937 | 3,284 | 9,841 |
| 18 | 2,954 | 2,954 | 5,908 | 4,926 | 14.8K |
| 19 | 4,431 | 4,431 | 8,863 | 7,389 | 22.2K |
| 20 | 6,648 | 6,648 | 13,297 | 11.1K | 33.2K |
| 21 | 9,974 | 9,974 | 19,948 | 16.6K | 49.9K |
| 22 | 15.0K | 15.0K | 29,923 | 24.9K | 74.8K |
| 23 | 22.4K | 22.4K | 44,887 | 37.4K | 112K |
| 24 | 33.7K | 33.7K | 67,332 | 56.1K | 168K |
| 25 | 50.5K | 50.5K | 101.0K | 84.2K | 252K |
| 26 | 75.8K | 75.8K | 151.5K | 126K | 378K |
| 27 | 113K | 113K | 227.3K | 189K | 568K |
| 28 | 170K | 170K | 340.9K | 284K | 852K |
| 29 | 255K | 255K | 511.3K | 426K | 1.28M |
| 30 | 383K | 383K | 767.0K | 639K | 1.92M |
| 31 | 575K | 575K | 1.151M | 958K | 2.88M |
| 32 | 862K | 862K | 1.726M | 1.44M | 4.31M |
| 33 | 1.29M | 1.29M | 2.589M | 2.16M | 6.47M |
| 34 | 1.94M | 1.94M | 3.883M | 3.24M | 9.71M |
| 35 | 2.91M | 2.91M | 5.824M | 4.85M | 14.6M |
| 36 | 4.37M | 4.37M | 8.737M | 7.28M | 21.8M |
| 37 | 6.55M | 6.55M | 13.10M | 10.9M | 32.8M |
| 38 | 9.83M | 9.83M | 19.66M | 10.9M | 43.7M |
| 39 | 14.7M | 14.7M | 29.49M | 10.9M | 54.6M |
| 40 | 22.1M | 22.1M | 44.23M | 10.9M | 65.5M |
| 41 | 33.2M | 33.2M | 66.34M | 10.9M | 76.4M |
| 42 | 49.8M | 49.8M | 99.52M | 10.9M | 87.4M |
| 43 | 74.6M | 74.6M | 149.3M | 10.9M | 98.3M |
| 44 | 111M | 111M | 223.9M | 10.9M | 109M |
| 45 | 167M | 167M | 335.9M | 10.9M | 120M |

## Artifacts

Bought with astro dollars. Prices move with the market — the ones below were captured near
the end of a round, so treat them as relative rather than current.

| Player Level | Type | Growth | Science | Culture | Production | Price |
|---|---|---|---|---|---|---|
| 1 | Basalt Monolith 1 | +0% | +0% | +10% | +0% | $2,608.81 |
| 2 | Astrolabe 1 | +0% | +10% | +0% | +0% | $1,783.96 |
| 3 | Celestial Prism 1 | +10% | +0% | +0% | +0% | $1,862.66 |
| 4 | Crystal Rod 1 | +10% | +0% | +10% | +0% | $7,292.89 |
| 5 | Charcoal Diamond 1 | +0% | +0% | +0% | +10% | $2,573.98 |
| 6 | Memory Jar 1 | +0% | +10% | +0% | +10% | $7,718.32 |
| 7 | Heart Of Rana 1 | +10% | +10% | +10% | +10% | $30,721.53 |
| 8 | Basalt Monolith 2 | +0% | +0% | +20% | +0% | $10,067.19 |
| 9 | Astrolabe 2 | +0% | +20% | +0% | +0% | $5,315.63 |
| 10 | Celestial Prism 2 | +20% | +0% | +0% | +0% | $4,972.73 |
| 11 | Crystal Rod 2 | +20% | +0% | +20% | +0% | $29,301.14 |
| 12 | Charcoal Diamond 2 | +0% | +0% | +0% | +20% | $10,658.69 |
| 13 | Memory Jar 2 | +0% | +20% | +0% | +20% | $32,448.62 |
| 14 | Heart Of Rana 2 | +20% | +20% | +20% | +20% | $120,193.37 |
| 15 | Basalt Monolith 3 | +0% | +0% | +30% | +0% | $22,498.88 |
| 16 | Astrolabe 3 | +0% | +30% | +0% | +0% | $11,102.13 |
| 17 | Celestial Prism 3 | +30% | +0% | +0% | +0% | $11,024.45 |
| 18 | Crystal Rod 3 | +30% | +0% | +30% | +0% | $65,025.00 |
| 19 | Charcoal Diamond 3 | +0% | +0% | +0% | +30% | $24,034.97 |
| 20 | Memory Jar 3 | +0% | +30% | +0% | +30% | $72,735.17 |
| 21 | Heart Of Rana 3 | +30% | +30% | +30% | +30% | $273,813.51 |

## Alliance

| Action | Fee |
|---|---|
| Create an alliance | 1,000 A$ |
| Change alliance name | 200 A$ |
| Change alliance tag | 500 A$ |
| Change alliance color | 500 A$ |

## Trade agreements

- Cost **20,000 A$**, paid by **both** sides — to send and to accept.
- **Maximum 5** trade agreements per player.
- The **trader race** pick can accept for free, but pays for it with **-6 race points**.
- New trade agreements are only **accepted at four fixed times a day: 00:00, 06:00, 12:00,
  18:00 CET/CEST** — not immediately on request.
- An unaccepted trade agreement offer **expires after 2 days**.
- The **trade rate (TR%) bonus recalculates every 5 minutes**, independent of the 6-hourly
  acceptance cycle.

> The redzone server uses a different price (**120,000**) — see the trade-agreement planner
> at `/ta`, which is redzone-only.

### Economy bonus

Every 25 players who joined around the same time are grouped into a **join cohort**. Whoever
in that cohort of 25 has the highest economy science gets a **+5% economy bonus**, which is
**additive to TR%** (not a separate multiplicative factor) — e.g. 80% TR% + 5% economy bonus
combine to 85% before being multiplied with everything else. See
[Bonuses stack multiplicatively](#bonuses-stack-multiplicatively-not-additively).

## Max Combat Value

You may not deploy more combat value than your permitted maximum. The limit caps overall
military strength by empire size and social development.

**Once reached, the CV limit is permanent and cannot decrease.**

    MaxCombatValue  = (sum of all population levels) × (social level + 3) × 11
    UsedCombatValue = (sum of all starbase CV) × 0 + (sum of all fleet CV)

Note the factor is **11**, and starbase combat value is multiplied by **zero** — starbases
do not consume the limit.

## Spending production points

You can spend the production points from **all** planets on ships or galactic trade only if
you meet all of:

- at least **150 PP** total
- at least **player level 1**
- at least one planet at **population level 5+**

**Note:** when selling PP for astro dollars, only **70%** of the PP on a **sieged** planet is
converted — the rest is lost.

## Buying production points

Astro dollars buy production points only on your **main planet** — the planet with the
**highest population** (populations compare to 2 decimal places; all planets are ranked by
this).

If your main planet is under siege, the next-highest-population planet becomes purchasable
instead, but every already-sieged planet ranked above it in the list stacks a **5% penalty**
on the amount of PP bought.

Example: 5 planets ranked by population — 6, 5, 5, 4, 2. Buying 1,000 A$ of PP at a 1:1 price
normally gets you 1,000 PP on the 6-pop planet. If that planet and the first 5-pop planet are
both sieged, buying now happens on the second 5-pop planet, discounted 5% per sieged planet
above it: 1,000 × 0.95 × 0.95 = 902.5, i.e. **902 PP**. The 4-pop and 2-pop planets are never
eligible regardless of siege status — buying requires **population 5+**.

## Colonizing and conquering

Unknown (unowned) planets have two sources:

- A player who **resigns** — all of their planets become Unknown and their fleet vanishes.
  Any starbase they had **keeps its level**. Any production points left on the planet can
  still be captured (see below) — but there are **no more artifacts** to be found on Unknown
  planets; that was true only in a much older version of the game.
- **New systems opening up**: systems spawn in **clusters of 5** (`SpawningClusterSize = 5`).
  Each system has 12 planets, but only 4 of them (planets 2, 5, 8, 11) are ever assigned to
  players or game-created Unknowns. A new cluster of 5 systems only opens once the current
  ones fill up (85% occupied, `CultureRatioSpawning = 0.85` — 17 of the 20 available player
  slots taken), so with 4 playable slots × 5 systems = 20 slots per cluster, the next cluster
  opens after roughly the 17th player joins. New players are randomly assigned into whichever
  open system still has space. Some of the 20 slots in a cluster are **game-created Unknowns,
  with starbase level 2 and 0 PP**, not a resigned player's leftover — exact count per cluster
  not yet confirmed.

When you capture an Unknown planet that has leftover production points (from a resigned
player), you keep **75% of the PP, up to a maximum of 750 PP**.

> Still to confirm: whether colonizing a solo/Unknown-owned planet vs. conquering one from an
> active enemy gives different starting buildings (e.g. a flat 4/4/4/4 vs. percentage combat
> damage to existing buildings) — not documented here until verified.

Colonizing (and disbanding a colony ship in general) is **not automatic on arrival** — the
player must tick a confirmation checkbox for it to happen.

**Deliberately gifting a planet to another player is discouraged by design**: the 5.0.0-beta
patch notes confirm an active anti-gifting mechanic — heavy damage to the transferred planet
and caps on its buildings — though the exact numbers aren't published.

## Fleet and combat notes

- **Colony ships and transports have 0 combat value but a defense value of 2.** This doesn't
  affect real (CV-based) battles, but it matters for **empty-fleet standoffs**: if only colony
  ships/transports are landing on a planet where colony ships/transports are already sitting,
  the ones already there **always win and kill the landing ones**.
- The ETA calculator shows a flight as **"pending" for 2 minutes** after it's ordered (not up
  to one minute, as the old help text says).
- **Battle survivors are shown as a fraction**, and the fractional part is a **survival
  chance**, not a rounding artifact: e.g. "10.7 destroyers survived" means 10 definitely
  survived and an 11th has a 70% chance of having survived.
- **Biology grants intel visibility**: if your biology level is **6 or more higher** than
  another player's, you can see their full intel — race picks, sciences, trade rate %,
  artifacts. Below that gap you see nothing about them, **unless you're in the same alliance**,
  in which case you always see everything regardless of biology.
- **Colony ships and transports never take damage when their side wins a battle.**
- **Fleets with fewer than 4 ships can lose every ship even in a battle they win** — the
  "safe if you're the bigger fleet" assumption doesn't hold at very small fleet sizes.
- Rough win-chance calibration from the official patch notes: **~80% win chance needs about
  1.2× the enemy's power; a guaranteed win needs about 1.5×.** Worth cross-checking against
  `public/js/utils/battle-model.js`'s `WIN_RA`/`WIN_RA_BASE6`/`WIN_RA_SLOPE` fit at some point.
- **Base travel time (0 Energy, +0 Speed) is 20 minutes between planets in the same system,
  45 minutes between systems** — before any energy/speed reduction. (There's a second,
  unused pair of values in the game's config, `04:00:00`/`10:00:00`; the 20min/45min pair is
  the one that matches the live travel calculator.)

## Score

Score is recalculated each daily update from population, player level and science levels.

    score = (1 × each population level above 10)
          + (1 × player level)
          + (1 × each science level above 20)

Example: two planets at population 13 and one at 11 gives 7 levels above 10; player level 3;
three science levels above 20 — total `7 + 3 + 3 = 13` points.

| Type | Score |
|---|---|
| Each Population level above 10 | 1 |
| Each Population level above 20 | 2 |
| Each Population level above 30 | 3 |
| Each Player Level | 1 |
| Each Science Level above 20 | 1 |

## Late-joiner catch-up

Every new player starts with population level 1, culture level 1, biology level 0, and
**300 production points**. Players who join after the round has already started additionally
get catch-up bonuses that scale with how late they are: **+100 production points/day**,
**+0.15 culture levels/day**, **+0.15 research levels/day**. Useful for reasoning about the
best time to join a round — the later you join, the bigger the one-time catch-up, but you
also start further behind on everything else.

## Win conditions

- A **player** wins by reaching or exceeding **400 points for a total of 5 days**.
- An **alliance** wins by reaching or exceeding **300 average alliance points for a total of
  3 days**, with a minimum of **3 members**.

## Alliance ranking and points

Alliance points are the **average score of the top members**, not of everyone.

- Members are sorted by ranking points, highest first.
- The number that counts is `CountingMembers = totalPlayers - (totalPlayers / 4)`,
  but **at least 3** always count, even in a small alliance.
- Those top scores are summed and divided by the count.

    Alliance Points = (sum of top counting members) ÷ counting members   (rounded down)

## Player level

Experience needed per player level; **aggregated** is the running total.

| Level | Experience Points | Aggregated |
|---|---|---|
| 1 | 5 | 5 |
| 2 | 27 | 32 |
| 3 | 65 | 97 |
| 4 | 114 | 211 |
| 5 | 175 | 386 |
| 6 | 245 | 631 |
| 7 | 326 | 957 |
| 8 | 415 | 1,372 |
| 9 | 513 | 1,885 |
| 10 | 621 | 2,506 |
| 11 | 735 | 3,241 |
| 12 | 859 | 4,100 |
| 13 | 989 | 5,089 |
| 14 | 1,127 | 6,216 |
| 15 | 1,273 | 7,489 |
| 16 | 1,425 | 8,914 |
| 17 | 1,586 | 10,500 |
| 18 | 1,752 | 12,252 |
| 19 | 1,926 | 14,178 |
| 20 | 2,106 | 16,284 |
| 21 | 2,292 | 18,576 |
| 22 | 2,487 | 21,063 |
| 23 | 2,685 | 23,748 |
| 24 | 2,892 | 26,640 |
| 25 | 3,105 | 29,745 |
| 26 | 3,322 | 33,067 |
| 27 | 3,547 | 36,614 |
| 28 | 3,778 | 40,392 |
| 29 | 4,014 | 44,406 |
| 30 | 4,257 | 48,663 |
| 31 | 4,506 | 53,169 |
| 32 | 4,762 | 57,931 |
| 33 | 5,024 | 62,955 |
| 34 | 5,293 | 68,248 |
| 35 | 5,568 | 73,816 |
| 36 | 5,850 | 79,666 |
| 37 | 6,138 | 85,804 |
| 38 | 6,433 | 92,237 |
| 39 | 6,734 | 98,971 |
| 40 | 7,042 | 106,013 |
| 41 | 7,356 | 113,369 |
| 42 | 7,677 | 121,046 |
| 43 | 8,004 | 129,050 |
| 44 | 8,338 | 137,388 |
| 45 | 8,678 | 146,066 |
| 46 | 9,025 | 155,091 |
| 47 | 9,378 | 164,469 |
| 48 | 9,738 | 174,207 |
| 49 | 10,104 | 184,311 |
| 50 | 10,477 | 194,788 |
| 51 | 10,856 | 205,644 |
| 52 | 11,242 | 216,886 |
| 53 | 11,634 | 228,520 |
| 54 | 12,033 | 240,553 |
| 55 | 12,438 | 252,991 |
| 56 | 12,850 | 265,841 |
| 57 | 13,268 | 279,109 |
| 58 | 13,693 | 292,802 |
| 59 | 14,124 | 306,926 |
| 60 | 14,562 | 321,488 |
| 61 | 15,006 | 336,494 |
| 62 | 15,457 | 351,951 |
| 63 | 15,914 | 367,865 |
| 64 | 16,378 | 384,243 |
| 65 | 16,848 | 401,091 |
| 66 | 17,325 | 418,416 |
| 67 | 17,808 | 436,224 |
| 68 | 18,298 | 454,522 |
| 69 | 18,794 | 473,316 |
| 70 | 19,297 | 492,613 |
| 71 | 19,806 | 512,419 |
| 72 | 20,322 | 532,741 |
| 73 | 20,844 | 553,585 |
| 74 | 21,373 | 574,958 |
| 75 | 21,908 | 596,866 |
| 76 | 22,450 | 619,316 |
| 77 | 22,998 | 642,314 |
| 78 | 23,553 | 665,867 |
| 79 | 24,114 | 689,981 |
| 80 | 24,682 | 714,663 |
| 81 | 25,256 | 739,919 |
| 82 | 25,837 | 765,756 |
| 83 | 26,424 | 792,180 |
| 84 | 27,018 | 819,198 |
| 85 | 27,618 | 846,816 |
| 86 | 28,225 | 875,041 |
| 87 | 28,838 | 903,879 |
| 88 | 29,458 | 933,337 |
| 89 | 30,084 | 963,421 |
| 90 | 30,717 | 994,138 |
| 91 | 31,356 | 1,025,494 |
| 92 | 32,002 | 1,057,496 |
| 93 | 32,654 | 1,090,150 |
| 94 | 33,313 | 1,123,463 |
| 95 | 33,978 | 1,157,441 |
| 96 | 34,650 | 1,192,091 |
| 97 | 35,328 | 1,227,419 |
| 98 | 36,013 | 1,263,432 |
| 99 | 36,704 | 1,300,136 |

### Full XP from combat

Winning a battle only pays out full XP if you had **at least 1 starbase and at least 1
surviving ship** in the fight — otherwise XP is reduced to **25%**.

### Autogrowth (unverified — needs a thorough check)

Speed/attack/defence race picks are believed to also add a small daily player-level XP
growth rate, separate from their direct combat/travel effect, and the default race (no picks)
is believed to have a baseline daily growth rate too. The official 5.0.0-beta patch notes
confirm autogrowth "depends more strongly on race picks" than before, so the *mechanic* is
real — but no exact numbers are published. awt already calculates and injects an autogrowth
number into player profiles, but the user isn't confident it's accurate — **do not treat the
current implementation's numbers as confirmed** until this is checked against real data.
| 100 | 36,704 | 1,336,840 |
