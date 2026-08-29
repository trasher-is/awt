# Database Refactor — trade domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every raw `db.prepare()` call site touching the `trade_agreements` table into a
new `src/repositories/trade.js` module, mirroring the pattern established by the five prior domain
plans.

**Architecture:** New `src/repositories/trade.js`. Same conventions as before: module-level `const`
prepared statements, named exported functions, no error-handling changes, behavior-preserving 1:1
moves with ONE sanctioned dedup (documented below). This is the smallest domain plan so far — every
call site is in a single file, `src/routes/trade.js`, which already imports `playersRepo` and
`alliancesRepo` from prior domains.

**Tech Stack:** Node.js, better-sqlite3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-database-refactor-design.md`

## Global Constraints

- No SQL text, parameter order, or return-shape changes for any migrated query, with exactly ONE
  documented dedup: `getAgreementById(id)` consolidates two identical
  `SELECT * FROM trade_agreements WHERE id = ?` lookups (the confirm route and the cancel route).
- Do NOT merge `markAgreementDoneByInitiator` and `markAgreementDoneByScan` even though they look
  similar — their SQL genuinely differs: the former parameterizes `initiator` with `?` (bound to
  the requesting player's name), the latter hardcodes the literal `'scan'`.
- Do NOT merge `proposeAgreement` and `forceSetAgreement` even though both are
  `INSERT INTO trade_agreements ... ON CONFLICT ...` upserts — they differ in every literal value
  (`status`, `initiator`, `is_admin_set`) and `proposeAgreement`'s `ON CONFLICT` clause has an extra
  `WHERE trade_agreements.status='cancelled'` guard that `forceSetAgreement`'s does not.
- Prepared statements compiled once at module load — no variable-arity queries in this domain.
- No error-handling changes — try/catch and HTTP status codes stay in calling routes.
- Two small transactions in this domain each wrap a single repeated statement in a loop
  (`/sync/trade-agreements`'s `markDone.run(...)` per partner, `/sync/trade-partners`'s
  `markDone.run(...)` per pair) — both transactions touch ONLY `trade_agreements`, no other-domain
  tables, so there's no cross-domain mixing risk here (unlike `sync.js` in prior domains). Move the
  statement into the repository, keep the transaction wrapper and its loop exactly as they are.
- **Verification lesson from all four prior domains**: a single-line grep misses multi-line
  queries. Every "verify no call sites were missed" step in this plan requires reading each
  remaining `db.prepare()`/`db.transaction()` block's actual SQL text, not just running the naive
  grep. Also **re-run the full test suite** (`npm test`) after the migration and watch for any test
  asserting against literal source text containing `trade_agreements` SQL — this exact failure mode
  hit four of the four prior domains (`round-archive.test.js`, `vision-model.test.js`,
  `player-sync.test.js`, `discord.test.js`).
- After the migration step, restart `awt-test` (`pm2 restart awt-test`) and manually exercise the
  trade-agreements board before moving to the next task.

## File Structure

- Create: `src/repositories/trade.js`
- Create: `src/repositories/trade.test.js`
- Modify: `src/routes/trade.js`

---

### Task 1: `src/repositories/trade.js`

**Files:**
- Create: `src/repositories/trade.js`
- Test: `src/repositories/trade.test.js`

**Interfaces:**
- Consumes: `db` from `../database`
- Produces (used by Task 2):
  - `getActivePairKeys(): Array<{pair_key}>`
  - `getActiveAgreements(): Array<object>`
  - `getAgreementStatusByPairKey(pairKey): {status} | undefined`
  - `getAgreementById(id): object | undefined`
  - `proposeAgreement(pairKey, playerA, playerB, initiator): void`
  - `confirmAgreement(id): void`
  - `cancelAgreement(id): void`
  - `forceSetAgreement(pairKey, playerA, playerB): void`
  - `markAgreementDoneByInitiator(pairKey, playerA, playerB, initiator): void`
  - `markAgreementDoneByScan(pairKey, playerA, playerB): void`

- [ ] **Step 1: Write the module**

Create `src/repositories/trade.js`:

```js
const db = require('../database');

const getActivePairKeysStmt = db.prepare(`
    SELECT pair_key FROM trade_agreements
    WHERE status IN ('proposed','confirmed','done')
`);
function getActivePairKeys() {
    return getActivePairKeysStmt.all();
}

const getActiveAgreementsStmt = db.prepare(`SELECT * FROM trade_agreements WHERE status != 'cancelled' ORDER BY id ASC`);
function getActiveAgreements() {
    return getActiveAgreementsStmt.all();
}

