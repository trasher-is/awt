// Reservations must track actual callback starts even when the page is busy before
// its microtask checkpoint. Real elapsed time is essential to this regression.
const modulePath = require.resolve('../../public/js/utils/game-rate-limit.js');
let pass = 0, fail = 0;
const ok = (name, condition, detail) => {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
};
function fresh() {
    delete require.cache[modulePath];
    return require(modulePath);
}
function worstWindow(starts) {
    return Math.max(0, ...starts.map(from => starts.filter(t => t >= from && t < from + 1000).length));
}
function busyPage(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* synchronous page work before the microtask checkpoint */ }
}
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
(async () => {
    for (const shared of [false, true]) {
        if (shared) {
            const storage = new Map();
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
                getItem: key => storage.get(key) ?? null,
                setItem: (key, value) => storage.set(key, String(value)),
            } });
        } else delete globalThis.localStorage;
        const a = fresh(), b = shared ? fresh() : a;
        const starts = [];
        const began = Date.now();
        const jobs = Array.from({ length: 10 }, (_, index) => (index < 5 ? a : b).schedule(() => {
            starts.push(Date.now()); return index;
        }));
        busyPage(500);
        const values = await Promise.all(jobs);
        ok(`${shared ? 'two shared realms' : 'one realm'}: busy page cannot compress reserved bursts`,
            worstWindow(starts) <= 5, { worst: worstWindow(starts), starts: starts.map(t => t - began) });
        ok(`${shared ? 'two shared realms' : 'one realm'}: all queued results retain their order`,
            values.every((value, index) => value === index));
        ok('the administrator limit remains five starts per second', a.MAX_PER_SECOND === 5 && a.WINDOW_MS === 1000);
    }
    delete globalThis.localStorage;
    const rate = fresh();
    const order = [];
    let nested, release;
    const first = rate.schedule(() => {
        order.push('first');
        nested = rate.schedule(() => { order.push('nested'); return 'nested-result'; });
        return new Promise(resolve => { release = resolve; });
    });
    const later = rate.schedule(() => { order.push('later'); return 'later-result'; });
    const result = await later;
    ok('a pending request does not hold the start queue until network completion', result === 'later-result' && order.join(',') === 'first,nested,later', order);
    ok('reentrant scheduling drains FIFO and preserves the nested result', await nested === 'nested-result');
    release('first-result');
    ok('the original in-flight promise still settles for its own caller', await first === 'first-result');
    const failure = rate.schedule(() => { throw new Error('synchronous failure'); });
    const success = rate.schedule(() => ({ then(resolve) { resolve('thenable-result'); } }));
    const outcomes = await Promise.allSettled([failure, success]);
    ok('synchronous throws reject only their own request', outcomes[0].status === 'rejected' && outcomes[0].reason.message === 'synchronous failure');
    ok('thenable results are assimilated without wedging the queue', outcomes[1].value === 'thenable-result');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
});
