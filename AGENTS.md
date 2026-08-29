# AGENTS.md

Read this before changing anything. It is written for coding agents and for people, and
everything in it describes what this repository actually does today — not an ideal.

`README.md` tells you how to deploy the hub. This tells you what will bite you.

---

## 1. Non-negotiables

These are not style preferences. Each one exists because breaking it has a cost outside
this repository.

### `main` is human-gated, always

No agent merges to `main`. Not a local `git merge` on `main`, not `gh pr merge`, not a
fast-forward push, not "the checks were green so I merged it". The only route into `main`
is: branch, pull request, a **human** approves, a **human** merges.

This is not distrust of any particular diff. `main` is what gets deployed to the live hub,
and every other non-negotiable in this section — the traffic promise, the API budget, no
captured player data in a public repository — is a promise made by a person to a person.
A promise nobody checks is not being kept, and the human on the PR is that check.

An agent may:

- create a branch and push it
- open a pull request, and push further commits to that PR's branch
- run `npm test` and report the result in the PR

An agent must not:

- push to `main`, or force-push anything on `main`
- merge, squash or rebase a pull request into `main`
- approve a pull request, including its own
- bypass a failing check, or merge with `--admin`, `--no-verify` or any equivalent
- ask a human to rubber-stamp: the approval is a review, not a formality

Urgency is not an exception. Say in the PR body that it is urgent, and let a person decide.

### The rate limit is a promise to a person

`MAX_PER_SECOND = 5` in `public/js/utils/game-rate-limit.js` is an agreement with the
**game's administrator** about how hard this tool may hit their server. It is not a
throughput setting.

Raising it needs their consent, not a code review. If a change appears to need more
requests per second, the change is wrong. `src/utils/game-traffic.js` enforces the same
number again on the server, because the browser side is code running on a member's machine
and cannot be the floor.

### This repository is public

Both remotes are public. `README.md` calls this "a private tool for an alliance" — that
describes the audience, not the visibility.

Never commit captured game data. Real API and page responses contain other players' names,
country codes, login timestamps, activity patterns and intelligence reports. Those people
did not agree to be published, and the game's administrator cannot agree on their behalf.

Test fixtures are hand-written or synthetic. `scripts/seed-dev-galaxy.js` exists precisely
so a UI change can be reviewed without anyone's real intel.

### Production game API: agreed, with boundaries

The game has a REST API (`/api/v1/*`, OpenAPI 3.0.1 spec at `/swagger/v1/swagger.json`).
Programmatic use of production **has been agreed** with the game's administration — this
resolves what issue #24 was blocking on — under conditions that bind exactly like the rate
limit above:

- **One global budget for the whole hub combined.** Every member, every feature, one
  bucket: `GAME_API_MAX_PER_SECOND`, default 5, enforced by `apiGate` in `server.js`. The
  env var exists for deployment, not for tuning — raising it requires the administrator's
  **renewed consent, not a code review**. Be precise about what this caps: the `/api/v1`
  stream, globally. It is *not* a promise that the hub overall never exceeds 5 req/s — the
  scraper gate is per-member and marker-only, so scraped traffic, API traffic and page
  loads combined can pass 5/s with several active members. That is pre-existing behaviour,
  unchanged by the agreement.
- **A member's own session through the proxy is the only sanctioned path.** Requests are
  same-origin `/api/v1/...` from a logged-in member's browser; the proxy forwards their
  own game session and counts the request against the budget on the way. The server never
  calls the API itself — it has no game session.
- **No dedicated bot or test accounts.** The Discord bot has no session and stays on the
  local formulas permanently.

Server-side scripts still must not accept a production base URL.
`scripts/collect-travel-fixtures.js` checks `--base` against an allowlist and refuses
everything else. Keep it that way — the agreement covers the member-session path, nothing
else.

### Do not invent translations

