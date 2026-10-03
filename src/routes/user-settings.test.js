// GET/POST /hub-api/settings — a member's own switches for the hub's extras and sidebar tools.
//
// What matters here: nothing is stored until a default is changed, a change merges into what
// is stored (a phone and a desktop must not wipe each other), a bad payload stores nothing,
// one member's choices never reach another's, and a read-only guest can still use it — it
// writes only their own row.
//
// Run with: node src/routes/user-settings.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-user-settings-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const { blockGuestWrites } = require('./_middleware');
const settingsRouter = require('./userSettings');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('user-settings.test.js');

usersRepo.createUser('Alice', 'hash1', 'user', null);
usersRepo.createUser('Bob', 'hash2', 'user', null);
usersRepo.createUser('Greta', 'hash3', 'guest', null);
const alice = usersRepo.getUserByGameName('Alice');
const bob = usersRepo.getUserByGameName('Bob');
const greta = usersRepo.getUserByGameName('Greta');

// Whoever the next request comes from. null = not logged in.
let session = null;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = session ? { ...session } : undefined; next(); });
// The same guard api.js puts in front of every router.
app.use('/hub-api', blockGuestWrites, settingsRouter);
// A body that is not JSON: express.json raises; answer it quietly instead of printing a stack.
app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, error: 'bad request' }));

const as = (u, role = 'user') => { session = u ? { userId: u.id, gameName: u.game_name, role } : null; };

function request(server, method, urlPath, body) {
    const { port } = server.address();
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const stored = u => usersRepo.getUiSettings(u.id);
// Key order is not part of the contract: the server answers in catalogue order.
const canon = v => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort()) : val));
const same = (a, b) => canon(a) === canon(b);

