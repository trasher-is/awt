// Stale search and preview responses must not replace newer results.
//
// Run with:  node src/utils/request-sequence.test.js
//
// The sidebar search and the route-planner preview debounce the start of a request but
// let every response write to the DOM (issue #129). This drives the shared sequencer with
// deferred promises so the response ORDER is under test control: start A, change the
// input and start B, resolve B, then resolve A — and A must not win. Then the same with
// the field cleared, and with the panel closed, before A resolves.
//
// The second half scans search.js and route-planner.js: a perfect sequencer nobody calls
// protects nothing, and those two files are browser-only ESM that cannot run here.

const path = require('path');
const fs = require('fs');

const { createSequencer, createKeyedSequencers } = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'request-sequence.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// The search box, reduced to what matters: an input, a results box, a request per input
// change whose response we control. This is the exact control flow search.js follows.
function makePanel() {
    const seq = createSequencer();
    const box = { html: '' };
    const pending = [];
    let input = '';

    async function execute() {
        const q = input.trim();
        if (!q) { seq.cancel(); box.html = ''; return; }
        const token = seq.next();
        box.html = `loading:${q}`;
        const d = deferred();
        pending.push({ q, d });
        try {
            const data = await d.promise;
            if (!seq.isCurrent(token)) return;
            box.html = `results:${data}`;
        } catch (err) {
            if (!seq.isCurrent(token)) return;
            box.html = `error:${err.message}`;
        }
    }

    return {
        box, seq,
        type(text) { input = text; return execute(); },
        clear() { input = ''; return execute(); },
        close() { seq.cancel(); },
        respond(q, data) { const p = pending.find(x => x.q === q && !x.done); p.done = true; p.d.resolve(data); return p.d.promise.then(() => {}); },
        failWith(q, msg) { const p = pending.find(x => x.q === q && !x.done); p.done = true; p.d.reject(new Error(msg)); return p.d.promise.catch(() => {}); },
    };
}

const tick = () => new Promise(r => setImmediate(r));

