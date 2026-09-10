// The generic fixed-window limiter (proxyCeiling, apiAccountWindowCeiling, login,
// webhook, ...) plus its two additions from the "why did some of my deep scan fail with
// no explanation" incident: a snapshot() in the same shape gameTrafficGate's gate uses,
// and an optional onReject hook so a specific limiter can log instead of failing silently
// (every rateLimit instance did before this — see docs/game-api.md).
//
// Run with:  node src/utils/rate-limit.test.js
//
// Real timers on purpose — same reasoning as game-api-route.test.js: a rate limit proven
// with fake time proves nothing about a rate limit.

const { rateLimit } = require('./rate-limit');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function run(limiter, { key = 'a' } = {}) {
    return new Promise(resolve => {
        const req = { ip: key, socket: { remoteAddress: key } };
        const res = {
            statusCode: 200,
            setHeader() {},
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ admitted: false, status: this.statusCode, body }); },
        };
        limiter(req, res, () => resolve({ admitted: true, status: 200 }));
    });
}

(async () => {
    console.log('── Basic admit/reject, unchanged behaviour ' + '─'.repeat(32));
    let limiter = rateLimit({ windowMs: 200, max: 2 });
    const under = await Promise.all([run(limiter, { key: 'x' }), run(limiter, { key: 'x' })]);
    ok('the first `max` requests from one key are admitted', under.every(r => r.admitted), under);
    const over = await run(limiter, { key: 'x' });
    ok('the (max+1)th request is rejected with 429', !over.admitted && over.status === 429, over);
    ok('a Retry-After header value rides in the body too', typeof over.body.retryAfter === 'number', over.body);

    console.log('\n── snapshot(): same shape as gameTrafficGate, updates live ' + '─'.repeat(15));
    limiter = rateLimit({ windowMs: 200, max: 2 });
    ok('a fresh limiter reports zero admitted/rejected', limiter.snapshot().admitted === 0 && limiter.snapshot().rejected === 0, limiter.snapshot());
    ok('and reports the configured limit', limiter.snapshot().limit === 2, limiter.snapshot());
    await run(limiter, { key: 'y' });
    await run(limiter, { key: 'y' });
    ok('two admits are counted', limiter.snapshot().admitted === 2, limiter.snapshot());
    await run(limiter, { key: 'y' });
    ok('a rejection is counted separately from admits', limiter.snapshot().rejected === 1 && limiter.snapshot().admitted === 2, limiter.snapshot());
    ok('one bucket for the one key seen so far', limiter.snapshot().buckets === 1, limiter.snapshot());
    await run(limiter, { key: 'z' });
    ok('a second key opens a second bucket', limiter.snapshot().buckets === 2, limiter.snapshot());

    console.log('\n── onReject: fires only on rejection, carries the key ' + '─'.repeat(20));
    const seen = [];
    limiter = rateLimit({ windowMs: 200, max: 1, onReject: (key, req) => seen.push({ key, req }) });
    await run(limiter, { key: 'w' });
    ok('onReject does not fire for an admitted request', seen.length === 0, seen);
    await run(limiter, { key: 'w' });
    ok('onReject fires exactly once for the rejection', seen.length === 1, seen);
    ok('onReject receives the bucket key that got rejected', seen[0] && seen[0].key === 'w', seen);
    ok('onReject also receives the request object', seen[0] && seen[0].req && seen[0].req.ip === 'w', seen);

    console.log('\n── window reset still works with the new counters ' + '─'.repeat(24));
    limiter = rateLimit({ windowMs: 150, max: 1 });
    await run(limiter, { key: 'v' });
    const blocked = await run(limiter, { key: 'v' });
    ok('blocked before the window elapses', !blocked.admitted, blocked);
    await new Promise(resolve => setTimeout(resolve, 170));
    const afterReset = await run(limiter, { key: 'v' });
    ok('admitted again once the window elapses', afterReset.admitted, afterReset);
    ok('the reset admit is still counted in the snapshot', limiter.snapshot().admitted === 2, limiter.snapshot());

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