const getAgreementStatusByPairKeyStmt = db.prepare(`SELECT status FROM trade_agreements WHERE pair_key = ?`);
function getAgreementStatusByPairKey(pairKey) {
    return getAgreementStatusByPairKeyStmt.get(pairKey);
}

// Consolidates the confirm route's and the cancel route's identical lookups.
const getAgreementByIdStmt = db.prepare(`SELECT * FROM trade_agreements WHERE id = ?`);
function getAgreementById(id) {
    return getAgreementByIdStmt.get(id);
}

const proposeAgreementStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'proposed', ?, 0)
    ON CONFLICT(pair_key) DO UPDATE SET status='proposed', initiator=excluded.initiator, updated_at=CURRENT_TIMESTAMP
        WHERE trade_agreements.status='cancelled'
`);
function proposeAgreement(pairKey, playerA, playerB, initiator) {
    proposeAgreementStmt.run(pairKey, playerA, playerB, initiator);
}

const confirmAgreementStmt = db.prepare(`UPDATE trade_agreements SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?`);
function confirmAgreement(id) {
    confirmAgreementStmt.run(id);
}

const cancelAgreementStmt = db.prepare(`DELETE FROM trade_agreements WHERE id=?`);
function cancelAgreement(id) {
    cancelAgreementStmt.run(id);
}

// NOT the same as proposeAgreement above — different literal status/initiator/is_admin_set
// values and no WHERE guard on the ON CONFLICT clause. See Global Constraints.
const forceSetAgreementStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'confirmed', 'admin', 1)
    ON CONFLICT(pair_key) DO UPDATE SET status='confirmed', is_admin_set=1, initiator='admin', updated_at=CURRENT_TIMESTAMP
`);
function forceSetAgreement(pairKey, playerA, playerB) {
    forceSetAgreementStmt.run(pairKey, playerA, playerB);
}

// NOT the same as markAgreementDoneByScan below — this one parameterizes `initiator`.
const markAgreementDoneByInitiatorStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'done', ?, 0)
    ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
`);
function markAgreementDoneByInitiator(pairKey, playerA, playerB, initiator) {
    markAgreementDoneByInitiatorStmt.run(pairKey, playerA, playerB, initiator);
}

// NOT the same as markAgreementDoneByInitiator above — this one hardcodes initiator='scan'.
const markAgreementDoneByScanStmt = db.prepare(`
    INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
    VALUES (?, ?, ?, 'done', 'scan', 0)
    ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
`);
function markAgreementDoneByScan(pairKey, playerA, playerB) {
    markAgreementDoneByScanStmt.run(pairKey, playerA, playerB);
}

module.exports = {
    getActivePairKeys, getActiveAgreements, getAgreementStatusByPairKey, getAgreementById,
    proposeAgreement, confirmAgreement, cancelAgreement, forceSetAgreement,
    markAgreementDoneByInitiator, markAgreementDoneByScan,
};
```

- [ ] **Step 2: Write the smoke test**

Create `src/repositories/trade.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const trade = require('./trade');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('trade.test.js');

ok('getActiveAgreements starts empty', trade.getActiveAgreements().length === 0);
ok('getActivePairKeys starts empty', trade.getActivePairKeys().length === 0);

trade.proposeAgreement('caveman|trader1', 'caveman', 'trader1', 'caveman');
ok('proposeAgreement created a proposed row', trade.getActiveAgreements().length === 1);
ok('getAgreementStatusByPairKey finds it', trade.getAgreementStatusByPairKey('caveman|trader1').status === 'proposed');
ok('getActivePairKeys now includes it', trade.getActivePairKeys().some(r => r.pair_key === 'caveman|trader1'));

const ta = trade.getActiveAgreements()[0];
ok('getAgreementById returns the same row', trade.getAgreementById(ta.id).pair_key === 'caveman|trader1');

trade.confirmAgreement(ta.id);
ok('confirmAgreement sets status to confirmed', trade.getAgreementById(ta.id).status === 'confirmed');

trade.cancelAgreement(ta.id);
ok('cancelAgreement removes the row', trade.getAgreementById(ta.id) === undefined);
ok('getActiveAgreements excludes the cancelled/deleted row', trade.getActiveAgreements().length === 0);

trade.forceSetAgreement('adminpair|x', 'adminpair', 'x');
const forced = trade.getActiveAgreements()[0];
ok('forceSetAgreement creates an already-confirmed row', forced.status === 'confirmed' && forced.is_admin_set === 1 && forced.initiator === 'admin');

trade.markAgreementDoneByInitiator('donepair|y', 'donepair', 'y', 'donepair');
const doneRow = trade.getActiveAgreements().find(r => r.pair_key === 'donepair|y');
ok('markAgreementDoneByInitiator creates a done row with the given initiator', doneRow.status === 'done' && doneRow.initiator === 'donepair');

trade.markAgreementDoneByScan('scanpair|z', 'scanpair', 'z');
const scanRow = trade.getActiveAgreements().find(r => r.pair_key === 'scanpair|z');
ok('markAgreementDoneByScan creates a done row with initiator=scan', scanRow.status === 'done' && scanRow.initiator === 'scan');

// Re-proposing an existing non-cancelled pair should NOT change it (the ON CONFLICT guard
// only fires when status='cancelled') — proposeAgreement on the already-confirmed forced
// pair must leave it untouched.
trade.proposeAgreement('adminpair|x', 'adminpair', 'x', 'someoneelse');
ok('proposeAgreement does not touch a non-cancelled existing pair (ON CONFLICT WHERE guard)', trade.getActiveAgreements().find(r => r.pair_key === 'adminpair|x').status === 'confirmed');

fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log('All checks passed');
```