`public/js/utils/scrape-report.js` holds the label synonyms the scrapers match on. Only
phrasings **confirmed from the game** belong there. A guessed translation does not fail —
it matches the wrong cell and writes wrong data silently, which is the exact failure mode
the scrape reporter was built to catch.

### Never edit a fixture to make a test pass

`src/utils/travel-fixtures.json` and `battle-fixtures.json` are recorded observations. If
the code disagrees with them, the code is wrong or the recording needs re-taking from the
game. Changing the expected number to match the output destroys the only ground truth
there is.

---

## 2. What you need to know before editing

### There are two JavaScript realms, always

This surprises everyone once.

```
Wrapper.html (the dashboard document)        ← realm 1
  └─ js/ui/dashboard.js → archives.js → utils/*

<iframe> proxied game page                   ← realm 2
  └─ src/proxy.js injects js/main.js
       └─ js/core/spy.js, js/scrapers/*  → utils/*
```

Both are the hub's own origin, and **both load the same modules as separate instances**.
Module-level state is therefore per document, not per user. Anything that must hold across
the whole tab — a rate-limit window, a lock, a counter — has to live in `localStorage`,
on the server, or somewhere else both realms can see.

The rate limiter got this wrong for a while and quietly allowed double the agreed traffic.

### `public/js/utils/*` are dual-runtime modules

Files there with **no `import`/`export` statements** are loaded twice over:

```js
// Node:    const m = require('../../public/js/utils/travel-model.js');
// Browser: import '../utils/travel-model.js';  then globalThis.AWTravelModel
```

A UMD wrapper publishes the API on `globalThis` for the browser and on `module.exports`
for Node. That is what lets the server, the Discord bot, the dashboard and the tests all
use one copy of a formula.

Current dual-runtime modules and their globals:

| File | Global | What it owns |
|---|---|---|
| `battle-model.js` | `AWBattleModel` | Battle outcome, CV, win chance |
| `travel-model.js` | `AWTravelModel` | Travel time |
| `vision-model.js` | `AWVision` | Who can see which system |
| `parse-number.js` | `AWNumber` | Locale-aware number parsing |
| `scrape-report.js` | `AWScrape` | Scraper failure reporting, label synonyms |
| `game-rate-limit.js` | `AWGameRate` | The 5/s gate |
| `aw-api.js` | `AWApi` | Game REST API client (`/api/v1`); every call rides `AWGameRate.gameFetch` |

**Do not "modernise" these to ESM.** Adding an `import` breaks Node; adding `export`
breaks the tests. Files in `public/js/ui/` and `public/js/scrapers/` are plain ESM and are
browser-only.

### The scrapers are the fragile part

They read the game's HTML. When the game changes its markup, or a member plays with a
different interface language, parsing can return empty or shifted values.

Address elements structurally — by header text, by `href` shape, by element id — not by
column position. `public/js/scrapers/system-parser.js` used to read ships by index, and an
inserted column silently shifted every value.

`AWScrape` exists so a scraper that finds nothing says so loudly instead of writing
zeroes.

### Where things live

| Path | What lives there |
|---|---|
| `server.js` | Middleware order, mounts, the proxy. Read it top to bottom before changing it |
| `src/database.js` | Schema and additive migrations. Append; never reorder |
| `src/proxy.js` | Reverse proxy to the game; injects `main.js`; strips the hub session cookie |
| `src/routes/*.js` | Everything under `/hub-api`, one file per domain |
| `src/utils/*.js` | Server-side logic and **all test suites** |
| `public/js/utils/` | Dual-runtime shared modules (above) |
| `public/js/core/` | Injected into the game page: `spy.js`, `page-injections.js` |
| `public/js/scrapers/` | Page parsers |
| `public/js/ui/` | Dashboard panels |
| `public/components/` | Panel markup, fetched on demand |
| `scripts/` | Operator tools. Not run automatically, not part of the app |

---

## 3. Tests

```bash
npm test              # everything
npm test -- battle    # only files whose name contains "battle"
```

