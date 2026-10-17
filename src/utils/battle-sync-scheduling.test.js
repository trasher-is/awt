// Regression coverage for battle-sync.js's scheduling (2026-10-17): once per game day for the
// whole hub. The hub hands the day's pull to ONE member's browser (shared job 'battle-sync',
// src/repositories/sharedJobs.js — its own test covers the daily window and rotation); this
// file pins the browser side: no claim, no pull; never more than one pull at a time; and a
// failure is swallowed instead of crashing the scheduler.
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

const sliceStart = src.indexOf('let pulling = false;');
const sliceEnd = src.indexOf('\nlet started = false;');

let memberActive = true;
globalThis.AWGameRate = { isMemberActive: () => memberActive };

function build({ granted = true, pullOnce = async () => ({ ok: true, inserted: 0 }) } = {}) {
    const calls = { claim: [], pullOnce: 0, warned: 0 };
    const claimSharedJob = async (job) => { calls.claim.push(job); return granted; };
    const pull = async () => { calls.pullOnce++; return pullOnce(); };
    const console_ = { warn: () => { calls.warned++; } };
    const body = src.slice(sliceStart, sliceEnd);
    const factory = new Function('claimSharedJob', 'pullOnce', 'console', 'JOB',
        `${body}\nreturn { tick, isPulling: () => pulling };`);
    return { ...factory(claimSharedJob, pull, console_, 'battle-sync'), calls };
}

(async () => {
    ok('the expected slice is where the test expects it', sliceStart !== -1 && sliceEnd !== -1 && sliceStart < sliceEnd);

    console.log('\n── The hub says it is this member\'s turn: one pull ' + '─'.repeat(19));
    {
        const mod = build();
        await mod.tick();
        ok('asked the hub for the battle-sync job', mod.calls.claim.length === 1 && mod.calls.claim[0] === 'battle-sync', mod.calls.claim);
        ok('pulled exactly once', mod.calls.pullOnce === 1);
    }

    console.log('\n── Not this member\'s turn (or already pulled today): no game request ' + '─'.repeat(2));
    {
        const mod = build({ granted: false });
        await mod.tick();
        ok('no pull', mod.calls.pullOnce === 0);
    }

    console.log('\n── Member away: does not even ask the hub ' + '─'.repeat(28));
    {
        memberActive = false;
        const mod = build();
        await mod.tick();
        memberActive = true;
        ok('no claim (another member who is present can take today\'s turn)', mod.calls.claim.length === 0);
        ok('no pull', mod.calls.pullOnce === 0);
    }

    console.log('\n── A slow pull does not stack ' + '─'.repeat(40));
    {
        const mod = build({ pullOnce: () => new Promise(() => {}) }); // never finishes
        mod.tick();
        await new Promise(resolve => setImmediate(resolve));
        ok('the first tick holds `pulling`', mod.isPulling() === true);
        await mod.tick();
        ok('a second tick while it runs neither claims nor pulls', mod.calls.claim.length === 1 && mod.calls.pullOnce === 1, mod.calls);
    }

    console.log('\n── A failed or thrown pull is logged, not left to crash the scheduler ' + '─'.repeat(1));
    {
        const failed = build({ pullOnce: async () => ({ ok: false, error: 'search failed' }) });
        await failed.tick();
        ok('a failed pull is logged', failed.calls.warned === 1);
        const thrown = build({ pullOnce: async () => { throw new Error('network dead'); } });
        let threw = false;
        try { await thrown.tick(); } catch (e) { threw = true; }
        ok('tick does not propagate the throw', !threw);
        ok('the failure was logged', thrown.calls.warned === 1);
        ok('`pulling` is released', thrown.isPulling() === false);
    }

    console.log('\n── No per-browser day-lock left ' + '─'.repeat(38));
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    ok('the old localStorage day-lock and its own reset timer are gone', !/localStorage|DAY_LOCK_KEY|nextDailyWindow/.test(code));
    ok('the job name the hub knows', /const JOB = 'battle-sync';/.test(src));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
