# Alliances & System Search (Phase 2 of Game API Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up `Alliance/search` and `SolarSystem/search` as manual, member-triggered lookups — a hub-DB-backed search box for each, with an explicit "search the game directly" fallback when the local database has nothing, never an automatic background call.

**Architecture:** Alliance search is entirely new (no DB-backed alliance search existed before this plan) and gets its own small route/repo function/upsert, kept deliberately separate from the three existing alliance upserts (a fourth distinct pair, not a merge — see Global Constraints). System search needs almost nothing new server-side: `SolarSystem/search` returns the exact same shape as the already-integrated bulk `SolarSystem` list, so its live-fallback path reuses Plan 1's existing `/sync/galaxy` route and `upsertSystemFull` function verbatim.

**Tech Stack:** Node.js, Express, better-sqlite3, plain browser JS (no framework).

**Spec:** `docs/superpowers/specs/2026-08-29-game-api-integration-design.md` (section "2. Alliances & system search")

## Global Constraints

- **No behavior change for existing callers.** Every schema/function change is additive.
  The three existing alliance upserts (`upsertAllianceBasic`, `upsertAllianceTagOnly`,
  `upsertAllianceFull`) do not need any modification — confirmed by reading their SQL:
  none of their `INSERT`/`ON CONFLICT SET` clauses mention `full_name` or `member_count`
  at all, so they can never touch those columns on an existing row (unlike the systems bug
  from Plan 1, where the shared `upsertSystemFull` function's `ON CONFLICT` clause DID
  mention the new columns unconditionally, so its other scrape-only callers nulled them
  out). This is different — do not "fix" anything here that isn't broken; verify this
  claim yourself in Task 2 rather than assuming it.
- **A fourth, distinct alliance upsert — not a merge.** `upsertAllianceFromApiSearch` is
  new, alongside the existing three. It is NOT the same as any of them (different column
  set, different source). Do not attempt to consolidate.
- **Manual only — no automatic API calls.** The live-search fallback (both alliance and
  system) fires ONLY on an explicit click, never automatically when local results are
  empty (a user typing letter-by-letter would otherwise trigger repeated API calls while
  still typing). Show a distinct "Search the game directly" action in the results area
  instead, which the member clicks deliberately.
- **System search needs no new server-side route.** `SolarSystem/search`'s response shape
  is identical to the already-integrated bulk `SolarSystem` list (`{id, name, fullName,
  info, populationLevel, x, y}`) — reuse Plan 1's existing `/sync/galaxy` route and
  `systemsRepo.upsertSystemFull` unchanged. Do not add a new system-search sync route.

## File Structure

- Modify: `src/database.js` — add `alliances.full_name`/`member_count` columns.
- Modify: `src/repositories/alliances.js` — add `searchAlliancesByTagOrName`,
  `upsertAllianceFromApiSearch`.
- Modify: `src/repositories/alliances.test.js` — cover both new functions.
- Modify: `public/js/utils/aw-api.js` — add `searchAlliances`, `searchSolarSystems`.
- Modify: `public/js/utils/aw-api.test.js` — cover both.
- Modify: `src/routes/search.js` — add `GET /search/alliance`.
- Modify: `src/routes/sync.js` — add `POST /sync/alliance-search`.
- Modify: `public/Wrapper.html` — add the alliance search box.
- Modify: `public/js/ui/dashboard.js` — wire its input listener.
- Modify: `public/js/ui/search.js` — render alliance results; add the "search live"
  fallback for both alliance and system search.

---

### Task 1: Schema — new alliance columns

