// The Trade Agreement Board and Schedule read every member's My Savings setup from the
// server: banking-planet income (total production only for a member who ticked none, and
// then flagged), what they marked as willing to sell, and their planned expenses as a total.
// Before 2026-09-27 only the viewer's own row used banking income, and only the viewer's own
// expenses were held back, so the Board showed other members' readiness wrong.
//
// Run with: node src/routes/board-my-savings.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-board-savings-test-')), 'test.db');
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

console.log('board-my-savings.test.js');

const alice = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('Alice', 'x', 'user')`).run().lastInsertRowid;
const bob = db.prepare(`INSERT INTO app_users (game_name, password_hash, role) VALUES ('Bob', 'x', 'user')`).run().lastInsertRowid;
db.prepare(`INSERT INTO players (id, name) VALUES (901, 'Alice'), (902, 'Bob')`).run();
db.prepare(`INSERT INTO app_settings (key, value) VALUES ('pp_price', '2')`).run();
// Alice: 1000 A$ + 500 PP, total production 100 PP/h, of which her ticked banking planet makes 30.
// Bob: 400 A$, total production 50 PP/h, never ticked a banking planet.
db.prepare(`INSERT INTO alliance_member_stats (player_id, astro_dollars, production_points, production_rate, hoarded_au) VALUES
    (901, '1000', '500', '100', 9000), (902, '400', '0', '50', 0)`).run();
db.prepare(`INSERT INTO planet_banking (game_planet_id, player_id, production_rate, banking) VALUES
    (1, 901, 30, 1), (2, 901, 70, 0), (3, 902, 50, 0)`).run();

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

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        // Alice sets up My Savings: sells a Supply Unit stock, and plans a 1,200 A$ expense.
        await request(server, 'POST', '/hub-api/sync/trade-inventory',
            { hoarded_au: 9000, astro_dollars: 1000, items: [{ name: 'Supply Unit', held: 6, unit_price: 650 }] });
        await request(server, 'PUT', '/hub-api/my-planets/sell-picks', { name: 'Supply Unit', picked: true, qty: null });
        let r = await request(server, 'POST', '/hub-api/my-planets/expenses', { amount: 1200 });
        ok('Alice adds a planned expense', r.body && r.body.success, r.body);

        // Bob looks at the Board: he must see Alice's setup, not his own view of her.
        session = { userId: bob, gameName: 'Bob' };
        r = await request(server, 'GET', '/hub-api/trade-agreements');
        const a = r.body.members.find(m => m.name === 'Alice');
        const b = r.body.members.find(m => m.name === 'Bob');
        ok('A$+PP unchanged: 1000 + 500 x 2', a.visible_au === 2000, a);
        ok('Alice\'s income is her banking planets only (30 PP/h x 2), not her total production', a.au_per_h === 60 && a.rate_estimated === false, a);
        ok('Bob ticked no banking planet: total production (50 x 2), flagged estimated', b.au_per_h === 100 && b.rate_estimated === true, b);
        ok('Alice\'s willing-to-sell value reaches another member\'s Board', a.sellable_au === 3900, a);
        ok('Alice\'s planned expenses reach it as a total', a.reserved_au === 1200, a);
        ok('Bob, with nothing set up, shows zeros', b.sellable_au === 0 && b.reserved_au === 0, b);

        r = await request(server, 'GET', '/hub-api/intel/trade-analysis');
        const sa = r.body.players.find(m => m.name === 'Alice');
        ok('the Schedule\'s data carries the same expense total', sa.reserved_au === 1200 && sa.sellable_au === 3900, sa);

        r = await request(server, 'GET', '/hub-api/my-planets/expenses');
        ok('Alice\'s expense rows themselves stay private to her', r.body.expenses.length === 0, r.body);
    } finally {
        server.close();
    }
    console.log(failed ? `\n${failed} FAILED` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
