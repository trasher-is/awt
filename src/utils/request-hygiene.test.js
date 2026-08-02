// Two production crashes, from the error log in the admin panel.
//
// Run with:  node src/utils/request-hygiene.test.js
//
//   TypeError: Cannot destructure property 'systems' of 'req.body' as it is undefined.
//       at /root/awt/src/routes/sync.js:444:13
//   Error: SQLITE_BUSY: database is locked   (×4)
//
// The first is reproducible with any POST whose Content-Type express.json() does not
// claim. The second is the session store failing to write while a sync transaction holds
// the lock on the same file.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const Database = require('better-sqlite3');

const { hubBody } = require('./hub-body');
const { splitSessionsDatabase, SESSION_TABLE, SESSION_SCHEMA } = require('./session-store');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// A request the REAL express.json() will read. Stubbing the parser here would test the
// wrapper against a fiction — the whole bug is in what express.json() does with a
// Content-Type it does not recognise, so it has to be the real one.
function fakeReq({ method = 'POST', url = '/sync/galaxy', headers = {}, body = null } = {}) {
    const req = new Readable({
        read() {
            if (body != null) this.push(Buffer.from(body));
            this.push(null);
        },
    });
    req.method = method;
    req.url = url;
    req.headers = Object.assign({}, headers);
    if (body != null && req.headers['content-length'] === undefined) {
        req.headers['content-length'] = String(Buffer.byteLength(body));
    }
    Object.defineProperty(req, 'path', { get: () => url.split('?')[0] });
    return req;
}

function drive(middleware, reqOptions) {
    return new Promise(resolve => {
        const req = fakeReq(reqOptions);
        const out = { status: null, payload: null, nexted: false };
        const res = {
            status(code) { out.status = code; return this; },
            json(payload) { out.payload = payload; resolve(Object.assign(out, { body: req.body })); return this; },
        };
        middleware(req, res, () => {
            out.nexted = true;
            resolve(Object.assign(out, { body: req.body }));
        });
    });
}

