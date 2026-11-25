// Names members enter for a player: the real database and HTTP boundary, invented names.
//
// Run with: node src/routes/knownNames.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-known-names-'));
process.env.AWT_DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const router = require('./knownNames');
const { blockGuestWrites } = require('./_middleware');

let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const SESSIONS = {
    ann: { userId: 11, gameName: 'Ann', role: 'user' },
    bob: { userId: 12, gameName: 'Bob', role: 'user' },
    admin: { userId: 1, gameName: 'admin', role: 'admin' },
    guest: { userId: 13, gameName: 'Guest', role: 'guest' },
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = SESSIONS[req.headers['x-test-user']]; next(); });
app.use('/hub-api', blockGuestWrites, router);
db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Nova'), (2, 'Comet')`).run();

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    async function call(user, method, id, { nameId, name } = {}) {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/hub-api/intel/player/${id}/known-names${nameId ? `/${nameId}` : ''}`, {
            method, headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Test-User': user } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify({ name }) } : {}),
        });
        return { status: res.status, body: await res.json() };
    }
    try {
        for (const method of ['GET', 'POST']) {
            ok(`${method} requires a login`, (await call(null, method, 1, { name: 'x' })).status === 401);
            ok(`${method} rejects a malformed player id`, (await call('ann', method, '1abc', { name: 'x' })).status === 400);
        }
        ok('DELETE requires a login', (await call(null, 'DELETE', 1, { nameId: 1 })).status === 401);
        ok('a guest cannot add a name', (await call('guest', 'POST', 1, { name: 'x' })).status === 403);

        let r = await call('ann', 'POST', 1, { name: '  Star \n  Dust ' });
        ok('a name is saved, with its whitespace tidied and who added it',
            r.status === 200 && r.body.names.length === 1 && r.body.names[0].name === 'Star Dust' && r.body.names[0].addedBy === 'Ann', r);
        const id = r.body.names[0].id;
        ok('the same name in other letter case is a duplicate', (await call('bob', 'POST', 1, { name: 'STAR DUST' })).status === 409);
        ok('the same name on another player is fine', (await call('bob', 'POST', 2, { name: 'Star Dust' })).status === 200);
        for (const bad of ['', '   ', undefined, 5, 'x'.repeat(51)])
            ok(`rejected: ${JSON.stringify(bad)?.slice(0, 12)}`, (await call('ann', 'POST', 1, { name: bad })).status === 400);
        ok('an unknown player is 404', (await call('ann', 'POST', 999, { name: 'x' })).status === 404);

        r = await call('guest', 'GET', 1);
        ok('a guest can read the list, and is offered no Remove', r.status === 200 && r.body.names[0].canRemove === false, r);
        ok('another member is offered no Remove', (await call('bob', 'GET', 1)).body.names[0].canRemove === false);
        ok('the member who added it and an admin are', (await call('ann', 'GET', 1)).body.names[0].canRemove === true
            && (await call('admin', 'GET', 1)).body.names[0].canRemove === true);

        ok('another member cannot remove it', (await call('bob', 'DELETE', 1, { nameId: id })).status === 403);
        ok('a guest cannot remove it', (await call('guest', 'DELETE', 1, { nameId: id })).status === 403);
        ok('a name id of another player does not match', (await call('admin', 'DELETE', 2, { nameId: id })).status === 404);
        r = await call('ann', 'DELETE', 1, { nameId: id });
        ok('the member who added it can remove it', r.status === 200 && r.body.names.length === 0, r);
        ok('removing it again is 404', (await call('ann', 'DELETE', 1, { nameId: id })).status === 404);
        const other = (await call('admin', 'GET', 2)).body.names[0].id;
        ok('an admin can remove anyone\'s', (await call('admin', 'DELETE', 2, { nameId: other })).status === 200);
    } finally {
        server.close();
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`knownNames.test.js: ${failed} failures`);
    process.exit(failed ? 1 : 0);
})();
