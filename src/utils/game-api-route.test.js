// The /api/v1 forwarding chain and its global five-per-second budget.
//
// Run with:  node src/utils/game-api-route.test.js
//
// Half of this suite scans server.js source: the mount ORDER is the correctness property
// (a chain registered after the /api JSON parser forwards drained PUT bodies), and order
// cannot be probed from outside without booting the whole app. The other half drives a
// gate configured exactly as server.js configures apiGate, with REAL timers — a rate
// limit measured with fake time proves nothing about a rate limit.

const path = require('path');
const fs = require('fs');
const { gameTrafficGate } = require('./game-traffic');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

const readRaw = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const readCode = rel => readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

function worstWindow(starts) {
    let worst = 0;
    for (const t0 of starts) {
        const n = starts.filter(t => t >= t0 && t < t0 + 1000).length;
        if (n > worst) worst = n;
    }
    return worst;
}

// The same minimal req/res harness game-traffic.test.js uses.
function start(gate, { automated = true, userId = 1, dest = 'empty', ip = '10.0.0.1' } = {}) {
    const listeners = {};
    const headers = {};
    if (automated) headers['x-awt-automated'] = '1';
    if (dest) headers['sec-fetch-dest'] = dest;

    let settle;
    const done = new Promise(resolve => { settle = resolve; });

    const req = { headers, ip, session: { userId }, on: () => {} };
    const res = {
        headersSent: {},
        statusCode: 200,
        setHeader(k, v) { this.headersSent[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(body) { settle({ outcome: 'answered', status: this.statusCode, body, res: this }); return this; },
        on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
        close() { (listeners.close || []).forEach(fn => fn()); },
    };

    gate(req, res, () => settle({ outcome: 'admitted', at: Date.now(), res }));
    return { done, res, req };
}

const run = (gate, opts) => start(gate, opts).done;

(async () => {
    const server = readCode('server.js');

    console.log('── server.js: the chain exists and is wired in the right order ' + '─'.repeat(13));
    // The guard matches /api/v1 tolerantly (see below); the chain is entered via a call to
    // isGameApiPath(req), which is the anchor for the ordering slice.
    const guardIdx = server.indexOf('if (!isGameApiPath(req))');
    ok('there is a dedicated /api/v1 guard', guardIdx !== -1);

    // The upstream game routes case-insensitively and percent-decodes before matching, so
    // /API/v1/... and /%61pi/v1/... reach the same endpoint. The guard MUST normalize the
    // path (decode + lowercase) before comparing, or those variants skip apiGate entirely
    // and reach the game through the catch-all proxy uncounted by the global 5/s budget.
    const helperIdx = server.indexOf('const isGameApiPath');
    ok('the guard is a normalizing helper, not a bare literal match', helperIdx !== -1);
    const helper = server.slice(helperIdx, helperIdx + 300);
    ok('it percent-decodes the path before matching', /decodeURIComponent/.test(helper), helper);
    ok('it lowercases before matching (case-insensitive like the upstream)',
        /toLowerCase\(\)/.test(helper), helper);
    ok('and still anchors on /api/v1', /startsWith\('\/api\/v1'\)/.test(helper), helper);

    const chain = server.slice(guardIdx, guardIdx + 600);
    const order = ['requireAuth(', 'proxyCeiling(', 'apiGate(', 'proxyMiddleware('].map(n => chain.indexOf(n));
    ok('the chain is requireAuth -> proxyCeiling -> apiGate -> proxy, each present',
        order.every(i => i !== -1), order);
    ok('...and in exactly that order',
        order[0] < order[1] && order[1] < order[2] && order[2] < order[3], order);

    // The body-consumption trap: express.json({limit:'5mb'}) on the /api mount drains
    // PUT/POST bodies. A chain registered after it forwards EMPTY starbase-order PUTs.
    const jsonMountIdx = server.indexOf(`app.use('/api', express.json`);
    ok('the /api JSON-parser mount still exists (webhook route)', jsonMountIdx !== -1);
    ok('the /api/v1 chain is registered BEFORE it, so bodies reach the proxy intact',
        guardIdx < jsonMountIdx, [guardIdx, jsonMountIdx]);

    ok('the chain reuses the shared proxy middleware — cookie/marker hygiene inherited',
        /proxyMiddleware\(req, res, next\)/.test(chain), chain);
    ok('server.js builds no second proxy of its own', !/createProxyMiddleware/.test(server));
    ok('no prefix is stripped: the chain is a plain app.use guard, not an /api/v1 mount',
        !/app\.use\('\/api\/v1'/.test(server));

    console.log('\n── server.js: apiGate is the global instance of the house limiter ' + '─'.repeat(10));
    const gateIdx = server.indexOf('const apiGate = gameTrafficGate(');
    ok('apiGate is a gameTrafficGate, not a new algorithm', gateIdx !== -1);
    const gateBlock = server.slice(gateIdx, gateIdx + 500);
    ok('it collapses every member into one bucket', /keyOf:\s*\(\)\s*=>\s*'global'/.test(gateBlock), gateBlock);
    ok('and counts every request, marker or not', /isAutomated:\s*\(\)\s*=>\s*true/.test(gateBlock), gateBlock);

    // The `=== undefined` idiom is deliberate: setting the var to 0 must DISABLE the
    // gate, and `||` would silently re-enable the default instead.
    ok('GAME_API_MAX_PER_SECOND uses the === undefined idiom with default 5',
        gateBlock.includes(`process.env.GAME_API_MAX_PER_SECOND === undefined ? 5 : Number(process.env.GAME_API_MAX_PER_SECOND)`),
        gateBlock);
    ok('GAME_API_MAX_WAIT_MS uses the same idiom with default 8000',
        gateBlock.includes(`process.env.GAME_API_MAX_WAIT_MS === undefined ? 8000 : Number(process.env.GAME_API_MAX_WAIT_MS)`),
        gateBlock);

    // The number is a promise to a person. The comment must say so — this one assertion
    // reads the RAW file, because readCode strips the very thing it checks.
    const raw = readRaw('server.js');
    const rawGateIdx = raw.indexOf('const apiGate = gameTrafficGate(');
    const preamble = raw.slice(Math.max(0, rawGateIdx - 1500), rawGateIdx);
    ok('the comment above apiGate names the agreement with the game administrator',
        /agree/i.test(preamble) && /administrator/i.test(preamble), preamble.slice(-300));
    ok('and names the number it promises', /(five|5)\s+requests? per second/i.test(preamble), preamble.slice(-300));

    console.log('\n── server.js: the admin can see what the gate is doing ' + '─'.repeat(21));
    ok('there is a dedicated api-traffic snapshot endpoint',
        /app\.get\('\/hub-api\/admin\/api-traffic'/.test(server));
    ok('it answers with apiGate.snapshot()',
        /api-traffic'[\s\S]{0,300}apiGate\.snapshot\(\)/.test(server));
    ok('the existing game-traffic endpoint is untouched',
        /app\.get\('\/hub-api\/admin\/game-traffic'/.test(server)
        && /game-traffic'[\s\S]{0,300}gameGate\.snapshot\(\)/.test(server));

    console.log('\n── .env.example documents the budget ' + '─'.repeat(39));
    const env = readRaw('.env.example');
    ok('GAME_API_MAX_PER_SECOND=5 is documented', /^GAME_API_MAX_PER_SECOND=5$/m.test(env));
    ok('GAME_API_MAX_WAIT_MS=8000 is documented', /^GAME_API_MAX_WAIT_MS=8000$/m.test(env));
    ok('with the agreement named next to it',
        /agreement[\s\S]{0,200}GAME_API_MAX_PER_SECOND|GAME_API_MAX_PER_SECOND[\s\S]{0,400}agreement/i.test(
            env.slice(Math.max(0, env.indexOf('GAME_API_MAX_PER_SECOND') - 400))));
    ok('the previously undocumented limiter vars are back-filled',
        /^GAME_MAX_PER_SECOND=/m.test(env) && /^GAME_MAX_WAIT_MS=/m.test(env) && /^PROXY_MAX=/m.test(env));

    console.log('\n── Behaviour: one bucket for the whole hub, real timers ' + '─'.repeat(20));
    // Built exactly as server.js builds apiGate. Two different members firing five
    // requests each: under the per-member gameGate that is two parallel budgets; under
    // this gate it must be ONE, so ten requests need at least two observed seconds.
    let gate = gameTrafficGate({
        keyOf: () => 'global',
        isAutomated: () => true,
        maxPerSecond: 5,
        maxWaitMs: 10000,
    });
    const t0 = Date.now();
    let results = await Promise.all([
        ...Array.from({ length: 5 }, () => run(gate, { userId: 1, ip: '10.0.0.1' })),
        ...Array.from({ length: 5 }, () => run(gate, { userId: 2, ip: '10.0.0.2' })),
    ]);
    ok('all ten requests were admitted eventually',
        results.every(r => r.outcome === 'admitted'), results.map(r => r.outcome));
    ok('never more than 5 in any rolling second — the two members SHARE the budget',
        worstWindow(results.map(r => r.at)) <= 5, worstWindow(results.map(r => r.at)));
    ok('so the second five had to wait into the next second',
        Date.now() - t0 >= 900, Date.now() - t0);
    ok('the gate counted the waiters', gate.snapshot().delayed > 0, gate.snapshot());
    ok('and sees exactly one bucket', gate.snapshot().buckets === 1, gate.snapshot());

    console.log('\n── Behaviour: the marker does not matter here ' + '─'.repeat(30));
    // gameGate only throttles X-AWT-Automated traffic; the API budget counts EVERYTHING,
    // because every /api/v1 request is tool traffic by definition.
    gate = gameTrafficGate({ keyOf: () => 'global', isAutomated: () => true, maxPerSecond: 5, maxWaitMs: 10000 });
    results = await Promise.all(Array.from({ length: 6 }, () => run(gate, { automated: false })));
    ok('unmarked requests are gated, not waved through',
        gate.snapshot().admitted === 6 && gate.snapshot().unmarkedXhr === 0, gate.snapshot());
    ok('and still capped at five per rolling second',
        worstWindow(results.map(r => r.at)) <= 5, worstWindow(results.map(r => r.at)));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