- [ ] **Step 3: Run the test to verify it fails first**

Temporarily rename `trade.js`, run `node src/repositories/trade.test.js`, confirm it errors with
`Cannot find module './trade'`, restore the filename.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /root/awt-test && node src/repositories/trade.test.js`
Expected: every line `ok -`, ends `All checks passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /root/awt-test
git add src/repositories/trade.js src/repositories/trade.test.js
git commit -m "Add trade repository module (trade_agreements)"
```

---

### Task 2: Migrate `src/routes/trade.js`

**Files:**
- Modify: `src/routes/trade.js`

**Interfaces:**
- Consumes: `trade` from Task 1

- [ ] **Step 1: Add the import**

Alongside the file's existing `playersRepo`/`alliancesRepo` imports:
```js
const tradeRepo = require('../repositories/trade');
```

- [ ] **Step 2: `countFor`'s active-pair-keys lookup**

Before:
```js
function countFor(nameLower) {
    const rows = db.prepare(`
        SELECT pair_key FROM trade_agreements
        WHERE status IN ('proposed','confirmed','done')
    `).all();
    return rows.filter(r => r.pair_key.split('|').includes(nameLower)).length;
}
```
After:
```js
function countFor(nameLower) {
    const rows = tradeRepo.getActivePairKeys();
    return rows.filter(r => r.pair_key.split('|').includes(nameLower)).length;
}
```

- [ ] **Step 3: `GET /trade-agreements` list route**

Before:
```js
        const agreements = db.prepare(`SELECT * FROM trade_agreements WHERE status != 'cancelled' ORDER BY id ASC`).all();
```
After: `const agreements = tradeRepo.getActiveAgreements();`

- [ ] **Step 4: `validatePair`'s existing-pairing check**

Before:
```js
    const existing = db.prepare(`SELECT status FROM trade_agreements WHERE pair_key = ?`).get(pairKey(aName, bName));
```
After: `const existing = tradeRepo.getAgreementStatusByPairKey(pairKey(aName, bName));`

- [ ] **Step 5: `POST /trade-agreements/propose`**

Before:
```js
        const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
        db.prepare(`
            INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
            VALUES (?, ?, ?, 'proposed', ?, 0)
            ON CONFLICT(pair_key) DO UPDATE SET status='proposed', initiator=excluded.initiator, updated_at=CURRENT_TIMESTAMP
                WHERE trade_agreements.status='cancelled'
        `).run(pairKey(me, partner), a, b, me);
```
After:
```js
        const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
        tradeRepo.proposeAgreement(pairKey(me, partner), a, b, me);
```

- [ ] **Step 6: `POST /trade-agreements/:id/confirm`'s load + apply**

Before:
```js
    const ta = db.prepare(`SELECT * FROM trade_agreements WHERE id = ?`).get(req.params.id);
