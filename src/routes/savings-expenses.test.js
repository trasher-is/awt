// My Savings planned expenses: GET/POST /hub-api/my-planets/expenses, PATCH/DELETE
// /hub-api/my-planets/expenses/:id. What matters is that a member only ever sees and
// touches their own rows, and that a typo cannot store a nonsense amount or due time.
//
// Run with: node src/routes/savings-expenses.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-savings-expenses-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const myPlanetsRouter = require('./myPlanets');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('savings-expenses.test.js');

const alice = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('Alice', 'x', 'user')`).run().lastInsertRowid;
const bob = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('Bob', 'x', 'user')`).run().lastInsertRowid;

let sessionUserId = alice;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: sessionUserId }; next(); });
app.use('/hub-api', myPlanetsRouter);

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const HOUR = 3600 * 1000;

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        let r = await request(server, 'GET', '/hub-api/my-planets/expenses');
        ok('empty list to start', r.status === 200 && r.body.success && r.body.expenses.length === 0, r.body);

        const before = Date.now();
        r = await request(server, 'POST', '/hub-api/my-planets/expenses', {});
        const blank = r.body.expense;
        ok('a new row defaults to 0 A$, due in 6h', r.status === 200 && blank.amount === 0
            && blank.due_at >= before + 6 * HOUR && blank.due_at <= Date.now() + 6 * HOUR, r.body);

        r = await request(server, 'PATCH', `/hub-api/my-planets/expenses/${blank.id}`, { amount: 7225 });
        ok('amount can be set without touching the due time', r.body.expense.amount === 7225 && r.body.expense.due_at === blank.due_at, r.body);

        r = await request(server, 'PATCH', `/hub-api/my-planets/expenses/${blank.id}`, { due_at: blank.due_at + 6 * HOUR });
        ok('due time moves by the step sent, amount kept', r.body.expense.due_at === blank.due_at + 6 * HOUR && r.body.expense.amount === 7225, r.body);

        for (const [desc, patch] of [
            ['a negative amount', { amount: -5 }],
            ['a fractional amount', { amount: 1.5 }],
            ['a non-number amount', { amount: 'lots' }],
            ['a due time a year away', { due_at: Date.now() + 365 * 24 * HOUR }],
        ]) {
            r = await request(server, 'PATCH', `/hub-api/my-planets/expenses/${blank.id}`, patch);
            ok(`rejects ${desc}`, r.status === 400 && !r.body.success, r.body);
        }
        r = await request(server, 'GET', '/hub-api/my-planets/expenses');
        ok('rejected edits changed nothing', r.body.expenses[0].amount === 7225, r.body);

        await request(server, 'POST', '/hub-api/my-planets/expenses', { amount: 100, due_at: Date.now() + HOUR });
        r = await request(server, 'GET', '/hub-api/my-planets/expenses');
        ok('rows come back soonest-due first', r.body.expenses.length === 2 && r.body.expenses[0].amount === 100, r.body);

        // Another member sees none of it and cannot touch it.
        sessionUserId = bob;
        r = await request(server, 'GET', '/hub-api/my-planets/expenses');
        ok('another member sees none of them', r.body.expenses.length === 0, r.body);
        r = await request(server, 'PATCH', `/hub-api/my-planets/expenses/${blank.id}`, { amount: 1 });
        ok('another member cannot edit them', r.status === 404, r.body);
        r = await request(server, 'DELETE', `/hub-api/my-planets/expenses/${blank.id}`);
        ok('another member cannot delete them', r.status === 404, r.body);

        sessionUserId = alice;
        r = await request(server, 'DELETE', `/hub-api/my-planets/expenses/${blank.id}`);
        ok('the owner can remove one when done', r.status === 200 && r.body.success, r.body);
        r = await request(server, 'GET', '/hub-api/my-planets/expenses');
        ok('and it is gone', r.body.expenses.length === 1 && r.body.expenses[0].amount === 100, r.body);

        for (let i = 0; i < 19; i++) await request(server, 'POST', '/hub-api/my-planets/expenses', {});
        r = await request(server, 'POST', '/hub-api/my-planets/expenses', {});
        ok('a member is capped at 20 rows', r.status === 400 && /20/.test(r.body.error), r.body);
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch((err) => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
