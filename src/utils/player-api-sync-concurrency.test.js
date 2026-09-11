// The background player sweep and a manual "Deep scan" used to have separate re-entrancy
// flags, so a 60s-interval sweep tick could fire WHILE a 150-player deep scan's own
// getPlayer loop was still running — both drawing on the SAME per-account 200/5min game
// API budget at once (confirmed live, 2026-09-11: a deep scan plus a concurrent sweep tick
// tipped one account over the budget partway through, costing the tail of the run to
// 429s). Fixed by sharing one `scanning` flag between runSweepTick and deepScanPlayers.
//
// Run with:  node src/utils/player-api-sync-concurrency.test.js
//
// player-api-sync.js is browser-only ESM (real `import` statements, fetch, localStorage),
// so the two functions under test are lifted out of the source text and evaluated here
// with their dependencies (claimLock, scanClaimedBatch, pullPlayerList) stubbed — same
// extraction discipline as profile-buildings-card.test.js, for the same reason.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'player-api-sync.js'), 'utf8');

const sliceStart = src.indexOf('let scanning = false;');
const sliceEnd = src.indexOf('\nlet started = false;');

function build({ claimLockResult = true, scanClaimedBatchResult = { ok: true, claimed: 0, scanned: 0, failed: 0 }, pullPlayerListResult = { ok: true, count: 0 } } = {}) {
    const calls = { claimLock: 0, scanClaimedBatch: 0, pullPlayerList: 0 };
    const claimLock = () => { calls.claimLock++; return claimLockResult; };
    const scanClaimedBatch = async () => { calls.scanClaimedBatch++; return scanClaimedBatchResult; };
    const pullPlayerList = async () => { calls.pullPlayerList++; return pullPlayerListResult; };
    const SWEEP_LOCK_KEY = 'k1', SWEEP_LOCK_TTL_MS = 1, SWEEP_BATCH_SIZE = 15;
    const console_ = { warn: () => {} };
    const body = src.slice(sliceStart, sliceEnd).replace(/export \s*/g, '');
    const factory = new Function(
        'claimLock', 'scanClaimedBatch', 'pullPlayerList',
        'SWEEP_LOCK_KEY', 'SWEEP_LOCK_TTL_MS', 'SWEEP_BATCH_SIZE', 'console',
        `${body}\nreturn { runSweepTick, deepScanPlayers, isScanning: () => scanning };`
    );
    const mod = factory(claimLock, scanClaimedBatch, pullPlayerList, SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS, SWEEP_BATCH_SIZE, console_);
    return { ...mod, calls };
}

(async () => {
    console.log('── Lifting the shared `scanning` flag + runSweepTick + deepScanPlayers ' + '─'.repeat(4));
    ok('the expected slice is where the test expects it', sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd);

    console.log('\n── A deep scan already running blocks a concurrent sweep tick ' + '─'.repeat(11));
    {
        const mod = build({
            // Never resolves during this test — simulates deepScanPlayers still being
            // mid-flight when a sweep tick fires.
            scanClaimedBatchResult: new Promise(() => {}),
        });
        const deepScanPromise = mod.deepScanPlayers(150, () => {});
        // Let the deep scan's synchronous prefix (claimLock, setting scanning=true) run.
        await Promise.resolve();
        await Promise.resolve();
        ok('scanning is true while the deep scan is in flight', mod.isScanning() === true);
        const scanClaimedBatchCallsBefore = mod.calls.scanClaimedBatch;
        await mod.runSweepTick();
        ok('the sweep tick returned without claiming anything (scanClaimedBatch call count unchanged)',
            mod.calls.scanClaimedBatch === scanClaimedBatchCallsBefore, mod.calls);
        void deepScanPromise; // intentionally left pending — this test doesn't need it to resolve
    }

    console.log('\n── A running sweep tick blocks a concurrent deep scan ' + '─'.repeat(18));
    {
        const mod = build({
            scanClaimedBatchResult: new Promise(() => {}), // sweep tick never finishes mid-test
        });
        const sweepPromise = mod.runSweepTick();
        await Promise.resolve();
        await Promise.resolve();
        ok('scanning is true while the sweep tick is in flight', mod.isScanning() === true);
        const deepScanResult = await mod.deepScanPlayers(150, () => {});
        ok('deepScanPlayers refuses to start, with a clear reason, not a silent no-op',
            deepScanResult.ok === false && typeof deepScanResult.error === 'string' && deepScanResult.error.length > 0,
            deepScanResult);
        ok('pullPlayerList was never called — no budget spent on the refused attempt',
            mod.calls.pullPlayerList === 0, mod.calls);
        void sweepPromise;
    }

    console.log('\n── Once a deep scan finishes, the sweep can run again ' + '─'.repeat(17));
    {
        const mod = build(); // default: both resolve immediately
        await mod.deepScanPlayers(150, () => {});
        ok('scanning is released after the deep scan completes', mod.isScanning() === false);
        const scanClaimedBatchCallsBefore = mod.calls.scanClaimedBatch;
        await mod.runSweepTick();
        ok('a sweep tick after that actually claims (not blocked by stale state)',
            mod.calls.scanClaimedBatch === scanClaimedBatchCallsBefore + 1, mod.calls);
    }

    console.log('\n── deepScanPlayers still releases `scanning` even if scanClaimedBatch throws ' + '─'.repeat(2));
    {
        const calls = { claimLock: 0 };
        const claimLock = () => { calls.claimLock++; return true; };
        const scanClaimedBatch = async () => { throw new Error('boom'); };
        const pullPlayerList = async () => ({ ok: true, count: 0 });
        const body = src.slice(sliceStart, sliceEnd).replace(/export \s*/g, '');
        const factory = new Function(
            'claimLock', 'scanClaimedBatch', 'pullPlayerList',
            'SWEEP_LOCK_KEY', 'SWEEP_LOCK_TTL_MS', 'SWEEP_BATCH_SIZE', 'console',
            `${body}\nreturn { runSweepTick, deepScanPlayers, isScanning: () => scanning };`
        );
        const mod = factory(claimLock, scanClaimedBatch, pullPlayerList, 'k', 1, 15, { warn: () => {} });
        let threw = false;
        try { await mod.deepScanPlayers(150, () => {}); } catch (e) { threw = true; }
        ok('a thrown scanClaimedBatch still propagates (deepScanPlayers has no catch of its own)', threw);
        ok('but `scanning` is still released via finally, not left stuck true', mod.isScanning() === false);
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
