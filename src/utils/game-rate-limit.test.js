// The game server's administrator permits this tool at most FIVE requests per second.
// These tests exist because that number is a commitment to a person, not a tuning knob:
// if the cap is ever exceeded the build should fail before anyone finds out from the
// other side.
//
// Run with:  node src/utils/game-rate-limit.test.js
//
// The tests use real timers. The whole file takes a few seconds by design — a rate limit
// measured with fake time proves nothing about a rate limit.

const path = require('path');
const fs = require('fs');
const R = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-rate-limit.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// Worst number of starts inside any rolling one-second window.
function worstWindow(starts) {
    let worst = 0;
    for (const t0 of starts) {
        const n = starts.filter(t => t >= t0 && t < t0 + 1000).length;
        if (n > worst) worst = n;
    }
    return worst;
}

(async () => {
    console.log('── The cap holds under a burst ' + '─'.repeat(45));
    R.reset();
    let starts = [];
    await Promise.all(Array.from({ length: 23 }, (_, i) =>
        R.schedule(async () => { starts.push(Date.now()); return i; })
    ));
    ok('all 23 requests ran', starts.length === 23, starts.length);
    ok('never more than 5 in any rolling second', worstWindow(starts) <= 5, worstWindow(starts));
    ok('the limiter agrees with its own counter', R.snapshot().maxObservedPerSecond <= 5, R.snapshot());

    console.log('\n── The cap holds across CONCURRENT callers ' + '─'.repeat(33));
    // This is the case a per-loop sleep cannot cover: two scans running at once each got
    // their own 200 ms budget, so together they went out at twice the agreed rate.
    R.reset();
    starts = [];
    const scan = (n) => Promise.all(Array.from({ length: n }, () =>
        R.schedule(async () => { starts.push(Date.now()); })
    ));
    await Promise.all([scan(8), scan(8), scan(8)]);
    ok('all 24 requests from three parallel scans ran', starts.length === 24, starts.length);
    ok('still never more than 5 in any rolling second', worstWindow(starts) <= 5, worstWindow(starts));

    console.log('\n── Order and results are preserved ' + '─'.repeat(41));
    R.reset();
    const order = [];
    const values = await Promise.all(Array.from({ length: 7 }, (_, i) =>
        R.schedule(async () => { order.push(i); return i * 2; })
    ));
    ok('requests start in the order they were queued', order.join(',') === '0,1,2,3,4,5,6', order);
    ok('each caller gets its own result back', values.join(',') === '0,2,4,6,8,10,12', values);

    console.log('\n── Failures do not wedge the queue ' + '─'.repeat(41));
    R.reset();
    const outcomes = await Promise.allSettled([
        R.schedule(async () => { throw new Error('network down'); }),
        R.schedule(async () => 'after the failure'),
        R.schedule(async () => { throw new Error('again'); }),
        R.schedule(async () => 'still running'),
    ]);
    ok('a rejected request rejects its own caller', outcomes[0].status === 'rejected' && /network down/.test(outcomes[0].reason.message));
    ok('and the queue keeps going', outcomes[1].value === 'after the failure' && outcomes[3].value === 'still running', outcomes.map(o => o.status));

    console.log('\n── A trickle is not delayed ' + '─'.repeat(48));
    R.reset();
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await R.schedule(async () => {});
    ok('four sequential requests are not throttled at all', Date.now() - t0 < 200, Date.now() - t0);

    console.log('\n── Every game request actually goes through the gate ' + '─'.repeat(23));
    // A limiter nothing calls limits nothing.
    const ROOT = path.join(__dirname, '..', '..', 'public', 'js');
    const walk = (dir, out = []) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) walk(path.join(dir, e.name), out);
            else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
        }
        return out;
    };
    // Bare fetch() calls whose target is a game path rather than one of ours.
    const GAME_PATH = /await\s+fetch\(\s*[`'"]\/(Game|Info|Ranking|About)\//;
    const offenders = [];
    for (const file of walk(ROOT)) {
        const src = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
        if (GAME_PATH.test(src)) offenders.push(path.relative(process.cwd(), file));
    }
    ok('no browser file calls the game with a bare fetch()', offenders.length === 0, offenders);

    // And the old per-loop sleeps are gone, so there is exactly one mechanism.
    const scanner = fs.readFileSync(path.join(ROOT, 'scrapers', 'mass-scanner.js'), 'utf8');
    ok('the hand-placed sleeps in mass-scanner.js are gone',
        !/await new Promise\(resolve => setTimeout\(resolve, \d+\)\)/.test(scanner));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
