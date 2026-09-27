// My Savings' "willing to sell anytime": the Trade inventory sync stores items one by one,
// a member picks what they would sell (all, or a number), and /intel/trade-analysis hands the
// Schedule each member's sellable_au. What matters: the value is capped by what is actually
// held, a pick of "all" follows the inventory, a member can only pick their own items, and an
// old or malformed sync never wipes the stored inventory.
//
// Run with: node src/routes/savings-sell-picks.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sell-picks-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const myPlanetsRouter = require('./myPlanets');
const tradeRouter = require('./trade');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('savings-sell-picks.test.js');

const alice = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('Alice', 'x', 'user')`).run().lastInsertRowid;
const bob = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('Bob', 'x', 'user')`).run().lastInsertRowid;
db.prepare(`INSERT INTO players (id, name) VALUES (901, 'Alice'), (902, 'Bob')`).run();

let session = { userId: alice, gameName: 'Alice' };
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { ...session }; next(); });
app.use('/hub-api', myPlanetsRouter);
app.use('/hub-api', tradeRouter);
app.use('/hub-api', intelRouter);

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

const as = (userId, gameName) => { session = { userId, gameName }; };
const sync = (server, items, extra = {}) => request(server, 'POST', '/hub-api/sync/trade-inventory',
    { hoarded_au: 0, astro_dollars: 0, items, ...extra });
const pick = (server, name, picked, qty) => request(server, 'PUT', '/hub-api/my-planets/sell-picks', { name, picked, qty });
async function sellableOf(server, name) {
    const r = await request(server, 'GET', '/hub-api/intel/trade-analysis');
    const p = (r.body.players || []).find(x => x.name === name);
    return p ? p.sellable_au : undefined;
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        as(alice, 'Alice');
        let r = await sync(server, [
            { name: 'Memory Jar', held: 3, unit_price: 7100 },
            { name: 'Supply Unit', held: 6, unit_price: 650 },
        ]);
        ok('inventory sync with items is accepted', r.status === 200 && r.body.stored, r.body);

        r = await request(server, 'GET', '/hub-api/my-planets/sell-picks');
        ok('items come back, nothing picked yet, most valuable first',
            r.body.success && r.body.items.map(i => `${i.name}:${i.held}:${i.picked}`).join() === 'Memory Jar:3:false,Supply Unit:6:false', r.body);
        ok('nothing picked -> sellable 0', await sellableOf(server, 'Alice') === 0);

        r = await pick(server, 'Supply Unit', true, null);
        ok('picking "all" supply units is saved', r.body.success && r.body.items.find(i => i.name === 'Supply Unit').picked, r.body);
        ok('all 6 x 650 counts', await sellableOf(server, 'Alice') === 3900);

        r = await pick(server, 'Memory Jar', true, 2);
        ok('2 of 3 memory jars add 14,200', await sellableOf(server, 'Alice') === 3900 + 14200);

        r = await pick(server, 'Memory Jar', true, 1.5);
        ok('a fractional quantity is refused', r.status === 400, r.body);
        r = await pick(server, 'Holy Grail', true, null);
        ok('an item not held cannot be picked', r.status === 404, r.body);

        console.log('\n── The inventory moves; the picks follow it ──');
        await sync(server, [{ name: 'Memory Jar', held: 1, unit_price: 7000 }, { name: 'Supply Unit', held: 8, unit_price: 600 }]);
        ok('a pick above what is held is capped (1 jar), "all" grows with the stock (8 SU), at the new prices',
            await sellableOf(server, 'Alice') === 7000 + 8 * 600);
        await sync(server, [{ name: 'Supply Unit', held: 8, unit_price: 600 }]);
        ok('an item sold since stops counting', await sellableOf(server, 'Alice') === 4800);

        r = await request(server, 'POST', '/hub-api/sync/trade-inventory', { hoarded_au: 10 });
        ok('an old client body without items keeps the stored inventory', await sellableOf(server, 'Alice') === 4800);
        r = await sync(server, [{ name: 'Supply Unit', held: -2, unit_price: 600 }]);
        ok('malformed items are ignored, not stored', await sellableOf(server, 'Alice') === 4800);

        r = await pick(server, 'Supply Unit', false);
        ok('unticking removes it', await sellableOf(server, 'Alice') === 0);
        await pick(server, 'Supply Unit', true, null);

        console.log('\n── One member, one set of picks ──');
        as(bob, 'Bob');
        await sync(server, [{ name: 'Ancient Relic', held: 1, unit_price: 100 }]);
        r = await pick(server, 'Supply Unit', true, null);
        ok('Bob cannot pick an item only Alice holds', r.status === 404, r.body);
        r = await request(server, 'GET', '/hub-api/my-planets/sell-picks');
        ok('Bob sees only his own inventory', r.body.items.length === 1 && r.body.items[0].name === 'Ancient Relic' && !r.body.items[0].picked, r.body);
        ok('Alice\'s picks still count for the Schedule, Bob\'s 0',
            await sellableOf(server, 'Alice') === 4800 && await sellableOf(server, 'Bob') === 0);
    } finally {
        server.close();
    }
    console.log(failed ? `\n${failed} FAILED` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
