// The server-side half of the five-requests-per-second agreement, plus the two other
// things that leave this process on their way to the game: the hub's session cookie, and
// the fixture collector.
//
// Run with:  node src/utils/game-traffic.test.js
//
// Real timers throughout. A rate limit measured with fake time proves nothing about a
// rate limit — the same rule the browser-side test in game-rate-limit.test.js follows.

const path = require('path');
const { gameTrafficGate } = require('./game-traffic');
const proxy = require('../proxy');
const collector = require('../../scripts/collect-travel-fixtures.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function worstWindow(starts) {
    let worst = 0;
    for (const t0 of starts) {
        const n = starts.filter(t => t >= t0 && t < t0 + 1000).length;
        if (n > worst) worst = n;
    }
    return worst;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Enough of express's req/res for the middleware. Returns the response object straight
// away so a test can close it mid-wait, and a promise that settles with 'admitted' when
// the gate calls next() or with the status when it answers instead.
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
        // What Node does when the member closes the tab or the connection drops.
        close() { (listeners.close || []).forEach(fn => fn()); },
    };

    gate(req, res, () => settle({ outcome: 'admitted', at: Date.now(), res }));
    return { done, res, req };
}

const run = (gate, opts) => start(gate, opts).done;

(async () => {
    console.log('── Automated traffic is capped, and waits rather than fails ' + '─'.repeat(16));
    let gate = gameTrafficGate({ maxPerSecond: 5, maxWaitMs: 10000 });
    let results = await Promise.all(Array.from({ length: 13 }, () => run(gate)));
    ok('all 13 automated requests were let through eventually',
        results.every(r => r.outcome === 'admitted'), results.map(r => r.outcome));
    ok('never more than 5 in any rolling second',
        worstWindow(results.map(r => r.at)) <= 5, worstWindow(results.map(r => r.at)));
    ok('the gate agrees with its own counter', gate.snapshot().maxObservedPerSecond <= 5, gate.snapshot());
    ok('and it recorded that some of them had to wait', gate.snapshot().delayed > 0, gate.snapshot());

    console.log('\n── A member browsing the game is NOT throttled ' + '─'.repeat(29));
    // One game page pulls dozens of assets. Capping those at five per second would make
    // the game unusable, and would be misreading the agreement rather than keeping it.
    gate = gameTrafficGate({ maxPerSecond: 5 });
    const t0 = Date.now();
    const assets = await Promise.all(Array.from({ length: 40 }, () =>
        run(gate, { automated: false, dest: 'script' })));
    ok('40 asset requests all passed', assets.every(r => r.outcome === 'admitted'));
    ok('and none of them was delayed at all', Date.now() - t0 < 200, Date.now() - t0);
    ok('assets are not counted as XHR either', gate.snapshot().unmarkedXhr === 0, gate.snapshot());

    console.log('\n── Unmarked fetch/XHR is reported, not silently throttled ' + '─'.repeat(18));
    // Either a caller that bypassed gameFetch, or the game's own page scripts. Throttling
    // the second would break the UI it belongs to, and we cannot yet tell them apart — so
    // count it and make it findable instead of guessing.
    gate = gameTrafficGate({ maxPerSecond: 5 });
    await Promise.all(Array.from({ length: 8 }, () => run(gate, { automated: false, dest: 'empty' })));
    ok('unmarked XHR is counted', gate.snapshot().unmarkedXhr === 8, gate.snapshot());
    ok('and it did not consume the automated budget', gate.snapshot().admitted === 0, gate.snapshot());

    console.log('\n── Two tabs of one member share one budget; two members do not ' + '─'.repeat(13));
    gate = gameTrafficGate({ maxPerSecond: 5, maxWaitMs: 10000 });
    results = await Promise.all([
        ...Array.from({ length: 5 }, () => run(gate, { userId: 7 })),
        ...Array.from({ length: 5 }, () => run(gate, { userId: 7 })),
    ]);
    ok('one member with two tabs is still one budget',
        worstWindow(results.map(r => r.at)) <= 5, worstWindow(results.map(r => r.at)));

    gate = gameTrafficGate({ maxPerSecond: 5, maxWaitMs: 10000 });
    const t1 = Date.now();
    await Promise.all([
        ...Array.from({ length: 5 }, () => run(gate, { userId: 1, ip: '10.0.0.9' })),
        ...Array.from({ length: 5 }, () => run(gate, { userId: 2, ip: '10.0.0.9' })),
    ]);
    ok('two members behind one address do not throttle each other', Date.now() - t1 < 300, Date.now() - t1);

    console.log('\n── When it does give up, it says so ' + '─'.repeat(40));
    gate = gameTrafficGate({ maxPerSecond: 1, maxWaitMs: 10000, maxWaiting: 3 });
    results = await Promise.all(Array.from({ length: 10 }, () => run(gate)));
    const refused = results.filter(r => r.outcome === 'answered');
    ok('a queue deeper than maxWaiting is refused, not queued forever', refused.length > 0, results.map(r => r.outcome));
    ok('refusals are 429', refused.every(r => r.status === 429), refused.map(r => r.status));
    ok('with a Retry-After header', refused.every(r => r.res.headersSent['Retry-After']), refused.map(r => r.res.headersSent));
    ok('and the message names the agreement, not a config value',
        /agreement with the game administrator/.test(refused[0].body.error), refused[0].body.error);

    gate = gameTrafficGate({ maxPerSecond: 1, maxWaitMs: 1200, maxWaiting: 50 });
    results = await Promise.all(Array.from({ length: 6 }, () => run(gate)));
    ok('a wait longer than maxWaitMs is refused too',
        results.some(r => r.outcome === 'answered' && r.status === 429), results.map(r => r.outcome));

    console.log('\n── A cancelled request gives its place back ' + '─'.repeat(32));
    // Closing the tab mid-scan must not leave a reservation behind. Without this, a member
    // who cancels a scan a few times fills maxWaiting with ghosts and then gets 429s for
    // requests nobody is making.
    gate = gameTrafficGate({ maxPerSecond: 1, maxWaitMs: 30000, maxWaiting: 5 });
    const holder = await run(gate);                       // takes the only slot this second
    ok('the first request went through', holder.outcome === 'admitted');

    const cancelled = start(gate);                        // has to wait for the next second
    await sleep(50);
    ok('it is waiting', gate.snapshot().waiting === 1, gate.snapshot());

    let cancelledSettled = false;
    cancelled.done.then(() => { cancelledSettled = true; });
    cancelled.res.close();                                // the member closed the tab
    ok('closing the connection releases the reservation immediately',
        gate.snapshot().waiting === 0, gate.snapshot());

    await sleep(1300);   // well past the point where its slot would have come up
    ok('and the abandoned request is never admitted afterwards', cancelledSettled === false);
    ok('the slot it gave back is still usable', (await run(gate)).outcome === 'admitted');

    console.log('\n── maxPerSecond = 0 disables the gate entirely ' + '─'.repeat(29));
    gate = gameTrafficGate({ maxPerSecond: 0 });
    const t2 = Date.now();
    results = await Promise.all(Array.from({ length: 20 }, () => run(gate)));
    ok('every request passes straight through', results.every(r => r.outcome === 'admitted'));
    ok('with no delay', Date.now() - t2 < 200, Date.now() - t2);

    console.log('\n── The hub session cookie does not reach the game ' + '─'.repeat(26));
    // The proxied pages are served from the hub's origin, so the browser attaches every
    // cookie it holds for it — including ours, signed with SESSION_SECRET.
    const strip = proxy.stripHubCookie;
    ok('the hub session cookie is removed',
        strip('connect.sid=s%3Aabc.def; .AspNetCore.Identity.Application=xyz')
            === '.AspNetCore.Identity.Application=xyz');
    ok('the game\'s own cookies are kept — stripping them would log the member out',
        strip('.AspNetCore.Identity.Application=xyz; theme=dark')
            === '.AspNetCore.Identity.Application=xyz; theme=dark');
    ok('a cookie merely containing the name is not mistaken for it',
        strip('not-connect.sid=1; xconnect.sid=2') === 'not-connect.sid=1; xconnect.sid=2');
    ok('a header of nothing but our cookie becomes empty, not "; "',
        strip('connect.sid=abc') === '');
    ok('no cookie header at all is handled', strip(undefined) === null && strip('') === null);
    ok('the name matches what express-session actually uses',
        proxy.HUB_SESSION_COOKIE === 'connect.sid');

    console.log('\n── The fixture collector cannot be aimed at production ' + '─'.repeat(21));
    ok('the test server is allowed',
        collector.assertAllowedBase('https://test.astrowars.games') === 'https://test.astrowars.games');
    for (const host of ['https://astrowars.games', 'https://redzone.astrowars.games', 'http://astrowars.games:8080']) {
        let refusedIt = false;
        try { collector.assertAllowedBase(host); } catch (err) { refusedIt = /Refusing to run against/.test(err.message); }
        ok(`${host} is refused`, refusedIt);
    }
    ok('and the refusal explains why, in terms of the agreement', (() => {
        try { collector.assertAllowedBase('https://astrowars.games'); return false; }
        catch (err) { return /has not been agreed/.test(err.message); }
    })());
    ok('production is not on the allowlist at all', !collector.ALLOWED_HOSTS.has('astrowars.games'));

    console.log('\n── ...and it survives either shape of /api/v1/Player ' + '─'.repeat(23));
    // This is the bug that meant the script never ran: it read a single player object
    // from a route the spec documents as returning a list.
    ok('a single player object is used directly', collector.pickSelf({ id: 4, name: 'Me' }, null).name === 'Me');
    ok('a list without --player-id fails with an instruction, not a TypeError', (() => {
        try { collector.pickSelf([{ id: 1 }, { id: 2 }], null); return false; }
        catch (err) { return /--player-id/.test(err.message); }
    })());
    ok('a list with --player-id finds the right entry',
        collector.pickSelf([{ id: 1 }, { id: 2 }], '2').id === 2);
    ok('a --player-id that is not in the list is reported', (() => {
        try { collector.pickSelf([{ id: 1 }], '9'); return false; }
        catch (err) { return /is not in the/.test(err.message); }
    })());
    ok('origin as a Point resolves by coordinates — the spec says it has no id',
        collector.resolveHome({ origin: { x: 3, y: 4 } }, [{ id: 9, x: 1, y: 1 }, { id: 5, x: 3, y: 4 }]).id === 5);
    ok('origin as an id still works, in case the live server differs from the spec',
        collector.resolveHome({ origin: { id: 9 } }, [{ id: 9, x: 1, y: 1 }]).id === 9);
    ok('no origin at all falls back instead of crashing',
        collector.resolveHome({}, [{ id: 11, x: 0, y: 0 }]).id === 11);
    ok('race speed is read from either field name',
        collector.readSpeed({ intelligenceReport: { race: { speedBonus: 2 } } }) === 2
        && collector.readSpeed({ intelligenceReport: { race: { speedPick: -1 } } }) === -1
        && collector.readSpeed({ id: 1 }) === null);

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