```
After: `const ta = tradeRepo.getAgreementById(req.params.id);`

Before (later in the same handler):
```js
    db.prepare(`UPDATE trade_agreements SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(ta.id);
```
After: `tradeRepo.confirmAgreement(ta.id);`

- [ ] **Step 7: `POST /trade-agreements/:id/cancel`'s load + apply**

Before:
```js
    const ta = db.prepare(`SELECT * FROM trade_agreements WHERE id = ?`).get(req.params.id);
```
After: `const ta = tradeRepo.getAgreementById(req.params.id);`

Before (later in the same handler):
```js
    db.prepare(`DELETE FROM trade_agreements WHERE id=?`).run(ta.id);
```
After: `tradeRepo.cancelAgreement(ta.id);`

- [ ] **Step 8: `POST /admin/trade-agreements`**

Before:
```js
    const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    db.prepare(`
        INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
        VALUES (?, ?, ?, 'confirmed', 'admin', 1)
        ON CONFLICT(pair_key) DO UPDATE SET status='confirmed', is_admin_set=1, initiator='admin', updated_at=CURRENT_TIMESTAMP
    `).run(pairKey(a, b), pa, pb);
```
After:
```js
    const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    tradeRepo.forceSetAgreement(pairKey(a, b), pa, pb);
```

- [ ] **Step 9: `POST /sync/trade-agreements`'s transaction**

Before:
```js
    const markDone = db.prepare(`
        INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
        VALUES (?, ?, ?, 'done', ?, 0)
        ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
    `);

    const tx = db.transaction((list) => {
        for (const raw of list) {
            const partner = canonicalName(String(raw).trim());
            if (!partner || partner.toLowerCase() === me.toLowerCase()) continue;
            const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            markDone.run(pairKey(me, partner), a, b, me);
        }
    });
```
After:
```js
    const tx = db.transaction((list) => {
        for (const raw of list) {
            const partner = canonicalName(String(raw).trim());
            if (!partner || partner.toLowerCase() === me.toLowerCase()) continue;
            const [a, b] = [me, partner].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            tradeRepo.markAgreementDoneByInitiator(pairKey(me, partner), a, b, me);
        }
    });
```

- [ ] **Step 10: `POST /sync/trade-partners`'s transaction**

Before:
```js
    const markDone = db.prepare(`
        INSERT INTO trade_agreements (pair_key, player_a, player_b, status, initiator, is_admin_set)
        VALUES (?, ?, ?, 'done', 'scan', 0)
        ON CONFLICT(pair_key) DO UPDATE SET status='done', updated_at=CURRENT_TIMESTAMP
    `);

    const tx = db.transaction((list) => {
        let n = 0;
        for (const pair of list) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const a = canonicalName(String(pair[0]).trim());
            const b = canonicalName(String(pair[1]).trim());
            if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
            const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            markDone.run(pairKey(a, b), pa, pb);
            n++;
        }
        return n;
    });
```
After:
```js
    const tx = db.transaction((list) => {
        let n = 0;
        for (const pair of list) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const a = canonicalName(String(pair[0]).trim());
            const b = canonicalName(String(pair[1]).trim());
            if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
            const [pa, pb] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
            tradeRepo.markAgreementDoneByScan(pairKey(a, b), pa, pb);
            n++;
        }
        return n;
    });
```

- [ ] **Step 11: Verify no domain call sites were missed, and check whether `db` is still needed**

Run: `cd /root/awt-test && grep -n "db\.prepare\|db\.transaction" src/routes/trade.js`. Confirm
zero remaining matches reference `trade_agreements`. The two `db.transaction(...)` wrappers from
Steps 9-10 should still be present (only their inner statement changed) — this file still
genuinely needs `db` for those two transaction wrappers and for the unrelated
`SELECT value FROM app_settings WHERE key = 'pp_price'` lookup in `getMembers()` — do NOT remove
the `const db = require('../database');` import.

- [ ] **Step 12: Restart and manually verify**

Run: `pm2 restart awt-test && sleep 2`
At `https://test.37.27.17.97.nip.io`: open the trade-agreements board, propose a new agreement,
confirm it as the counterpart (or as admin), cancel one, and (as admin) force-set a pairing. If you
can trigger a `/sync/trade-agreements` or `/sync/trade-partners` payload (via the in-game scraper),
confirm agreements land as `done` afterward.

- [ ] **Step 13: Commit**

```bash
cd /root/awt-test
git add src/routes/trade.js
git commit -m "Migrate trade.js trade_agreements queries to the repository layer"
```

---

### Task 3: Full regression pass and close out the domain

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /root/awt-test && npm test`
Expected: all suites pass (including the new `repositories/trade.test.js`), exit code 0. If
anything fails, check first whether it's a source-text assertion broken by this domain's refactor
(the pattern that hit all four prior domains) before assuming a real behavior regression.

- [ ] **Step 2: Confirm zero remaining raw call sites for this domain, codebase-wide**

```bash
cd /root/awt-test && grep -rln "trade_agreements" src --include=*.js | grep -v ".test.js" | grep -v "src/repositories/" | grep -v "src/database.js"
```
Expected: no output (this domain has exactly one consumer file, `src/routes/trade.js`, and it's
now fully migrated). If anything is listed, read its full SQL text and confirm whether it's a
missed call site.

- [ ] **Step 3: Final end-to-end pass on `awt-test`**

Run: `pm2 restart awt-test && sleep 2 && pm2 logs awt-test --lines 30 --nostream`
Expected: clean boot, no errors. Spend a few minutes clicking through the trade-agreements board
one more time, now that every call site for this domain has moved.
