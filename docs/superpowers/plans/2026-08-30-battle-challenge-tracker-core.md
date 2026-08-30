# Battle Challenge Tracker — Core Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CV/population-kill leaderboard from existing `battle_reports` data, a distinct-identity Discord posting path for battle content, and three Discord commands (`!mortal`, `!mortalday`, `!mortalweek`) plus an automated twice-daily leaderboard post.

**Architecture:** A new read-only repository (`battlePoints.js`) computes both leaderboards straight from `battle_reports`, applying admin-configurable ratios and exclusion rules as SQL `WHERE` filters — no new tables, no mutation of existing data. A small extension to the existing stateless Discord REST poster (`discord-post.js`) adds an optional second bot identity for battle posts, falling back to the main bot's token exactly like every other optional integration in this codebase. Three new `!mortal*` commands reuse the existing `handleMessage` dispatch chain in `discord_bot.js`. The automated post piggybacks on the existing `/sync/battle-reports` route (this app has no server-side scheduler anywhere — every periodic-feeling behavior here is actually driven by client sync traffic).

**Tech Stack:** Node.js, Express, better-sqlite3, discord.js (REST client only, no new gateway connection).

**Spec:** `docs/superpowers/specs/2026-08-30-battle-challenge-tracker-design.md` (sections 1, 2's exclusion logic, 4, 5)

## Global Constraints

- Never duplicate a mapper/query pattern that already exists — the leaderboard reads exclusively from `battle_reports`; it does not touch `news_events` (that's Plan 2's job, layered on top of `getCvLeaderboard`/`getPopLeaderboard` later).
- CV points = opponent's `lost_cv` ÷ `battle_points_cv_ratio` (default `1000`). Population points = attacker-credited `killed_population` ÷ `battle_points_pop_ratio` (default `100`). Both ratios and the exclusion tag list live in `app_settings`, read via `src/repositories/settings.js`'s existing `getSetting`/`setSetting` — never hardcoded.
- Exclusions are query-time filters only: friendly fire (`att_alliance_tag` case-insensitively equals `def_alliance_tag`, both non-null) and any battle where either side's alliance tag is in the comma-separated `battle_points_excluded_alliance_tags` setting. Never delete or flag `battle_reports` rows themselves.
- The second Discord bot identity is **REST-only** (`discord.js`'s `REST` client, same as the existing `postEmbed` in `src/utils/discord-post.js`) — no new gateway `Client`, no new login flow. `BATTLE_DISCORD_TOKEN` unset must fall back to `DISCORD_TOKEN` silently; both unset must no-op with a reason, never throw.
- Test files use the project's plain-Node harness (`ok(desc, cond)` pattern, no test framework), a fresh temp SQLite DB per file via `process.env.AWT_DB_PATH` set before requiring `../database`, and are discovered automatically by `src/utils/run-tests.js` (any `*.test.js` anywhere under `src/`) — no registration needed anywhere.
- Never make a real network call to Discord in a test. Only the "no token configured" no-op branch of `postBattleEmbed` is unit-testable offline; anything requiring an actual token+channel is out of scope for automated tests here.

---

### Task 1: `battlePoints` repository — leaderboard queries

**Files:**
- Create: `src/repositories/battlePoints.js`
- Test: `src/repositories/battlePoints.test.js`

**Interfaces:**
- Consumes: `db` from `../database` (already initialized with `battle_reports`, `app_settings` tables); `getSetting`/`setSetting` from `./settings.js` (existing: `getSetting(key)` returns `{ value }` or `undefined`; `setSetting(key, value)` upserts).
- Produces: `module.exports = { getCvRatio, getPopRatio, getExcludedAllianceTags, getCvLeaderboard, getPopLeaderboard, getLeaderboards }`.
  - `getCvRatio()` / `getPopRatio()`: `() => number` (positive, defaults `1000`/`100`).
  - `getExcludedAllianceTags()`: `() => string[]` (uppercased, trimmed, empty array if unset).
  - `getCvLeaderboard(sinceIso, limit)`: `(string|null, number) => Array<{player_id, player_name, raw, points}>`, sorted by `raw` descending.
  - `getPopLeaderboard(sinceIso, limit)`: same shape.
  - `getLeaderboards(sinceIso, limit = 10)`: `(string|null, number) => { cv: [...], pop: [...] }`.

- [ ] **Step 1: Write the failing test**

Create `src/repositories/battlePoints.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const settingsRepo = require('./settings');
const battlePoints = require('./battlePoints');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('battlePoints.test.js');

// Defaults with no settings rows at all
ok('getCvRatio defaults to 1000', battlePoints.getCvRatio() === 1000);
ok('getPopRatio defaults to 100', battlePoints.getPopRatio() === 100);
ok('getExcludedAllianceTags defaults to []', Array.isArray(battlePoints.getExcludedAllianceTags()) && battlePoints.getExcludedAllianceTags().length === 0);

// Empty leaderboards when there are no battle_reports rows
const emptyBoards = battlePoints.getLeaderboards(null, 10);
ok('cv leaderboard empty with no data', Array.isArray(emptyBoards.cv) && emptyBoards.cv.length === 0);
ok('pop leaderboard empty with no data', Array.isArray(emptyBoards.pop) && emptyBoards.pop.length === 0);

settingsRepo.setSetting('battle_points_cv_ratio', '1000');
settingsRepo.setSetting('battle_points_pop_ratio', '100');
settingsRepo.setSetting('battle_points_excluded_alliance_tags', 'ally, Ally2');

ok('getExcludedAllianceTags parses, trims, and uppercases', (() => {
    const tags = battlePoints.getExcludedAllianceTags();
    return tags.length === 2 && tags.includes('ALLY') && tags.includes('ALLY2');
})());

const insert = db.prepare(`
    INSERT INTO battle_reports (
        id, started_at, att_player_id, att_player_name, att_alliance_tag, att_lost_cv,
        def_player_id, def_player_name, def_alliance_tag, def_lost_cv, killed_population
    ) VALUES (
        @id, @started_at, @att_player_id, @att_player_name, @att_alliance_tag, @att_lost_cv,
        @def_player_id, @def_player_name, @def_alliance_tag, @def_lost_cv, @killed_population
    )
`);

// Battle 1: real fight, Alice (RAID) beats Bob (ENEMY). Counts fully.
insert.run({
    id: 1, started_at: '2026-08-01T00:00:00Z',
    att_player_id: 1, att_player_name: 'Alice', att_alliance_tag: 'RAID', att_lost_cv: 500,
    def_player_id: 2, def_player_name: 'Bob', def_alliance_tag: 'ENEMY', def_lost_cv: 2000,
    killed_population: 300,
});

// Battle 2: friendly fire, Alice (RAID) vs Carol (RAID). Excluded entirely.
insert.run({
    id: 2, started_at: '2026-08-02T00:00:00Z',
    att_player_id: 1, att_player_name: 'Alice', att_alliance_tag: 'RAID', att_lost_cv: 100,
    def_player_id: 3, def_player_name: 'Carol', def_alliance_tag: 'RAID', def_lost_cv: 100,
    killed_population: 50,
});

// Battle 3: Dave (RAID) vs Eve (ALLY, an excluded tag). Excluded entirely.
insert.run({
    id: 3, started_at: '2026-08-03T00:00:00Z',
    att_player_id: 4, att_player_name: 'Dave', att_alliance_tag: 'RAID', att_lost_cv: 900,
    def_player_id: 5, def_player_name: 'Eve', def_alliance_tag: 'ALLY', def_lost_cv: 900,
    killed_population: 900,
});

// Battle 4: old fight for Alice, well before the "since" window used below.
insert.run({
    id: 4, started_at: '2020-01-01T00:00:00Z',
    att_player_id: 1, att_player_name: 'Alice', att_alliance_tag: 'RAID', att_lost_cv: 9999,
    def_player_id: 6, def_player_name: 'Frank', def_alliance_tag: 'ENEMY', def_lost_cv: 9999,
    killed_population: 9999,
});

const boards = battlePoints.getLeaderboards(null, 10);
ok('cv leaderboard has exactly Alice, Bob, and Frank (battles 1 and 4; battle 2/3 excluded)',
    boards.cv.length === 3, boards.cv); // Alice attacked in both battle 1 (vs Bob) and battle 4 (vs Frank)

const alice = boards.cv.find(r => r.player_name === 'Alice');
ok('Alice is credited with def_lost_cv from battle 1 plus battle 4 (2000 + 9999)',
    alice && alice.raw === 11999, alice);
ok('Alice points = raw / 1000, rounded to 1 decimal', alice && alice.points === 12, alice);

const bob = boards.cv.find(r => r.player_name === 'Bob');
ok('Bob is credited with att_lost_cv from battle 1 (500)', bob && bob.raw === 500 && bob.points === 0.5, bob);

ok('Carol never appears (friendly fire excluded)', !boards.cv.some(r => r.player_name === 'Carol'), boards.cv);
ok('Dave/Eve never appear (excluded alliance tag)', !boards.cv.some(r => r.player_name === 'Dave' || r.player_name === 'Eve'), boards.cv);

const alicePop = boards.pop.find(r => r.player_name === 'Alice');
ok('Alice pop points from battle 1 + battle 4 (300 + 9999), attacker-credited only',
    alicePop && alicePop.raw === 10299 && alicePop.points === 103, alicePop);
ok('Bob never appears on pop leaderboard (only attacker is credited)', !boards.pop.some(r => r.player_name === 'Bob'), boards.pop);

// "since" windowing excludes battle 4 but keeps battle 1
const windowed = battlePoints.getLeaderboards('2026-01-01T00:00:00Z', 10);
const aliceWindowed = windowed.cv.find(r => r.player_name === 'Alice');
ok('with a recent "since", Alice only gets battle 1\'s cv (2000)', aliceWindowed && aliceWindowed.raw === 2000, aliceWindowed);

// limit is honored
const limited = battlePoints.getCvLeaderboard(null, 1);
ok('limit=1 returns exactly one row (the top scorer)', limited.length === 1 && limited[0].player_name === 'Alice', limited);

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/repositories/battlePoints.test.js`
Expected: FAIL — `Cannot find module './battlePoints'`

- [ ] **Step 3: Write the implementation**

Create `src/repositories/battlePoints.js`:

```js
const db = require('../database');
const settingsRepo = require('./settings');

function settingNumber(key, fallback) {
    const row = settingsRepo.getSetting(key);
    const n = row && row.value ? parseFloat(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getCvRatio() {
    return settingNumber('battle_points_cv_ratio', 1000);
}

function getPopRatio() {
    return settingNumber('battle_points_pop_ratio', 100);
}

function getExcludedAllianceTags() {
    const row = settingsRepo.getSetting('battle_points_excluded_alliance_tags');
    if (!row || !row.value) return [];
    return row.value.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
}

// Friendly fire (both sides share an alliance tag) is always excluded. An admin-configured
// excluded-alliance-tag list is layered on top when non-empty. Returns the SQL fragment and
// the positional params it needs, in the exact order its `?` placeholders appear — callers
// must not reorder the params relative to where this clause lands in their WHERE text.
function exclusionClause(excludedTags) {
    let clause = `NOT (att_alliance_tag IS NOT NULL AND def_alliance_tag IS NOT NULL AND UPPER(att_alliance_tag) = UPPER(def_alliance_tag))`;
    const params = [];
    if (excludedTags.length > 0) {
        const attPh = excludedTags.map(() => '?').join(',');
        const defPh = excludedTags.map(() => '?').join(',');
        clause += ` AND (att_alliance_tag IS NULL OR UPPER(att_alliance_tag) NOT IN (${attPh}))`;
        clause += ` AND (def_alliance_tag IS NULL OR UPPER(def_alliance_tag) NOT IN (${defPh}))`;
        params.push(...excludedTags, ...excludedTags);
    }
    return { clause, params };
}

function toPoints(raw, ratio) {
    return Math.round((raw / ratio) * 10) / 10;
}

// Arity/text vary per call (since-window presence, excluded-tag count) — prepared fresh
// each call, same reasoning as battleReports.js's markShipDetailScraped dynamic IN clause.
function getCvLeaderboard(sinceIso, limit) {
    const { clause, params } = exclusionClause(getExcludedAllianceTags());
    const sinceSql = sinceIso ? `AND started_at >= ?` : '';
    const wherePart = `${sinceSql} AND ${clause}`;
    const wherePartParams = sinceIso ? [sinceIso, ...params] : [...params];

    const sql = `
        SELECT player_id, player_name, SUM(cv_credit) AS raw_cv
        FROM (
            SELECT att_player_id AS player_id, att_player_name AS player_name, def_lost_cv AS cv_credit
            FROM battle_reports
            WHERE att_player_id IS NOT NULL ${wherePart}
            UNION ALL
            SELECT def_player_id AS player_id, def_player_name AS player_name, att_lost_cv AS cv_credit
            FROM battle_reports
            WHERE def_player_id IS NOT NULL ${wherePart}
        )
        GROUP BY player_id
        ORDER BY raw_cv DESC
        LIMIT ?
    `;
    const ratio = getCvRatio();
    return db.prepare(sql).all(...wherePartParams, ...wherePartParams, limit).map(r => ({
        player_id: r.player_id,
        player_name: r.player_name,
        raw: r.raw_cv || 0,
        points: toPoints(r.raw_cv || 0, ratio),
    }));
}

// Population is only ever credited to the attacker (the side whose fleet bombed the
// target planet) — see the design spec §1/§3 for why the defender never earns pop points.
function getPopLeaderboard(sinceIso, limit) {
    const { clause, params } = exclusionClause(getExcludedAllianceTags());
    const sinceSql = sinceIso ? `AND started_at >= ?` : '';
    const wherePart = `${sinceSql} AND ${clause}`;
    const wherePartParams = sinceIso ? [sinceIso, ...params] : [...params];

    const sql = `
        SELECT att_player_id AS player_id, att_player_name AS player_name, SUM(killed_population) AS raw_pop
        FROM battle_reports
        WHERE att_player_id IS NOT NULL ${wherePart}
        GROUP BY att_player_id
        ORDER BY raw_pop DESC
        LIMIT ?
    `;
    const ratio = getPopRatio();
    return db.prepare(sql).all(...wherePartParams, limit).map(r => ({
        player_id: r.player_id,
        player_name: r.player_name,
        raw: r.raw_pop || 0,
        points: toPoints(r.raw_pop || 0, ratio),
    }));
}

function getLeaderboards(sinceIso, limit = 10) {
    return { cv: getCvLeaderboard(sinceIso, limit), pop: getPopLeaderboard(sinceIso, limit) };
}

module.exports = {
    getCvRatio, getPopRatio, getExcludedAllianceTags,
    getCvLeaderboard, getPopLeaderboard, getLeaderboards,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node src/repositories/battlePoints.test.js`
Expected: `All checks passed`

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: every suite passes, including the new one.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/battlePoints.js src/repositories/battlePoints.test.js
git commit -m "Add battlePoints repository: CV/population leaderboard queries"
```

---

### Task 2: Second Discord identity for battle posts (`discord-post.js`)

**Files:**
- Modify: `src/utils/discord-post.js`
- Test: `src/utils/discord-post.test.js` (new)

**Interfaces:**
- Consumes: nothing new — `discord.js`'s `REST`/`Routes` (already imported), `process.env.BATTLE_DISCORD_TOKEN` (new), `process.env.DISCORD_TOKEN` (existing).
- Produces: `postBattleEmbed(settingKey, embed)`, same signature and return shape as the existing `postEmbed(settingKey, embed)` (`Promise<{ok: boolean, reason?: string, messageId?: string}>`), added to the module's exports alongside the existing three.

- [ ] **Step 1: Write the failing test**

Create `src/utils/discord-post.test.js`:

```js
// Only the token-absent no-op path is testable offline — anything that reaches a real
// Discord REST call needs a live token and network access neither test env has.

delete process.env.DISCORD_TOKEN;
delete process.env.BATTLE_DISCORD_TOKEN;

const { postBattleEmbed } = require('./discord-post');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('discord-post.test.js');

postBattleEmbed('discord_battlepoints_channel', { title: 'test' }).then(result => {
    ok('postBattleEmbed no-ops with a reason when neither token is set',
        result.ok === false && typeof result.reason === 'string', result);

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node src/utils/discord-post.test.js`
Expected: FAIL — `postBattleEmbed is not a function` (not yet exported)

- [ ] **Step 3: Modify the implementation**

In `src/utils/discord-post.js`, replace the whole file with:

```js
// Minimal "post one embed to a channel" helper.
//
// src/discord_bot.js has a logged-in client and its own sendSystemEmbed(), but it does
// not export a general-purpose sender. Rather than widen that module's surface — it is
// 1600 lines and under active change elsewhere — this uses discord.js's REST client
// directly. The bot token is all it needs; no gateway connection, no shared state.
//
// Every function here is best-effort: a missing token or an unconfigured channel is a
// no-op with a reason, never a thrown error into a request handler.

const { REST, Routes } = require('discord.js');
const settingsRepo = require('../repositories/settings');

let rest = null;
function client() {
    if (rest) return rest;
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    rest = new REST({ version: '10' }).setToken(token);
    return rest;
}

// The battle/leaderboard bot is purely cosmetic (a distinct avatar for battle posts) and
// optional: unset, it silently falls back to the main bot's token, exactly like every
// other optional integration in this app (see .env.example's DISCORD_TOKEN convention).
let battleRest = null;
function battleClient() {
    if (battleRest) return battleRest;
    const token = process.env.BATTLE_DISCORD_TOKEN;
    if (!token) return null;
    battleRest = new REST({ version: '10' }).setToken(token);
    return battleRest;
}

function settingValue(key) {
    try {
        const row = settingsRepo.getSetting(key);
        const v = row && row.value ? String(row.value).trim() : '';
        return v || null;
    } catch (err) {
        return null;
    }
}

// Names and free text reach Discord here, so "@everyone" in a route title would ping the
// server. Same defusing the incoming webhook applies: a zero-width space after the @.
function defuseMentions(value) {
    return String(value == null ? '' : value)
        .replace(/@(everyone|here)/gi, '@​$1')
        .replace(/<@([!&]?\d+)>/g, '<@​$1>');
}

async function postEmbedVia(api, settingKey, embed) {
    if (!api) return { ok: false, reason: 'no Discord token configured' };

    const channelId = settingValue(settingKey);
    if (!channelId) return { ok: false, reason: `no channel configured for ${settingKey}` };

    try {
        const msg = await api.post(Routes.channelMessages(channelId), { body: { embeds: [embed] } });
        return { ok: true, messageId: msg && msg.id };
    } catch (err) {
        console.error(`[Discord] Failed to post to ${settingKey}:`, err.message);
        return { ok: false, reason: err.message };
    }
}

/**
 * Post an embed to a channel taken from app_settings, using the main bot's token.
 * @param {string} settingKey  app_settings key holding the channel id
 * @param {object} embed       a plain Discord embed object
 * @returns {Promise<{ok: boolean, reason?: string, messageId?: string}>}
 */
async function postEmbed(settingKey, embed) {
    return postEmbedVia(client(), settingKey, embed);
}

/**
 * Post an embed for battle/leaderboard content, preferring BATTLE_DISCORD_TOKEN's
 * identity when configured and falling back to the main bot's token otherwise.
 * Same signature and return shape as postEmbed.
 */
async function postBattleEmbed(settingKey, embed) {
    return postEmbedVia(battleClient() || client(), settingKey, embed);
}

module.exports = { postEmbed, postBattleEmbed, defuseMentions, settingValue };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node src/utils/discord-post.test.js`
Expected: `All checks passed`

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass, including `battle-reports.test.js` (it only greps `sync.js`'s source text for `postEmbed('discord_battlereport_channel'`, which is untouched here).

- [ ] **Step 6: Commit**

```bash
git add src/utils/discord-post.js src/utils/discord-post.test.js
git commit -m "Add postBattleEmbed: optional second Discord identity for battle posts"
```

---

### Task 3: `.env.example` and the admin settings allowlist

**Files:**
- Modify: `.env.example`
- Modify: `src/routes/admin.js` (the `allowedKeys` array in the existing `POST /admin/settings` handler)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new consumed by later tasks — this task only unlocks admin configurability for keys Tasks 1/2/4 already read (`battle_points_cv_ratio`, `battle_points_pop_ratio`, `battle_points_excluded_alliance_tags`, `discord_battlepoints_channel`).

- [ ] **Step 1: Add `BATTLE_DISCORD_TOKEN` to `.env.example`**

In `.env.example`, change:

```
# --- Discord ---
DISCORD_TOKEN=
```

to:

```
# --- Discord ---
DISCORD_TOKEN=

# Optional second bot, purely for a distinct avatar/identity on battle-leaderboard posts
# (!mortal/!mortalday/!mortalweek replies still come from the main bot above). Leave empty
# to have battle posts go out through DISCORD_TOKEN instead — nothing is silenced.
BATTLE_DISCORD_TOKEN=
```

- [ ] **Step 2: Allow the new settings keys through the existing admin endpoint**

In `src/routes/admin.js`, find:

```js
    const allowedKeys = ['discord_announce_channel', 'discord_popdrop_channel', 'discord_incoming_channel', 'discord_reminder_channel', 'discord_battlereport_channel', 'discord_blocked_channels'];
```

Replace with:

```js
    const allowedKeys = ['discord_announce_channel', 'discord_popdrop_channel', 'discord_incoming_channel', 'discord_reminder_channel', 'discord_battlereport_channel', 'discord_blocked_channels', 'discord_battlepoints_channel', 'battle_points_cv_ratio', 'battle_points_pop_ratio', 'battle_points_excluded_alliance_tags'];
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm test`
Expected: all suites pass (there is no dedicated admin.js test suite touching this array today — this is a config-only change, verified by the full suite staying green).

- [ ] **Step 4: Commit**

```bash
git add .env.example src/routes/admin.js
git commit -m "Document BATTLE_DISCORD_TOKEN and allow battle-points settings keys"
```

---

### Task 4: `!mortal` / `!mortalday` / `!mortalweek` Discord commands

**Files:**
- Modify: `src/discord_bot.js`

**Interfaces:**
- Consumes: `battlePoints.getLeaderboards(sinceIso, limit)` from Task 1 (`{ cv: [...], pop: [...] }`, each row `{player_id, player_name, raw, points}`).
- Produces: nothing new consumed by later tasks in this plan.

- [ ] **Step 1: Add the repository require**

Near the top of `src/discord_bot.js`, alongside the existing repository requires (after the `settingsRepo` require), add:

```js
const battlePointsRepo = require('./repositories/battlePoints');
```

- [ ] **Step 2: Add the command handlers**

In `src/discord_bot.js`'s `handleMessage`, immediately after the existing `!getid` block (the one returning `` `The ID of this channel is: **${message.channel.id}**` ``), add:

```js
    // ----------------------------------------------------
    // !mortal / !mortalday / !mortalweek - BATTLE CHALLENGE LEADERBOARDS
    // ----------------------------------------------------
    if (command === 'mortal' || command === 'mortalday' || command === 'mortalweek') {
        const now = Date.now();
        const sinceIso = command === 'mortalday' ? new Date(now - 24 * 60 * 60 * 1000).toISOString()
            : command === 'mortalweek' ? new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
            : null;
        const label = command === 'mortalday' ? 'Last 24 Hours' : command === 'mortalweek' ? 'Last 7 Days' : 'All Time';

        const { cv, pop } = battlePointsRepo.getLeaderboards(sinceIso, 10);
        const formatLines = (rows, unit) => rows.length
            ? rows.map((r, i) => `**${i + 1}.** ${r.player_name || 'Unknown'} — ${r.points} pts (${r.raw.toLocaleString()} ${unit})`).join('\n')
            : '_No battles recorded yet._';

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ Battle Challenge — ${label}`)
            .addFields(
                { name: '💥 CV Killed', value: formatLines(cv, 'CV') },
                { name: '☠️ Population Killed', value: formatLines(pop, 'pop') },
            )
            .setColor('#e11d48');

        return message.reply({ embeds: [embed] });
    }
```

- [ ] **Step 3: Add the three commands to `!help`**

In the same file's `!help` embed, immediately after the existing `!battle` field entry, add:

```js
                { name: '`!mortal` / `!mortalday` / `!mortalweek`', value: 'Shows the CV/population-killed battle leaderboards — all-time, last 24 hours, or last 7 days.\n*Example: `!mortalweek`*' }
```

(Keep the existing trailing `)` of `.addFields(...)` after this new entry — it is the last field.)

- [ ] **Step 4: Manually verify the command parses without a live Discord connection**

Run: `node -e "require('./src/discord_bot.js'); console.log('module loads cleanly');"`
Expected: prints `module loads cleanly` with no thrown error (confirms no syntax error and that `battlePointsRepo`'s require resolves).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all suites pass, including `src/utils/discord.test.js` (it requires `discord_bot.js` directly — this confirms the module still loads under that test's harness too).

- [ ] **Step 6: Commit**

```bash
git add src/discord_bot.js
git commit -m "Add !mortal/!mortalday/!mortalweek battle leaderboard commands"
```

---

### Task 5: Automated twice-daily leaderboard post

**Files:**
- Modify: `src/routes/sync.js`

**Interfaces:**
- Consumes: `battlePointsRepo.getLeaderboards(null, 10)` (Task 1); `postBattleEmbed` (Task 2, added to the existing `require('../utils/discord-post')` line); `settingsRepo.getSetting`/`setSetting` (existing, already imported in this file).
- Produces: nothing new consumed elsewhere — this is the final piece of Plan 1.

- [ ] **Step 1: Extend the existing discord-post import**

In `src/routes/sync.js`, find:

```js
const { postEmbed, defuseMentions, settingValue } = require('../utils/discord-post');
```

Replace with:

```js
const { postEmbed, postBattleEmbed, defuseMentions, settingValue } = require('../utils/discord-post');
```

- [ ] **Step 2: Add the `battlePoints` repository require**

Immediately after the existing line `const battleReportsRepo = require('../repositories/battleReports');`, add:

```js
const battlePointsRepo = require('../repositories/battlePoints');
```

- [ ] **Step 3: Add the auto-post block**

In the `POST /sync/battle-reports` handler, find the line that reads the sync response (`const newest = battleReportsRepo.getNewestStartedAt();`), and insert the following block immediately **before** it (i.e. after the existing announce/`flip(...)` block closes, still inside the same `try`):

```js
        // --- BATTLE POINTS: automated twice-daily leaderboard post ---
        // This app has no server-side scheduler anywhere (every periodic-feeling behavior
        // here is actually driven by client sync traffic) — so this piggybacks on real
        // battle-report sync activity instead of adding a new timer. Any sync that
        // actually inserts new rows is treated as "fresh data just arrived"; if at least
        // 12 hours have passed since the last automated post, it fires again. In practice
        // this lands once after the first sync following local midnight (when yesterday's
        // reports become visible) and again roughly 12 hours later.
        if (inserted.length > 0 && settingValue('discord_battlepoints_channel')) {
            const lastPostRaw = settingValue('battle_points_last_auto_post_at');
            const lastPostMs = lastPostRaw ? Date.parse(lastPostRaw) : NaN;
            const hoursSince = Number.isFinite(lastPostMs) ? (Date.now() - lastPostMs) / (60 * 60 * 1000) : Infinity;
            if (hoursSince >= 12) {
                const { cv, pop } = battlePointsRepo.getLeaderboards(null, 10);
                const formatLines = (rows, unit) => rows.length
                    ? rows.map((r, i) => `**${i + 1}.** ${r.player_name || 'Unknown'} — ${r.points} pts (${r.raw.toLocaleString()} ${unit})`).join('\n')
                    : '_No battles recorded yet._';
                postBattleEmbed('discord_battlepoints_channel', {
                    title: '⚔️ Battle Challenge Update',
                    fields: [
                        { name: '💥 CV Killed', value: formatLines(cv, 'CV') },
                        { name: '☠️ Population Killed', value: formatLines(pop, 'pop') },
                    ],
                    color: 0xe11d48,
                }).catch(err => console.error('[Discord] battle-points auto-post error:', err.message));
                settingsRepo.setSetting('battle_points_last_auto_post_at', new Date().toISOString());
            }
        }

```

- [ ] **Step 4: Write a test exercising the auto-post gate logic**

There is no existing `sync.js` route-level test harness (it's an Express router, exercised today only indirectly). Rather than stand up a full HTTP test for this one route, add a focused unit test of the gating arithmetic itself — the part with real logic — to a new file:

Create `src/utils/battle-points-autopost.test.js`:

```js
// Unit-tests the "has >=12h passed since the last automated post" gate used by
// src/routes/sync.js's battle-points auto-post block. The gate is plain arithmetic over
// a settings-stored timestamp, so it's tested directly rather than through a full HTTP
// request against the Express router.

function hoursSinceLastPost(lastPostRaw, nowMs) {
    const lastPostMs = lastPostRaw ? Date.parse(lastPostRaw) : NaN;
    return Number.isFinite(lastPostMs) ? (nowMs - lastPostMs) / (60 * 60 * 1000) : Infinity;
}

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`, detail !== undefined ? detail : ''); }
}

console.log('battle-points-autopost.test.js');

const now = Date.parse('2026-08-30T12:00:00Z');

ok('never posted before (null) => Infinity hours, always fires',
    hoursSinceLastPost(null, now) === Infinity);

ok('posted 11 hours ago => gate stays closed',
    hoursSinceLastPost('2026-08-30T01:00:00Z', now) < 12);

ok('posted exactly 12 hours ago => gate opens',
    hoursSinceLastPost('2026-08-30T00:00:00Z', now) === 12);

ok('posted 13 hours ago => gate opens',
    hoursSinceLastPost('2026-08-29T23:00:00Z', now) > 12);

ok('a garbage stored timestamp is treated as "never posted" (Infinity)',
    hoursSinceLastPost('not-a-date', now) === Infinity);

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 5: Run the new test**

Run: `node src/utils/battle-points-autopost.test.js`
Expected: `All checks passed`

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all suites pass, including `battle-reports.test.js` (still greps `sync.js` for the untouched `postEmbed('discord_battlereport_channel'` call) and the new autopost test.

- [ ] **Step 7: Commit**

```bash
git add src/routes/sync.js src/utils/battle-points-autopost.test.js
git commit -m "Add automated twice-daily battle-points leaderboard post"
```

---

## End of Plan 1

At this point: the CV/population leaderboards work end-to-end from existing `battle_reports` data, `!mortal`/`!mortalday`/`!mortalweek` are live Discord commands, an optional second bot identity posts battle content (falling back to the main bot when unconfigured), and a twice-daily automated post fires off real sync traffic. Plan 2 (News-page ingestion, `docs/superpowers/plans/2026-08-30-battle-challenge-tracker-news.md`) layers walkover/bombardment completeness on top of this — nothing in Plan 2 requires re-touching the files above except extending `battlePoints.js`'s two leaderboard queries to also read `news_events`.
