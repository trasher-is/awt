// Regression coverage for battle-sync.js's once-a-day scheduling (2026-09-12, replacing a
// 30-minute setInterval — battle reports are only posted once a day, at the reset, so
// polling faster than that just re-asked for the same empty window all day). Mirrors
// galaxy-auto-seed-scheduling.test.js's extraction discipline exactly, since the two
// schedulers are deliberately unified around the same day-lock/attempt-lock/retry shape.
//
// Run with: node src/utils/battle-sync-scheduling.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui', 'battle-sync.js'), 'utf8');

const sliceStart = src.indexOf('function getLastPulledDay() {');
const sliceEnd = src.indexOf('\nlet started = false;');

function fakeStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };
}

function build({ pullResult = { ok: true, inserted: 0 }, berlinDay = '2026-09-12', nextWindow = new Date('2026-09-13T00:05:00Z') } = {}) {
    const calls = { pullOnce: 0 };
    const pullOnce = async () => { calls.pullOnce++; return pullResult; };
    const AWDailyReset = { berlinDateKey: () => berlinDay, nextDailyWindow: () => nextWindow };
    const localStorage = fakeStorage();
    const timers = [];
    const setTimeout_ = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    const console_ = { warn: () => {} };
    const body = src.slice(sliceStart, sliceEnd).replace(/export\s+/g, '');
    const factory = new Function(
        'pullOnce', 'AWDailyReset', 'localStorage', 'setTimeout', 'console', 'DAY_LOCK_KEY', 'ATTEMPT_LOCK_KEY', 'ATTEMPT_LOCK_TTL_MS', 'RETRY_DELAY_MS', 'RESET_BUFFER_MINUTES',
        `${body}\nreturn { tick, getLastPulledDay, setLastPulledDay, claimAttemptLock };`
    );
    const mod = factory(pullOnce, AWDailyReset, localStorage, setTimeout_, console_, 'k-day', 'k-attempt', 5 * 60 * 1000, 30 * 60 * 1000, 5);
    return { ...mod, calls, timers };
}

(async () => {
    ok('the expected slice is where the test expects it', sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd);

    console.log('\n── Already pulled today: ticking again does nothing ' + '─'.repeat(18));
    {
        const mod = build();
        mod.setLastPulledDay('2026-09-12');
        await mod.tick();
        ok('pullOnce was never called', mod.calls.pullOnce === 0);
        ok('rescheduled for the next daily window, not immediately', mod.timers.length === 1 && mod.timers[0].delay > 60 * 1000, mod.timers);
    }

    console.log('\n── Not pulled today: attempts and, on success, marks the day ' + '─'.repeat(9));
    {
        const mod = build({ pullResult: { ok: true, inserted: 12 } });
        await mod.tick();
        ok('pullOnce was called exactly once', mod.calls.pullOnce === 1);
        ok('the day is now marked pulled', mod.getLastPulledDay() === '2026-09-12');
    }

    console.log('\n── A failed pull does NOT mark the day, and retries sooner than a full day ' + '─'.repeat(2));
    {
        const mod = build({ pullResult: { ok: false, error: 'search failed' } });
        await mod.tick();
        ok('pullOnce was called', mod.calls.pullOnce === 1);
        ok('the day was NOT marked pulled', mod.getLastPulledDay() === null);
        ok('rescheduled as a short retry (30 min), not tomorrow\'s window', mod.timers.length === 1 && mod.timers[0].delay <= 31 * 60 * 1000, mod.timers);
    }

    console.log('\n── A thrown pullOnce is caught, not left to crash the scheduler ' + '─'.repeat(6));
    {
        const AWDailyReset = { berlinDateKey: () => '2026-09-12', nextDailyWindow: () => new Date('2026-09-13T00:05:00Z') };
        const localStorage = fakeStorage();
        const timers = [];
        const setTimeout_ = (fn, delay) => { timers.push({ fn, delay }); };
        const pullOnce = async () => { throw new Error('network dead'); };
        let warned = false;
        const console_ = { warn: () => { warned = true; } };
        const body = src.slice(sliceStart, sliceEnd).replace(/export\s+/g, '');
        const factory = new Function(
            'pullOnce', 'AWDailyReset', 'localStorage', 'setTimeout', 'console', 'DAY_LOCK_KEY', 'ATTEMPT_LOCK_KEY', 'ATTEMPT_LOCK_TTL_MS', 'RETRY_DELAY_MS', 'RESET_BUFFER_MINUTES',
            `${body}\nreturn { tick, getLastPulledDay };`
        );
        const mod = factory(pullOnce, AWDailyReset, localStorage, setTimeout_, console_, 'k-day', 'k-attempt', 5 * 60 * 1000, 30 * 60 * 1000, 5);
        let threw = false;
        try { await mod.tick(); } catch (e) { threw = true; }
        ok('tick does not propagate the throw', !threw);
        ok('the failure was logged', warned);
        ok('the day was NOT marked pulled', mod.getLastPulledDay() === null);
        ok('still rescheduled (a retry, not left hanging)', timers.length === 1, timers);
    }

    console.log('\n── Cross-tab: a second tab\'s attempt lock blocks a concurrent one ' + '─'.repeat(5));
    {
        const shared = fakeStorage();
        const pullOnce = async () => ({ ok: true, inserted: 0 });
        const AWDailyReset = { berlinDateKey: () => '2026-09-12', nextDailyWindow: () => new Date('2026-09-13T00:05:00Z') };
        const timers = [];
        const setTimeout_ = (fn, delay) => { timers.push({ fn, delay }); };
        const console_ = { warn: () => {} };
        const body = src.slice(sliceStart, sliceEnd).replace(/export\s+/g, '');
        const factory = new Function(
            'pullOnce', 'AWDailyReset', 'localStorage', 'setTimeout', 'console', 'DAY_LOCK_KEY', 'ATTEMPT_LOCK_KEY', 'ATTEMPT_LOCK_TTL_MS', 'RETRY_DELAY_MS', 'RESET_BUFFER_MINUTES',
            `${body}\nreturn { claimAttemptLock };`
        );
        const tabA = factory(pullOnce, AWDailyReset, shared, setTimeout_, console_, 'k-day', 'k-attempt', 5 * 60 * 1000, 30 * 60 * 1000, 5);
        const tabB = factory(pullOnce, AWDailyReset, shared, setTimeout_, console_, 'k-day', 'k-attempt', 5 * 60 * 1000, 30 * 60 * 1000, 5);
        ok('the first tab claims the attempt lock', tabA.claimAttemptLock() === true);
        ok('a second tab is refused immediately after', tabB.claimAttemptLock() === false);
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