(async () => {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const get = () => request(server, 'GET', '/hub-api/settings');
    const post = body => request(server, 'POST', '/hub-api/settings', body);

    // ─── Migration ────────────────────────────────────────────────────────────
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all().map(c => c.name);
    ok('app_users has the ui_settings column', cols.includes('ui_settings'));
    ok('a new account stores nothing (NULL = all defaults)', stored(alice) === null);

    // ─── Auth ─────────────────────────────────────────────────────────────────
    as(null);
    ok('GET without a session is 401', (await get()).status === 401);
    ok('POST without a session is 401', (await post({ changes: { 'inject.suButtons': false } })).status === 401);
    ok('and stored nothing', stored(alice) === null);

    // ─── Defaults ─────────────────────────────────────────────────────────────
    as(alice);
    let r = await get();
    ok('GET answers 200 with success', r.status === 200 && r.body.success === true, r);
    ok('nothing changed: overrides are empty', same(r.body.overrides, {}), r.body.overrides);
    ok('the four experimental tools start off', ['tool.battleCalc', 'tool.roadToTa', 'tool.buildOrder', 'tool.empireSim'].every(k => r.body.settings[k] === false), r.body.settings);
    ok('every extra and the other tools start on', Object.entries(r.body.settings).filter(([k]) => !['tool.battleCalc', 'tool.roadToTa', 'tool.buildOrder', 'tool.empireSim'].includes(k)).every(([, v]) => v === true));

    // ─── A change ─────────────────────────────────────────────────────────────
    r = await post({ changes: { 'inject.suButtons': false, 'tool.battleCalc': true } });
    ok('POST a change answers 200', r.status === 200 && r.body.success === true, r);
    ok('the answer carries the new state', same(r.body.overrides, { 'inject.suButtons': false, 'tool.battleCalc': true }), r.body.overrides);
    ok('resolved settings follow', r.body.settings['inject.suButtons'] === false && r.body.settings['tool.battleCalc'] === true && r.body.settings['inject.buildingHints'] === true);
    ok('it is stored as only the difference', same(JSON.parse(stored(alice)), { 'inject.suButtons': false, 'tool.battleCalc': true }), stored(alice));
    ok('GET reads it back', same((await get()).body.overrides, { 'inject.suButtons': false, 'tool.battleCalc': true }));

    // ─── Merge, not replace ───────────────────────────────────────────────────
    r = await post({ changes: { 'inject.popTimers': false } });
    ok('a second change keeps the first (two devices must not wipe each other)', same(r.body.overrides, { 'inject.suButtons': false, 'tool.battleCalc': true, 'inject.popTimers': false }), r.body.overrides);

    // ─── Back to the default ──────────────────────────────────────────────────
    r = await post({ changes: { 'inject.suButtons': true } });
    ok('turning one back on removes it from what is stored', same(r.body.overrides, { 'tool.battleCalc': true, 'inject.popTimers': false }), r.body.overrides);
    r = await post({ changes: { 'tool.battleCalc': false, 'inject.popTimers': true } });
    ok('with every switch back at its default the column is NULL again', same(r.body.overrides, {}) && stored(alice) === null, stored(alice));

    // ─── Bad input stores nothing ─────────────────────────────────────────────
    await post({ changes: { 'inject.suButtons': false } });
    const before = stored(alice);
    for (const [label, body] of [
        ['a non-boolean value', { changes: { 'inject.popTimers': 'false' } }],
        ['a number', { changes: { 'inject.popTimers': 0 } }],
        ['a null', { changes: { 'inject.popTimers': null } }],
        ['changes as an array', { changes: [true] }],
        ['changes as a string', { changes: 'inject.popTimers' }],
        ['no changes at all', {}],
        ['reset that is not literally true', { reset: 'yes' }],
    ]) {
        r = await post(body);
        ok(`${label} is a 400`, r.status === 400 && r.body.success === false && typeof r.body.error === 'string', r);
        ok(`${label} stores nothing`, stored(alice) === before, stored(alice));
    }
    r = await request(server, 'POST', '/hub-api/settings', '{ not json');
    ok('a body that is not JSON is a 400 and stores nothing', r.status === 400 && stored(alice) === before, r.status);

    // A stale tab may still send a key a later release removed: ignore it, keep the rest.
    r = await post({ changes: { 'inject.gone': false, 'inject.popTimers': false } });
    ok('an unknown key is dropped while the known one is kept', r.status === 200 && same(r.body.overrides, { 'inject.suButtons': false, 'inject.popTimers': false }), r.body.overrides);
    ok('the unknown key never reaches the database', !/gone/.test(stored(alice)), stored(alice));

    // ─── Reset ────────────────────────────────────────────────────────────────
    r = await post({ reset: true });
    ok('reset empties it', r.status === 200 && same(r.body.overrides, {}) && stored(alice) === null, r);

    // ─── Isolation ────────────────────────────────────────────────────────────
    await post({ changes: { 'inject.suButtons': false } });
    as(bob);
    r = await get();
    ok('another member does not see it', same(r.body.overrides, {}) && r.body.settings['inject.suButtons'] === true, r.body);
    await post({ changes: { 'tool.buildOrder': true } });
    ok('and their change is their own', stored(bob) !== null && JSON.parse(stored(bob))['tool.buildOrder'] === true && !('tool.buildOrder' in JSON.parse(stored(alice))));
    as(alice);
    ok('the first member is untouched', same((await get()).body.overrides, { 'inject.suButtons': false }));

    // ─── Corrupt stored data ──────────────────────────────────────────────────
    db.prepare(`UPDATE app_users SET ui_settings = ? WHERE id = ?`).run('{ this is not json', alice.id);
    r = await get();
    ok('a corrupt stored value reads as the defaults, not a 500', r.status === 200 && same(r.body.overrides, {}), r);
    r = await post({ changes: { 'inject.popTimers': false } });
    ok('and the next save repairs it', r.status === 200 && same(JSON.parse(stored(alice)), { 'inject.popTimers': false }), stored(alice));
    db.prepare(`UPDATE app_users SET ui_settings = ? WHERE id = ?`).run(JSON.stringify({ 'inject.gone': false, 'inject.suButtons': 'no', 'tool.battleCalc': true }), alice.id);
    ok('stored junk keys and values are filtered on the way out', same((await get()).body.overrides, { 'tool.battleCalc': true }));

    // ─── Guests ───────────────────────────────────────────────────────────────
    as(greta, 'guest');
    r = await post({ changes: { 'tool.roadToTa': true } });
    ok('a read-only guest can save their own switches', r.status === 200 && same(r.body.overrides, { 'tool.roadToTa': true }), r);
    ok('it is their own row that changed', same(JSON.parse(stored(greta)), { 'tool.roadToTa': true }) && stored(bob) !== stored(greta));
    ok('a guest can read them back', same((await get()).body.overrides, { 'tool.roadToTa': true }));

    // The allowlist entry opens exactly /settings: a near-miss is still a guest write.
    r = await request(server, 'POST', '/hub-api/settings/extra', { changes: {} });
    ok('a path that merely starts with /settings is still blocked for guests', r.status === 403, r.status);

    // ─── The row of a deleted account ─────────────────────────────────────────
    as({ id: 987654, game_name: 'Ghost' });
    r = await post({ changes: { 'inject.popTimers': false } });
    ok('a session whose account no longer exists is told so, not told "saved"', r.status === 404 && r.body.success === false, r);
    ok('and reading for it just gives the defaults', same((await get()).body.overrides, {}));

    server.close();
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
