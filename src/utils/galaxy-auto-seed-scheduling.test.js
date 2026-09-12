// Regression coverage for the galaxy auto-seed's once-a-day scheduling (2026-09-12,
// replacing a 5-minute setInterval — see api-galaxy-seed.js's own comment for why: the
// game only hands back a fresh Map/sectors snapshot once a day, at the reset, so polling
// faster than that just re-read the same data all day for nothing).
//
// api-galaxy-seed.js is browser-only ESM (real `import` statements, fetch, localStorage),
// so the scheduling logic (tick/scheduleWake/the two locks) is lifted out of the source
// text and evaluated here with its dependencies (seedGalaxyFromApi, AWDailyReset,
// localStorage, setTimeout, console) stubbed — same extraction discipline as
// player-api-sync-concurrency.test.js, for the same reason.
//
// Run with: node src/utils/galaxy-auto-seed-scheduling.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scrapers', 'api-galaxy-seed.js'), 'utf8');

const sliceStart = src.indexOf('const RESET_BUFFER_MINUTES = 5;');
const sliceEnd = src.indexOf('\nlet started = false;');

function fakeStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        _dump: () => Object.fromEntries(store),
    };
}

function build({ seedResult = { ok: true }, berlinDay = '2026-09-12', nextWindow = new Date('2026-09-13T00:05:00Z') } = {}) {
    const calls = { seedGalaxyFromApi: 0 };
    const seedGalaxyFromApi = async () => { calls.seedGalaxyFromApi++; return seedResult; };
    const AWDailyReset = { berlinDateKey: () => berlinDay, nextDailyWindow: () => nextWindow };
    const localStorage = fakeStorage();
    const timers = [];
    const setTimeout_ = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    const console_ = { warn: () => {} };
    const body = src.slice(sliceStart, sliceEnd).replace(/export\s+/g, '');
    const factory = new Function(
        'seedGalaxyFromApi', 'AWDailyReset', 'localStorage', 'setTimeout', 'console',
        `${body}\nreturn { tick, scheduleWake, getLastPulledDay, setLastPulledDay, claimAttemptLock };`
    );
    const mod = factory(seedGalaxyFromApi, AWDailyReset, localStorage, setTimeout_, console_);
    return { ...mod, calls, timers, localStorage };
}

(async () => {
    ok('the expected slice is where the test expects it', sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd);

    console.log('\n── Already pulled today: ticking again does nothing ' + '─'.repeat(18));
    {
        const mod = build();
        mod.setLastPulledDay('2026-09-12'); // matches the stubbed berlinDay
        await mod.tick();
        ok('seedGalaxyFromApi was never called', mod.calls.seedGalaxyFromApi === 0);
        ok('rescheduled for the next daily window, not immediately', mod.timers.length === 1 && mod.timers[0].delay > 60 * 1000, mod.timers);
    }

    console.log('\n── Not pulled today: attempts and, on success, marks the day ' + '─'.repeat(9));
    {
        const mod = build();
        await mod.tick();
        ok('seedGalaxyFromApi was called exactly once', mod.calls.seedGalaxyFromApi === 1);
        ok('the day is now marked pulled', mod.getLastPulledDay() === '2026-09-12');
    }

    console.log('\n── A failed attempt does NOT mark the day, and retries sooner than a full day ' + '─'.repeat(2));
    {
        const mod = build({ seedResult: { ok: false, error: 'boom' } });
        await mod.tick();
        ok('seedGalaxyFromApi was called', mod.calls.seedGalaxyFromApi === 1);
        ok('the day was NOT marked pulled', mod.getLastPulledDay() === null);
        ok('rescheduled as a short retry (30 min), not tomorrow\'s window', mod.timers.length === 1 && mod.timers[0].delay <= 31 * 60 * 1000, mod.timers);
    }

    console.log('\n── A thrown seedGalaxyFromApi is caught, not left to crash the scheduler ' + '─'.repeat(3));
    {
        const calls = { seedGalaxyFromApi: 0 };
        const seedGalaxyFromApi = async () => { calls.seedGalaxyFromApi++; throw new Error('network dead'); };
        const AWDailyReset = { berlinDateKey: () => '2026-09-12', nextDailyWindow: () => new Date('2026-09-13T00:05:00Z') };
        const localStorage = fakeStorage();
        const timers = [];
        const setTimeout_ = (fn, delay) => { timers.push({ fn, delay }); };
        let warned = false;
        const console_ = { warn: () => { warned = true; } };
        const body = src.slice(sliceStart, sliceEnd).replace(/export\s+/g, '');
        const factory = new Function(
            'seedGalaxyFromApi', 'AWDailyReset', 'localStorage', 'setTimeout', 'console',
            `${body}\nreturn { tick, getLastPulledDay };`
        );
        const mod = factory(seedGalaxyFromApi, AWDailyReset, localStorage, setTimeout_, console_);
        let threw = false;
        try { await mod.tick(); } catch (e) { threw = true; }
        ok('tick does not propagate the throw', !threw);
        ok('the failure was logged', warned);
        ok('the day was NOT marked pulled', mod.getLastPulledDay() === null);
        ok('still rescheduled (a retry, not left hanging)', timers.length === 1, timers);
    }

    console.log('\n── Cross-tab: a second tab\'s attempt lock blocks a concurrent one ' + '─'.repeat(5));
    {
        // Same localStorage instance shared between two "tabs" — the second claimAttemptLock
        // must see the first tab's freshly-set lock and refuse.
        const shared = fakeStorage();
        const seedGalaxyFromApi = async () => ({ ok: true });
        const AWDailyReset = { berlinDateKey: () => '2026-09-12', nextDailyWindow: () => new Date('2026-09-13T00:05:00Z') };
        const timers = [];
        const setTimeout_ = (fn, delay) => { timers.push({ fn, delay }); };
        const console_ = { warn: () => {} };
        const body = src.slice(sliceStart, sliceEnd).replace(/export\s+/g, '');
        const factory = new Function(
            'seedGalaxyFromApi', 'AWDailyReset', 'localStorage', 'setTimeout', 'console',
            `${body}\nreturn { claimAttemptLock };`
        );
        const tabA = factory(seedGalaxyFromApi, AWDailyReset, shared, setTimeout_, console_);
        const tabB = factory(seedGalaxyFromApi, AWDailyReset, shared, setTimeout_, console_);
        ok('the first tab claims the attempt lock', tabA.claimAttemptLock() === true);
        ok('a second tab is refused immediately after', tabB.claimAttemptLock() === false);
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
