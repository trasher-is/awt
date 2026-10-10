// Test only a local HTTP server and injected service. No provider transport exists.
const http = require('http');
const express = require('express');
const { createRouter } = require('../routes/race-checks');
let failed = 0, calls = 0;
function ok(name, condition) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`); }
}
const service = {
    requestCheck: () => ({ request: { status: 'pending' } }), queue: () => [], usage: () => ({ enabled: false }),
    approveRequest: () => { calls++; return { status: 'done' }; },
    runCheck: () => { calls++; return { status: 'done' }; },
    rejectRequest: () => ({ status: 'rejected' }), resolveCheck: (_id, _user, decision) => ({ decision }),
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    if (req.headers['x-test-role']) req.session = { userId: 1, role: req.headers['x-test-role'] };
    next();
});
app.use('/hub-api', createRouter(service));
const server = app.listen(0, '127.0.0.1');
const send = (method, endpoint, role, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (role) headers['x-test-role'] = role;
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        method, path: '/hub-api' + endpoint, headers }, response => {
        let data = ''; response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data), headers: response.headers }));
    });
    request.on('error', reject); request.end(payload);
});
server.once('listening', async () => {
    try {
        const memberRequest = '/intel/race/123/check-request', adminCheck = '/admin/race/123/check';
        ok('unauthenticated request cannot create an approval request', (await send('POST', memberRequest)).status === 401);
        ok('guest cannot request a provider check', (await send('POST', memberRequest, 'guest')).status === 403);
        ok('member may request without invoking a provider', (await send('POST', memberRequest, 'user')).status === 200 && calls === 0);
        ok('member cannot directly run, approve, resolve, read queue or cost ledger',
            (await send('POST', adminCheck, 'user')).status === 403
            && (await send('POST', '/admin/race/check-requests/1/approve', 'user')).status === 403
            && (await send('POST', adminCheck + '/resolve', 'user')).status === 403
            && (await send('GET', '/admin/race/check-requests', 'user')).status === 403
            && (await send('GET', '/admin/llm-usage', 'user')).status === 403 && calls === 0);
        ok('admin can run and approve', (await send('POST', adminCheck, 'admin')).status === 200
            && (await send('POST', '/admin/race/check-requests/1/approve', 'admin')).status === 200 && calls === 2);
        const kept = await send('POST', adminCheck + '/resolve', 'admin', { decision: 'keep' });
        ok('resolution explicitly preserves keep decision', kept.body.decision === 'keep');
        ok('reject endpoint and approval queue have expected shape', (await send('POST', '/admin/race/check-requests/1/reject', 'admin')).body.status === 'rejected'
            && Array.isArray((await send('GET', '/admin/race/check-requests', 'admin')).body.requests));
        const usage = await send('GET', '/admin/llm-usage', 'admin');
        ok('ledger is admin-only, exposes status without credentials, and is uncached', usage.body.enabled === false && usage.headers['cache-control'] === 'no-store');
        ok('unsafe integer ids are rejected before service invocation',
            (await send('POST', '/admin/race/9007199254740993/check', 'admin')).status === 400 && calls === 2);
    } catch (error) { failed++; console.error(error); }
    finally { server.close(() => { process.exitCode = failed ? 1 : 0; }); }
});
