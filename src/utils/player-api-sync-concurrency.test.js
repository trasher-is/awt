// Player/{id} scans happen only when a member presses "Player API scan" (2026-10-16), and the
// ListPlayer roster pull only right before a scan (2026-10-17). The
// 30-second background sweep that used to run from every open hub tab is gone, because
// every call rides on the member's own game session and the game counted them as active
// around the clock. What remains to pin:
//   • no timer in player-api-sync.js: neither scans nor the roster pull run by themselves
//   • one manual scan at a time per page (the shared `scanning` flag), released even when
//     the scan throws
//
// Run with:  node src/utils/player-api-sync-concurrency.test.js
//
// player-api-sync.js is browser-only ESM (real `import` statements, fetch, localStorage),
// so deepScanPlayers is lifted out of the source text and evaluated here with its
// dependencies (claimLock, scanClaimedBatch, pullPlayerList) stubbed — same extraction
// discipline as profile-buildings-card.test.js, for the same reason.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'player-api-sync.js'), 'utf8');

const sliceStart = src.indexOf('let scanning = false;');
const sliceEnd = src.length;

function build({ scanClaimedBatch = async () => ({ ok: true, claimed: 0, scanned: 0, failed: 0 }) } = {}) {
    const calls = { claimLock: 0, scanClaimedBatch: 0, pullPlayerList: 0 };
    const claimLock = () => { calls.claimLock++; return true; };
    const scan = async (...args) => { calls.scanClaimedBatch++; return scanClaimedBatch(...args); };
    const pullPlayerList = async () => { calls.pullPlayerList++; return { ok: true, count: 0 }; };
    const body = src.slice(sliceStart, sliceEnd).replace(/export \s*/g, '');
    const factory = new Function(
        'claimLock', 'scanClaimedBatch', 'pullPlayerList', 'console',
        `${body}\nreturn { deepScanPlayers, isScanning: () => scanning };`
    );
    return { ...factory(claimLock, scan, pullPlayerList, { warn: () => {} }), calls };
}

(async () => {
    console.log('── No background player sweep ' + '─'.repeat(46));
    ok('the expected slice is where the test expects it', sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd);
    ok('no timer of any kind: the roster pull runs only before a scan (2026-10-17)', !/setInterval\(|setTimeout\(/.test(src));
    ok('nothing for the dashboard to start on load', !/initPlayerApiSync/.test(src));
    ok('no sweep tick left in the module', !/runSweepTick|SWEEP_INTERVAL_MS/.test(src));

    console.log('\n── One manual scan at a time ' + '─'.repeat(47));
    {
        const mod = build({ scanClaimedBatch: () => new Promise(() => {}) }); // never finishes
        mod.deepScanPlayers(150, () => {});
        await Promise.resolve(); await Promise.resolve();
        ok('the first scan holds `scanning`', mod.isScanning() === true);
        const second = await mod.deepScanPlayers(150, () => {});
        ok('a second scan while the first runs is refused', second.ok === false && /already running/.test(second.error), second);
    }

    console.log('\n── `scanning` is released even if the scan throws ' + '─'.repeat(26));
    {
        const mod = build({ scanClaimedBatch: async () => { throw new Error('boom'); } });
        let threw = false;
        try { await mod.deepScanPlayers(150, () => {}); } catch (e) { threw = true; }
        ok('a thrown scanClaimedBatch still propagates (deepScanPlayers has no catch of its own)', threw);
        ok('but `scanning` is released via finally, not left stuck true', mod.isScanning() === false);
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
