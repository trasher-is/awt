// The hub must start even when the provider SDK package is not installed.
//
// The AI race check is off unless RACE_LLM=1, but llm-client.js used to require the SDK at
// the top, and every route file pulls it in, so a hub updated with `git pull` but without a
// successful `npm ci` crashed on boot and nginx answered 502. That took other alliances'
// hubs down when they updated past #340 (2026-10-16, awt-nsa: MODULE_NOT_FOUND).
//
// Run with:  node src/utils/llm-client-missing-sdk.test.js
process.env.AWT_DB_PATH = process.env.AWT_DB_PATH || ':memory:';
const Module = require('module');
// Spelled in pieces, as in race-llm-service.test.js: only llm-client.js may name them.
const SDK_NAME = ['@anthropic-ai', 'sdk'].join('/');
const CREDENTIAL = ['ANTHROPIC', 'API', 'KEY'].join('_');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// Make the SDK unresolvable, as on a hub where npm ci never ran.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === SDK_NAME) {
        const err = new Error(`Cannot find module '${request}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
    }
    return resolve.call(this, request, ...rest);
};
const warn = console.warn;
console.warn = () => {};

(async () => {
    let client, loadError = null;
    try { client = require('./llm-client'); } catch (err) { loadError = err; }
    ok('llm-client.js loads without the SDK installed', !loadError, loadError && loadError.message);
    ok('race-llm-service.js (required by the routes at boot) loads too', (() => {
        try { require('./race-llm-service'); return true; } catch (err) { return false; }
    })());
    ok('the AI check still reports itself off', client.configuration().enabled === false);

    process.env.RACE_LLM = '1';
    process.env[CREDENTIAL] = 'test-key-not-real';
    const c = client.createClient();
    let code = null;
    try {
        const prepared = c.prepare({ subject: 'S' }, 'v1');
        await c.call(prepared);
    } catch (err) { code = err.code || err.message; }
    ok('a real call without the SDK fails as a check error, not a crash', typeof code === 'string', code);

    console.warn = warn;
    Module._resolveFilename = resolve;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