(async () => {
    const mw = hubBody({ syncLimit: '1mb', limit: '1kb' });

    console.log('── req.body is an object by the time a handler sees it ' + '─'.repeat(21));
    // Each of these reached src/routes/sync.js:444 and threw. Verified against the real
    // server before the fix: 500, with the stack trace in the response body.
    const cases = [
        ['proper JSON', { headers: { 'content-type': 'application/json' }, body: '{"systems":[1]}' }],
        ['no Content-Type at all', { body: '{"systems":[1]}' }],
        ['text/plain, as sendBeacon sends', { headers: { 'content-type': 'text/plain' }, body: '{"systems":[1]}' }],
        ['form encoding', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'systems=1' }],
        ['no body at all', {}],
        ['an empty JSON body', { headers: { 'content-type': 'application/json' }, body: '' }],
    ];
    for (const [label, opts] of cases) {
        const r = await drive(mw, opts);
        ok(`${label}: passes through with an object body`,
            r.nexted === true && r.body !== null && typeof r.body === 'object', [label, r.status, r.body]);
    }

    const parsed = await drive(mw, { headers: { 'content-type': 'application/json' }, body: '{"systems":[1,2]}' });
    ok('a real JSON body still arrives parsed, not swallowed',
        Array.isArray(parsed.body.systems) && parsed.body.systems.length === 2, parsed.body);

    console.log('\n── Broken requests get an answer a fetch() caller can read ' + '─'.repeat(17));
    // Express's default error page is HTML and, on a 500, contains the stack trace and
    // absolute server paths. POST /hub-api/login is reachable without logging in.
    const malformed = await drive(mw, { headers: { 'content-type': 'application/json' }, body: '{"systems": [1,' });
    ok('malformed JSON is 400, not a crash', malformed.status === 400 && malformed.nexted === false, malformed);
    ok('and the answer is JSON', malformed.payload && /not valid JSON/.test(malformed.payload.error), malformed.payload);
    ok('with no stack trace in it', !/at\s+\/|node_modules/.test(JSON.stringify(malformed.payload)), malformed.payload);

    const huge = await drive(mw, {
        url: '/plans',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'x'.repeat(4000) }),
    });
    ok('an oversized body is 413, not a crash', huge.status === 413 && huge.nexted === false, [huge.status, huge.payload]);

    console.log('\n── The sync ceiling is still bigger than everything else ' + '─'.repeat(18));
    const bigSync = await drive(mw, {
        url: '/sync/galaxy',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ systems: Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'x'.repeat(20), x: i, y: -i })) }),
    });
    ok('a galaxy-sized payload passes on /sync/*', bigSync.nexted === true, [bigSync.status, bigSync.payload]);
    const sameOnPlans = await drive(mw, {
        url: '/plans',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ systems: Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'x'.repeat(20), x: i, y: -i })) }),
    });
    ok('and the same payload is refused everywhere else', sameOnPlans.status === 413, sameOnPlans.status);

    console.log('\n── No handler under /hub-api destructures req.body unguarded any more ' + '─'.repeat(6));
    // The middleware makes them safe, but this counts what would break if it were ever
    // removed — and shows the number in the commit message is real.
    const routesDir = path.join(__dirname, '..', 'routes');
    let destructures = 0;
    for (const f of fs.readdirSync(routesDir).filter(n => n.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
        destructures += (src.match(/const\s*\{[^}]*\}\s*=\s*req\.body(?!\s*\|\||\s*\?\?)/g) || []).length;
    }
    ok('the mount point is what protects them, and there are many', destructures > 0, destructures);
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    ok('server.js mounts hubBody on /hub-api', /app\.use\('\/hub-api', hubBody\(/.test(serverSrc));
    ok('and no longer mounts a bare express.json there',
        !/app\.use\('\/hub-api',\s*\(req, res, next\) => \(req\.path\.startsWith\('\/sync'\)/.test(serverSrc));

    console.log('\n── Sessions move out of the intel database without logging anyone out ' + '─'.repeat(6));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sessions-'));
    const legacy = path.join(tmp, 'awt.db');
    const target = path.join(tmp, 'sessions.db');
    const NOW = 1785000000000;

    const src = new Database(legacy);
    src.exec(SESSION_SCHEMA);
    src.exec('CREATE TABLE systems (id INTEGER PRIMARY KEY, name TEXT)');
    const ins = src.prepare(`INSERT INTO ${SESSION_TABLE} VALUES (?, ?, ?)`);
    ins.run('live-1', NOW + 86400000, '{"userId":1}');
    ins.run('live-2', NOW + 3600000, '{"userId":2}');
    ins.run('expired', NOW - 3600000, '{"userId":3}');
    src.exec(`INSERT INTO systems VALUES (7, 'Achird')`);
    src.close();

    const r1 = splitSessionsDatabase(legacy, target, { now: NOW });
    ok('the split reports what it did', r1.action === 'split', r1);
    ok('live sessions are carried over', r1.copied === 2, r1);

    const moved = new Database(target, { readonly: true });
    const sids = moved.prepare(`SELECT sid FROM ${SESSION_TABLE} ORDER BY sid`).all().map(r => r.sid);
    moved.close();
    ok('the surviving sids are the unexpired ones', sids.join(',') === 'live-1,live-2', sids);
    ok('an expired session is not carried over', !sids.includes('expired'), sids);

    const stillThere = new Database(legacy, { readonly: true });
    const legacyCount = stillThere.prepare(`SELECT COUNT(*) n FROM ${SESSION_TABLE}`).get().n;
    const intelIntact = stillThere.prepare(`SELECT name FROM systems WHERE id = 7`).get().name;
    stillThere.close();
    ok('nothing is deleted from awt.db, so reverting the commit restores the old behaviour',
        legacyCount === 3, legacyCount);
    ok('and the intel tables are untouched', intelIntact === 'Achird', intelIntact);

    const r2 = splitSessionsDatabase(legacy, target, { now: NOW });
    ok('running again is a no-op — it must not re-copy on every boot', r2.action === 'already-split', r2);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sessions-'));
    ok('a first-ever install has nothing to move',
        splitSessionsDatabase(path.join(fresh, 'awt.db'), path.join(fresh, 'sessions.db')).action === 'no-legacy-database');

    const noTable = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sessions-'));
    const bare = new Database(path.join(noTable, 'awt.db'));
    bare.exec('CREATE TABLE systems (id INTEGER PRIMARY KEY)');
    bare.close();
    ok('a database with no sessions table is handled',
        splitSessionsDatabase(path.join(noTable, 'awt.db'), path.join(noTable, 'sessions.db')).action === 'no-legacy-sessions');

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sessions-'));
    fs.writeFileSync(path.join(broken, 'awt.db'), 'this is not a database');
    const r3 = splitSessionsDatabase(path.join(broken, 'awt.db'), path.join(broken, 'sessions.db'));
    ok('an unreadable database does not stop the app from starting',
        r3.action === 'legacy-unreadable' && r3.copied === 0, r3);

    ok('server.js points the store at the new file',
        /new SQLiteStore\(\{ db: 'sessions\.db'/.test(serverSrc));
    ok('and no longer at awt.db', !/new SQLiteStore\(\{ db: 'awt\.db'/.test(serverSrc));

    for (const dir of [tmp, fresh, noTable, broken]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* best effort */ }
    }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