(async () => {
    console.log('── A slower, older response cannot overwrite the newer one ' + '─'.repeat(16));
    {
        const p = makePanel();
        p.type('ab');            // request A
        p.type('abc');           // request B — A is now stale
        ok('the box shows the loading state for the CURRENT input', p.box.html === 'loading:abc', p.box.html);
        await p.respond('abc', 'B-results'); await tick();
        ok('B renders', p.box.html === 'results:B-results', p.box.html);
        await p.respond('ab', 'A-results'); await tick();
        ok('A, arriving late, does NOT replace B', p.box.html === 'results:B-results', p.box.html);
    }

    console.log('\n── Even a late ERROR is discarded ' + '─'.repeat(40));
    {
        const p = makePanel();
        p.type('x'); p.type('xy');
        await p.respond('xy', 'good'); await tick();
        await p.failWith('x', 'network'); await tick();
        ok('an error from the stale request does not paint over the newer results', p.box.html === 'results:good', p.box.html);
    }

    console.log('\n── Clearing the field invalidates pending work ' + '─'.repeat(29));
    {
        const p = makePanel();
        p.type('abc');
        p.clear();
        ok('the box is emptied at once', p.box.html === '', p.box.html);
        await p.respond('abc', 'late'); await tick();
        ok('the pending response does not repopulate the emptied box', p.box.html === '', p.box.html);
    }

    console.log('\n── Closing the panel invalidates pending work ' + '─'.repeat(30));
    {
        const p = makePanel();
        p.type('abc');
        p.close();
        await p.respond('abc', 'late'); await tick();
        ok('a response arriving after close renders nothing', p.box.html === 'loading:abc', p.box.html);
        p.type('abcd');
        await p.respond('abcd', 'fresh'); await tick();
        ok('and a request started AFTER the close works normally', p.box.html === 'results:fresh', p.box.html);
    }

    console.log('\n── Ordinary use is unchanged ' + '─'.repeat(46));
    {
        const p = makePanel();
        p.type('one');
        await p.respond('one', 'r1'); await tick();
        ok('a single request renders', p.box.html === 'results:r1', p.box.html);
        p.type('two');
        await p.respond('two', 'r2'); await tick();
        ok('the next one too', p.box.html === 'results:r2', p.box.html);
        p.type('three');
        await p.failWith('three', 'boom'); await tick();
        ok('a CURRENT request\'s error is shown', p.box.html === 'error:boom', p.box.html);
    }

    console.log('\n── The sequencer itself ' + '─'.repeat(51));
    {
        const s = createSequencer();
        const t1 = s.next();
        ok('the first token is current', s.isCurrent(t1));
        const t2 = s.next();
        ok('a newer token supersedes it', s.isCurrent(t2) && !s.isCurrent(t1));
        s.cancel();
        ok('cancel makes every issued token stale without issuing a new one', !s.isCurrent(t2) && s.token > t2);
        ok('tokens are never reused', s.next() > t2);
        ok('an unrelated value is never current', !s.isCurrent(undefined) && !s.isCurrent(null) && !s.isCurrent(0));
    }

    console.log('\n── Search types are independent of each other ' + '─'.repeat(29));
    {
        const ks = createKeyedSequencers();
        const player = ks.for('player'), system = ks.for('system');
        ok('one sequencer per key, stable across calls', ks.for('player') === player && player !== system);
        const tp = player.next();
        system.next();
        system.cancel();
        ok('cancelling the system search leaves the player search current', player.isCurrent(tp));
        ks.cancelAll();
        ok('cancelAll stops them all', !player.isCurrent(tp));
    }

    // ─── THE UI FILES ACTUALLY USE IT ───────────────────────────────────────────
    console.log('\n── search.js and route-planner.js are wired to it ' + '─'.repeat(26));
    const readCode = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

    const search = readCode('public/js/ui/search.js');
    ok('search.js imports the sequencer module', /import '\.\.\/utils\/request-sequence\.js'/.test(search));
    ok('search.js has no single shared debounce timer any more', !/let searchTimeout\b/.test(search));
    ok('search.js keeps debounce state per search type', /searchTimers/.test(search) && /createKeyedSequencers\(\)/.test(search));
    const exec = search.slice(search.indexOf('async function executeSearch'), search.indexOf('async function searchLiveViaApi'));
    ok('executeSearch takes a token before the request', /const token = seq\.next\(\)/.test(exec));
    ok('...and checks it before rendering results or errors', (exec.match(/if \(!seq\.isCurrent\(token\)\) return;/g) || []).length >= 2);
    ok('...and cancels pending work when the field is cleared', /if \(!q\) \{[\s\S]{0,80}seq\.cancel\(\)/.test(exec));

    const planner = readCode('public/js/ui/route-planner.js');
    ok('route-planner.js imports the sequencer module', /import '\.\.\/utils\/request-sequence\.js'/.test(planner));
    const previewFn = planner.slice(planner.indexOf('async function preview'), planner.indexOf('function renderLeg'));
    ok('preview takes a token before the request', /const token = previewSeq\.next\(\)/.test(previewFn));
    ok('...and checks it before painting the ETA or an error', (previewFn.match(/if \(!previewSeq\.isCurrent\(token\)\) return;/g) || []).length >= 2);
    ok('closing the panel cancels a pending preview', /previewSeq\.cancel\(\)/.test(planner));
    ok('the waypoint system dropdown guards its stale lookups too',
        /const rowSeq = createSequencer\(\)/.test(planner) && /if \(!rowSeq\.isCurrent\(token\)\) return;/.test(planner));
    ok('...and so does the player dropdown',
        /const playerSeq = createSequencer\(\)/.test(planner) && /if \(!playerSeq\.isCurrent\(token\)\) return;/.test(planner));
    ok('no automatic live-game search was added (the budget promise)',
        (search.match(/searchLiveViaApi\(/g) || []).length === 2 /* definition + the one click handler */, (search.match(/searchLiveViaApi\(/g) || []).length);

    const utilSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'request-sequence.js'), 'utf8');
    ok('the shared module stays dual-runtime: no import/export statements', !/^\s*(import|export)\b/m.test(utilSrc));

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