`src/utils/run-tests.js` **discovers** `src/utils/*.test.js`. Adding a suite is one new
file — do not add it to `package.json`, and do not add a list anywhere.

No test framework and no mocking library. Each suite is a plain script with an `ok(name,
condition, detail)` helper that prints a line and counts failures, then exits non-zero.
Follow the shape of the file next to yours.

### Two things about these tests that will confuse you

**Some assertions scan source code, not behaviour.** They check that the rate limiter is
actually called, that no browser file fetches the game with a bare `fetch()`, that a rule
exists in exactly one place. When one of those fails, the code is wrong — do not relax the
assertion. Strip comments before scanning, or a comment explaining what a rule *used to be*
will trip the assertion checking that it is gone.

**Rate-limit tests use real timers on purpose.** A rate limit measured with fake time
proves nothing about a rate limit. Those suites take a few seconds. Leave them alone.

---

## 4. Working agreement

The rule that makes parallel work possible:

> **One topic per pull request, and PRs must merge in any order with zero conflicts.**

The repository owner should never have to resolve a conflict. This has held across every
recent PR, and it holds because branches are given **disjoint file sets** rather than
because merges happen to be lucky.

### Before you start

Claim a file set. If two pieces of work need the same file, either fold them into one PR
or change the design so they do not. Both have been done here:

- `run-tests.js` discovers suites so two branches adding tests do not collide in
  `package.json`
- a value is computed server-side rather than in a shared client file both branches import

### Branch names

`feat/…` new capability · `fix/…` something is wrong · `chore/…` housekeeping ·
`docs/…` documentation.

### Prove it before opening the PR

```bash
# 1. disjoint file sets
comm -12 <(git diff --name-only origin/main..branch-a | sort) \
         <(git diff --name-only origin/main..branch-b | sort)

# 2. every merge order is clean and lands the same tree
for order in "a b" "b a"; do
    git checkout -B merge-proof origin/main
    for br in $order; do git merge --no-edit "$br" || echo "CONFLICT"; done
    git rev-parse HEAD^{tree}
done

# 3. the suite passes on the merged state, not just on each branch
npm test
```

### Where an agent stops

Opening the pull request is the last step an agent takes. After that the PR belongs to a
human: they review it, they approve it, they merge it. An agent that has just pushed a
green branch is finished — it says so and waits. See "`main` is human-gated, always"
above.

### Commits and PRs

Explain **why**, not what — the diff already says what. Name the failure the change
prevents. If a bug was found while writing the fix, say so; if something is unverified,
say that too, in the PR body rather than leaving the reviewer to discover it.

---

## 5. Running it locally

```bash
npm install
cp .env.example .env
COOKIE_SECURE=false npm run dev
```

`COOKIE_SECURE=false` matters over plain HTTP — otherwise the session cookie is never sent
back and every request looks logged out.

A fresh database prints a one-time `admin` password to the console. It is not stored
anywhere else.

### Reviewing a UI change without live data

```bash
node scripts/seed-dev-galaxy.js
```

Fills the database with a synthetic galaxy — invented names, deterministic layout, no real
player. Use it instead of running a scan against the live game.

### What must not be committed

`awt.db`, `sessions.db`, `.env`, `.session-secret`, `config.json` — all gitignored. Any new
state file on disk needs a gitignore entry **and** a note in the PR, because whoever runs
the production server may be backing files up by name.

---

## 6. Quick checklist

- [ ] Did I touch a file another open PR owns?
- [ ] Does anything I added need to hold across both JS realms?
- [ ] Did I add an `import`/`export` to a file in `public/js/utils/`?
- [ ] Does any new request to the game go through `gameFetch`?
- [ ] Am I committing captured game data, or a translation I guessed?
- [ ] Does a test scan source for the thing I just changed?
- [ ] Does `npm test` pass on the merged state, not only on my branch?
- [ ] Am I about to merge this myself? A human approves and merges to `main`.