**Files:**
- Modify: `src/database.js` (right after the `alliances` table's closing `` `); ``)

**Interfaces:**
- Produces: `alliances.full_name` (TEXT), `alliances.member_count` (INTEGER) — both
  nullable, consumed by Task 2.

- [ ] **Step 1: Find the exact insertion point and add the migration**

Find the `CREATE TABLE IF NOT EXISTS alliances (...)` block in `src/database.js` (it
currently ends with `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP\n)` followed by `` `); ``).
Add this block immediately after that closing `` `); ``:

```js
    addColumn('alliances', 'full_name', 'TEXT');
    addColumn('alliances', 'member_count', 'INTEGER');
```

- [ ] **Step 2: Verify the migration runs cleanly**

Run: `AWT_DB_PATH=/tmp/alliance-migration-check.db node -e "require('./src/database.js')"`
Expected: two `[DB] Added <column> column to alliances table.` log lines, no errors. Do NOT
run this against the real `awt.db`.

- [ ] **Step 3: Commit**

```bash
git add src/database.js
git commit -m "Add alliances full_name and member_count columns"
```

---

### Task 2: Extend `src/repositories/alliances.js`

**Files:**
- Modify: `src/repositories/alliances.js`
- Modify: `src/repositories/alliances.test.js`

**Interfaces:**
- Consumes: the 2 new columns from Task 1.
- Produces: `searchAlliancesByTagOrName(likeTerm, exactTerm)` (new — returns
  `[{id, name, tag, full_name, member_count}]`), `upsertAllianceFromApiSearch(id, name,
  tag, fullName, memberCount)` (new). Both consumed by Task 4.

- [ ] **Step 1: Verify the "no fix needed" claim from Global Constraints**

Before writing anything, read the current `upsertAllianceBasicStmt`, `upsertAllianceTagOnlyStmt`,
and `upsertAllianceFullStmt` SQL in `src/repositories/alliances.js` and confirm none of
their column lists or `ON CONFLICT ... SET` clauses mention `full_name` or `member_count`.
If you find one that does, STOP and report it as a blocker — the plan's Global Constraints
claim would be wrong and needs a ruling before proceeding, not a silent fix.

- [ ] **Step 2: Write the failing test**

Add to `src/repositories/alliances.test.js` (check its existing style first — match its
`ok()` helper / `AWT_DB_PATH` setup pattern exactly, same as every other repository test in
this project):

```js
alliances.upsertAllianceFromApiSearch(501, 'Star Raiders', 'SR', 'The Star Raiders Collective', 24);
const found = alliances.searchAlliancesByTagOrName('%Star%', '501');
ok('search by name substring finds the alliance', found.length === 1 && found[0].id === 501, found);
ok('full_name is returned', found[0].full_name === 'The Star Raiders Collective', found[0]);
ok('member_count is returned', found[0].member_count === 24, found[0]);

const byTag = alliances.searchAlliancesByTagOrName('%SR%', '999999');
ok('search by tag substring also finds it', byTag.some(a => a.id === 501), byTag);

const byExactId = alliances.searchAlliancesByTagOrName('%nomatch%', '501');
ok('an exact id match works even when the LIKE term matches nothing', byExactId.some(a => a.id === 501), byExactId);

alliances.upsertAllianceFromApiSearch(501, 'Star Raiders', 'SR', 'Updated Full Name', 30);
const updated = alliances.searchAlliancesByTagOrName('%Star%', '501');
ok('calling it again on the same id updates in place, not a duplicate row', updated.length === 1 && updated[0].full_name === 'Updated Full Name' && updated[0].member_count === 30, updated);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node src/repositories/alliances.test.js`
Expected: FAIL — `upsertAllianceFromApiSearch is not a function`.

- [ ] **Step 4: Implement**

Add these two functions to `src/repositories/alliances.js`, near the other alliance
upsert/search functions (match the file's existing section-comment style, e.g. under
`// --- alliances: read ---` for the search function and `// --- alliances: write ---`
for the upsert):

```js
const searchAlliancesByTagOrNameStmt = db.prepare(`
    SELECT id, name, tag, full_name, member_count
    FROM alliances
    WHERE name LIKE ? OR tag LIKE ? OR CAST(id AS TEXT) = ?
    LIMIT 20
`);
function searchAlliancesByTagOrName(likeTerm, exactTerm) {
    return searchAlliancesByTagOrNameStmt.all(likeTerm, likeTerm, exactTerm);
}
```

```js
// A fourth, distinct alliance upsert — sourced from Alliance/search, not a scrape. NOT the
// same as upsertAllianceBasic/upsertAllianceTagOnly/upsertAllianceFull: this is the only
// one that writes full_name/member_count, and it does not touch leader_id/ranking/points
// (Alliance/search's response has no such fields).
const upsertAllianceFromApiSearchStmt = db.prepare(`
    INSERT INTO alliances (id, name, tag, full_name, member_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        tag=excluded.tag,
        full_name=excluded.full_name,
        member_count=excluded.member_count,
        updated_at=CURRENT_TIMESTAMP
`);
function upsertAllianceFromApiSearch(id, name, tag, fullName, memberCount) {
    upsertAllianceFromApiSearchStmt.run(id, name, tag, fullName, memberCount);
}
```

- [ ] **Step 5: Update `module.exports`**

Add `searchAlliancesByTagOrName, upsertAllianceFromApiSearch,` to the existing
`module.exports` list at the bottom of the file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node src/repositories/alliances.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/repositories/alliances.js src/repositories/alliances.test.js
git commit -m "Add alliance search and API-search upsert to the alliances repository"
```

---

### Task 3: Extend `public/js/utils/aw-api.js`

**Files:**
- Modify: `public/js/utils/aw-api.js`
- Modify: `src/utils/aw-api.test.js` (this is the REAL location of this file's test —
  confirmed during Plan 1; do not use `public/js/utils/aw-api.test.js`, which does not
  exist)

**Interfaces:**
- Produces: `searchAlliances({q, limit})` (new, `GET /api/v1/Alliance/search`),
  `searchSolarSystems({q, limit})` (new, `GET /api/v1/SolarSystem/search`). Both resolve
  with the standard `{ok, data}`/`{ok:false, reason}` shape every other function in this
  file uses. Both consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Read the existing fake-network harness at the top of `src/utils/aw-api.test.js` first (it
has a `calls` array populated with `{url, init}` objects, and a shared `nextResponse`
variable that must be set before each call that expects a successful JSON response — see
Plan 1's Task 4 for why `nextResponse` matters). Add, following that exact harness:

```js
console.log('\n── searchAlliances / searchSolarSystems: query strings ' + '─'.repeat(20));
nextResponse = jsonRes([]);
calls.length = 0;
const allianceRes = await AWApi.searchAlliances({ q: 'Star', limit: 10 });
ok('searchAlliances resolves ok', allianceRes.ok === true, allianceRes);
ok('the request path is Alliance/search with q and limit', /\/api\/v1\/Alliance\/search\?/.test(calls[0].url)
    && /q=Star/.test(calls[0].url) && /limit=10/.test(calls[0].url), calls[0].url);

nextResponse = jsonRes([]);
calls.length = 0;
const systemRes = await AWApi.searchSolarSystems({ q: 'Rana', limit: 5 });
ok('searchSolarSystems resolves ok', systemRes.ok === true, systemRes);
ok('the request path is SolarSystem/search with q and limit', /\/api\/v1\/SolarSystem\/search\?/.test(calls[0].url)
    && /q=Rana/.test(calls[0].url) && /limit=5/.test(calls[0].url), calls[0].url);
```

(If the existing harness's JSON-response helper has a different name than `jsonRes`, use
whatever name the file already uses — read it first, don't guess.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node src/utils/aw-api.test.js`
Expected: FAIL — `AWApi.searchAlliances is not a function`.

- [ ] **Step 3: Implement**

Add immediately after `getMapSectors` (added in Plan 1, right after `getSystemPlanets`):

```js
    // Alliance name/tag/id search: [{id, name, tag, fullName, memberCount, pointsScored, rank}].
    function searchAlliances({ q, limit } = {}) {
        return requestJson('/api/v1/Alliance/search' + query({ q, limit }));
    }

    // System name/id search: [{id, name, fullName, info, populationLevel, x, y}] — same
    // shape as getSolarSystems(), just filtered by q.
    function searchSolarSystems({ q, limit } = {}) {
        return requestJson('/api/v1/SolarSystem/search' + query({ q, limit }));
    }
```

- [ ] **Step 4: Update the exported functions list**

Before:
```js
    return {
        getSolarSystems, getSolarSystem, getSystemPlanets, getMapSectors,
        getTravelTime, searchBattleReports, putOrderGeometry,
        mapPlanetsToSyncPayload,
        _setFetch,
    };
```
After:
```js
    return {
        getSolarSystems, getSolarSystem, getSystemPlanets, getMapSectors,
        getTravelTime, searchBattleReports, putOrderGeometry,
        searchAlliances, searchSolarSystems,
        mapPlanetsToSyncPayload,
        _setFetch,
    };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node src/utils/aw-api.test.js`
Expected: all `ok` lines, `0` failures.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add public/js/utils/aw-api.js src/utils/aw-api.test.js
git commit -m "Add searchAlliances and searchSolarSystems to the game API client"
```

---

### Task 4: New routes — `GET /search/alliance` and `POST /sync/alliance-search`

**Files:**
- Modify: `src/routes/search.js`
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `alliancesRepo.searchAlliancesByTagOrName(likeTerm, exactTerm)`,
  `alliancesRepo.upsertAllianceFromApiSearch(id, name, tag, fullName, memberCount)` from
  Task 2.
- Produces: `GET /hub-api/search/alliance?q=` (returns `{success, results}`), `POST
  /hub-api/sync/alliance-search` (accepts `{alliances: [{id, name, tag, full_name,
  member_count}]}`, returns `{success, count}`). Both consumed by Task 5.

- [ ] **Step 1: Add `GET /search/alliance`**

In `src/routes/search.js`, add `const alliancesRepo = require('../repositories/alliances');`
alongside the existing `plansRepo`/`systemsRepo`/`playersRepo` requires. Add this route
right after the existing `/search/system` route (mirroring it exactly):

```js
// Search Alliances by Name, Tag, or Exact ID
router.get('/search/alliance', requireAuth, (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ success: true, results: [] });

    try {
        const searchTerm = `%${q}%`;
        const results = alliancesRepo.searchAlliancesByTagOrName(searchTerm, q);
        res.json({ success: true, results });
    } catch (err) {
        console.error("[DB Error] Alliance search failed:", err);
        res.status(500).json({ error: 'Search failed' });
    }
});
```

- [ ] **Step 2: Add `POST /sync/alliance-search`**

In `src/routes/sync.js`, this file already has `const alliancesRepo = require('../repositories/alliances');`
(confirmed present from earlier domains) — no new require needed. Add this new route right
after the existing `/sync/alliance` route's closing `});`:

```js
// --- ALLIANCE SEARCH RESULT RECEIVER ---
// API-search-sourced, distinct from /sync/alliance's scrape shape above (no leader_id,
// ranking, points, or members[] — Alliance/search doesn't return any of those). Batch:
// the member's browser can send everything Alliance/search returned in one call.
router.post('/sync/alliance-search', requireAuth, (req, res) => {
    const { alliances } = req.body;
    if (!Array.isArray(alliances) || alliances.length === 0) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    let stored = 0;
    for (const a of alliances) {
        if (!Number.isInteger(a.id) || a.id <= 0) continue;
        alliancesRepo.upsertAllianceFromApiSearch(
            a.id,
            a.name == null ? '' : String(a.name),
            a.tag == null ? null : String(a.tag),
            typeof a.full_name === 'string' ? a.full_name : null,
            Number.isInteger(a.member_count) ? a.member_count : null
        );
        stored++;
    }
    res.json({ success: true, count: stored });
});
```

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass — in particular `utils/request-hygiene.test.js` (the `/sync/*`
`requireAuth`-guard scanner) must still pass, since both new routes correctly include
`requireAuth`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/search.js src/routes/sync.js
git commit -m "Add GET /search/alliance and POST /sync/alliance-search"
```

---

### Task 5: UI — alliance search box, rendering, and the manual "search live" fallback

**Files:**
- Modify: `public/Wrapper.html`
- Modify: `public/js/ui/dashboard.js`
- Modify: `public/js/ui/search.js`

**Interfaces:**
- Consumes: `GET /hub-api/search/alliance` (Task 4), `POST /hub-api/sync/alliance-search`
  (Task 4), `GET /hub-api/sync/galaxy` — actually `POST /hub-api/sync/galaxy` (Plan 1,
  existing), `AWApi.searchAlliances`/`searchSolarSystems` (Task 3).

This task has no automated test — `search.js`/`dashboard.js`/`Wrapper.html` are DOM/browser
UI code with no test file today, consistent with `galaxy-map.js` in Plan 1. Verify per Step
6 below.

- [ ] **Step 1: Add the alliance search box to `Wrapper.html`**

Before (`public/Wrapper.html:189-194`):
```html
                <div class="px-4 relative">
                    <input type="text" id="search-system-input" placeholder="System Name or ID..." class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none pe-8">
                    <i class="fa-solid fa-magnifying-glass absolute right-7 top-2.5 text-muted-foreground text-sm pointer-events-none"></i>
                    <div id="search-system-results" class="mt-2 flex flex-col gap-1 max-h-40 overflow-y-auto empty:hidden"></div>
                </div>
            </div>
```
After (add the alliance box right after the system box, inside the same outer `div`):
```html
                <div class="px-4 relative">
                    <input type="text" id="search-system-input" placeholder="System Name or ID..." class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none pe-8">
                    <i class="fa-solid fa-magnifying-glass absolute right-7 top-2.5 text-muted-foreground text-sm pointer-events-none"></i>
                    <div id="search-system-results" class="mt-2 flex flex-col gap-1 max-h-40 overflow-y-auto empty:hidden"></div>
                </div>
                <div class="px-4 mt-3 relative">
                    <input type="text" id="search-alliance-input" placeholder="Alliance Name or Tag..." class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none pe-8">
                    <i class="fa-solid fa-magnifying-glass absolute right-7 top-2.5 text-muted-foreground text-sm pointer-events-none"></i>
                    <div id="search-alliance-results" class="mt-2 flex flex-col gap-1 max-h-40 overflow-y-auto empty:hidden"></div>
                </div>
            </div>
```

- [ ] **Step 2: Wire the input listener in `dashboard.js`**

Before (`public/js/ui/dashboard.js:40-41`):
```js
    document.getElementById('search-player-input')?.addEventListener('input', () => handleSearchInput('player'));
    document.getElementById('search-system-input')?.addEventListener('input', () => handleSearchInput('system'));
```
After:
```js
    document.getElementById('search-player-input')?.addEventListener('input', () => handleSearchInput('player'));
    document.getElementById('search-system-input')?.addEventListener('input', () => handleSearchInput('system'));
    document.getElementById('search-alliance-input')?.addEventListener('input', () => handleSearchInput('alliance'));
```

- [ ] **Step 3: Render alliance results in `search.js`**

Before (`public/js/ui/search.js:59-74`, the `else if (type === 'system')` branch and its
closing brace before the `catch`):
```js
        } else if (type === 'system') {
            resultsContainer.innerHTML = data.results.map(s => `
                <button data-path="/Game/Map/SolarSystem/${s.id}" class="btn-search-system text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${esc(s.name)}</span>
                    <span class="text-s text-muted-foreground font-mono">#${s.id} (${s.x}/${s.y})</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-system').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const path = e.currentTarget.getAttribute('data-path');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    navToIframe(path);
                });
            });
        }
    } catch (err) { resultsContainer.innerHTML = '<div class="text-s text-red-500 text-center py-2">Error.</div>'; }
```
After (add the `alliance` branch, keep everything else identical):
```js
        } else if (type === 'system') {
            resultsContainer.innerHTML = data.results.map(s => `
                <button data-path="/Game/Map/SolarSystem/${s.id}" class="btn-search-system text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${esc(s.name)}</span>
                    <span class="text-s text-muted-foreground font-mono">#${s.id} (${s.x}/${s.y})</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-system').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const path = e.currentTarget.getAttribute('data-path');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    navToIframe(path);
                });
            });
        } else if (type === 'alliance') {
            resultsContainer.innerHTML = data.results.map(a => `
                <button data-path="/Game/Alliance/Profile/${a.id}" class="btn-search-alliance text-left w-full bg-card border border-border hover:bg-accent hover:text-accent-foreground rounded-md p-2 text-s transition-colors flex justify-between items-center shadow-sm">
                    <span class="truncate font-medium">${a.tag ? `[${esc(a.tag)}] ` : ''}${esc(a.name || `#${a.id}`)}</span>
                    <span class="text-s text-muted-foreground font-mono">${a.member_count != null ? `${a.member_count} members` : `#${a.id}`}</span>
                </button>`).join('');

            resultsContainer.querySelectorAll('.btn-search-alliance').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const path = e.currentTarget.getAttribute('data-path');
                    input.value = '';
                    resultsContainer.innerHTML = '';
                    navToIframe(path);
                });
            });
        }
    } catch (err) { resultsContainer.innerHTML = '<div class="text-s text-red-500 text-center py-2">Error.</div>'; }
```

- [ ] **Step 4: Add the manual "search live via API" fallback**

Before (`public/js/ui/search.js:30-33`, the empty-results branch):
```js
        if (!data.success || data.results.length === 0) {
            resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2 bg-card rounded border border-border">Not found.</div>';
            return;
        }
```
After — only alliance and system get the live-search button (player search already covers
former-round names via `searchFormerNamesWithCurrentPlayer`, so it has no API fallback in
this plan):
```js
        if (!data.success || data.results.length === 0) {
            if (type === 'alliance' || type === 'system') {
                resultsContainer.innerHTML = `
                    <div class="text-s text-muted-foreground text-center py-2 bg-card rounded border border-border">
                        Not found in the hub's records.
                        <button id="btn-search-live-${type}" class="block w-full mt-2 h-7 rounded border border-input bg-zinc-950 text-xs text-foreground hover:bg-accent transition-colors">
                            <i class="fa-solid fa-cloud-arrow-down mr-1"></i>Search the game directly
                        </button>
                    </div>`;
                document.getElementById(`btn-search-live-${type}`)?.addEventListener('click', () => searchLiveViaApi(type, q, resultsContainer));
            } else {
                resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2 bg-card rounded border border-border">Not found.</div>';
            }
            return;
        }
```

Add this new function anywhere in `search.js` (e.g. right after `executeSearch`, before
`navToIframe`):
```js
// A manual, member-triggered escape hatch: the hub's own DB found nothing, so ask the
// game's REST API directly, sync whatever it finds into the hub's DB through the existing
// sync routes, then re-run the same DB-backed search so the result renders through the
// normal path. Never fires automatically — only on this explicit click.
async function searchLiveViaApi(type, q, resultsContainer) {
    resultsContainer.innerHTML = '<div class="text-s text-muted-foreground text-center py-2"><i class="fa-solid fa-circle-notch fa-spin"></i> Asking the game…</div>';
    try {
        if (type === 'alliance') {
            const res = await AWApi.searchAlliances({ q, limit: 20 });
            if (!res.ok) {
                resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">${res.reason === 'session' ? 'Log into the game first, then try again.' : 'The game did not answer.'}</div>`;
                return;
            }
            const alliances = (Array.isArray(res.data) ? res.data : []).map(a => ({
                id: a.id, name: a.name, tag: a.tag, full_name: a.fullName, member_count: a.memberCount,
            }));
            if (alliances.length) {
                await fetch('/hub-api/sync/alliance-search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ alliances }),
                });
            }
        } else if (type === 'system') {
            const res = await AWApi.searchSolarSystems({ q, limit: 20 });
            if (!res.ok) {
                resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">${res.reason === 'session' ? 'Log into the game first, then try again.' : 'The game did not answer.'}</div>`;
                return;
            }
            const systems = (Array.isArray(res.data) ? res.data : [])
                .filter(s => s && s.x != null && s.y != null)
                .map(s => ({
                    id: s.id, name: s.name, x: s.x, y: s.y,
                    full_name: typeof s.fullName === 'string' ? s.fullName : null,
                    info: typeof s.info === 'string' ? s.info : null,
                    population_level: Number.isInteger(s.populationLevel) ? s.populationLevel : null,
                }));
            if (systems.length) {
                await fetch('/hub-api/sync/galaxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ systems }),
                });
            }
        }
        // Re-run the same DB-backed search now that the sync (if anything was found) landed.
        await executeSearch(type);
    } catch (err) {
        resultsContainer.innerHTML = `<div class="text-s text-red-500 text-center py-2">Live search failed: ${err.message}</div>`;
    }
}
```

`search.js` is an ES module (it already has `import`/`export` statements) but `aw-api.js`
is loaded as a plain side-effect script that attaches to `globalThis.AWApi`, not as an ES
export — confirmed by reading `galaxy-map.js`'s top of file, which does exactly this:
```js
import '../utils/game-rate-limit.js'; // side-effect import: the shared 5/s gate AWApi rides
import '../utils/aw-api.js';         // side-effect import: the game API client, gate included
...
const AWApi = globalThis.AWApi;
```
Add the same two side-effect imports and the same `const AWApi = globalThis.AWApi;` line
near the top of `search.js`, alongside its existing `import { loadPlayerIntel } from
'./player-intel.js';` / `import { esc } from '../utils/escape.js';` lines. Then reference
`AWApi.searchAlliances`/`AWApi.searchSolarSystems` directly inside `searchLiveViaApi`, same
as `galaxy-map.js` does for its own `AWApi.*` calls.

- [ ] **Step 5: Manual verification of file structure**

Run: `node -c public/js/ui/search.js` (or the project's equivalent syntax-check step) and
confirm no syntax errors. Confirm `public/Wrapper.html` is still well-formed by eye (matched
tags, no orphaned `div`).

- [ ] **Step 6: Manual end-to-end verification (deferred, same as Plan 1)**

This requires a real logged-in game session, not available today — deferred to when a
member is logged in. When available: (a) search an alliance/system already in the hub's DB
— confirm it renders and clicking navigates correctly; (b) search a name genuinely not in
the hub's DB — confirm the "Search the game directly" button appears, and clicking it syncs
and then shows the result; (c) confirm nothing fires automatically while typing (watch the
network tab — no `/api/v1/Alliance/search` or `/api/v1/SolarSystem/search` request until the
button is clicked).

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass (this task touches no server-tested code directly, confirms
Tasks 1-4 are still intact).

- [ ] **Step 8: Commit**

```bash
git add public/Wrapper.html public/js/ui/dashboard.js public/js/ui/search.js
git commit -m "Add alliance search UI and manual live-search fallback for alliance/system"
```

---

## Self-Review Notes

- **Spec coverage:** spec section "2. Alliances & system search" is fully covered: manual
  lookup only (Task 5's explicit-click design, no automatic fallback), `Alliance/search`
  wired end-to-end (Tasks 2-5), `SolarSystem/search` wired via reuse of Plan 1's existing
  `/sync/galaxy`/`upsertSystemFull` (Task 5, no new sync route per Global Constraints), the
  `alliances.full_name`/`member_count` columns (Task 1).
- **Type consistency check:** `upsertAllianceFromApiSearch(id, name, tag, fullName,
  memberCount)`'s param order matches Task 4's route call
  (`upsertAllianceFromApiSearch(a.id, ..., ..., ..., ...)` in that exact order).
  `searchAlliancesByTagOrName(likeTerm, exactTerm)` matches Task 4's route call
  (`searchAlliancesByTagOrName(searchTerm, q)`). `searchAlliances({q, limit})`/
  `searchSolarSystems({q, limit})` match Task 5's call sites exactly.
- **The "no existing upsert needs a COALESCE fix" claim is verification, not assertion** —
  Task 2 Step 1 requires the implementer to actually check this before proceeding, not just
  trust the plan text, mirroring the discipline Plan 1's final review demanded after the
  fact.
