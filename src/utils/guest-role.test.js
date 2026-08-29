// Guest-role gating.
//
// Run with:  node src/utils/guest-role.test.js
//
// The 'guest' role has been selectable in the admin panel since the beginning and was
// never checked anywhere: requireAuth and requireAdmin were the only gates, so a guest
// account had exactly the same write access as a full member.
//
// The gate lives at the /hub-api mount rather than on each route, so these tests drive
// the middleware directly with fake request objects. That is the whole decision surface:
// the verb, the path, and the session role.

const path = require('path');
const mw = require(path.join(__dirname, '..', 'routes', '_middleware.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// Minimal express-shaped request/response.
function run(middleware, { method = 'GET', reqPath = '/anything', role = undefined, loggedIn = true } = {}) {
    const req = { method, path: reqPath, session: loggedIn ? { userId: 1, role } : undefined };
    const out = { nexted: false, status: null, body: null };
    const res = {
        status(code) { out.status = code; return this; },
        json(payload) { out.body = payload; return this; },
    };
    middleware(req, res, () => { out.nexted = true; });
    return out;
}

const asGuest = extra => run(mw.blockGuestWrites, { role: 'guest', ...extra });
const asUser = extra => run(mw.blockGuestWrites, { role: 'user', ...extra });
const asAdmin = extra => run(mw.blockGuestWrites, { role: 'admin', ...extra });

// ─── READS ────────────────────────────────────────────────────────────────────
console.log('── Guests keep full read access ' + '─'.repeat(44));
for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    ok(`${method} passes through`, asGuest({ method }).nexted === true);
}
for (const p of ['/intel/players', '/routes', '/plans/10', '/notes', '/me', '/search/player']) {
    ok(`GET ${p} passes through`, asGuest({ method: 'GET', reqPath: p }).nexted === true);
}

// ─── WRITES ───────────────────────────────────────────────────────────────────
console.log('\n── Guests are blocked on every mutating verb ' + '─'.repeat(31));
const writePaths = [
    '/sync/player', '/sync/system', '/sync/galaxy', '/sync/alliance', '/sync/alliance-stats',
    '/sync/alliance-search',
    '/sync/best-guarded', '/sync/trade-agreements', '/sync/trade-inventory',
    '/plans', '/notes', '/intel/takeover', '/trade-agreements/propose',
    '/routes', '/incoming/announce', '/incoming/cover', '/nuke',
    '/sync/player-list', '/sync/player-detail',
];
for (const p of writePaths) {
    const r = asGuest({ method: 'POST', reqPath: p });
    ok(`POST ${p} is 403`, r.nexted === false && r.status === 403, [r.nexted, r.status]);
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = asGuest({ method, reqPath: '/routes/1' });
    ok(`${method} is blocked`, r.nexted === false && r.status === 403, [r.nexted, r.status]);
}
const explained = asGuest({ method: 'POST', reqPath: '/plans' });
ok('the refusal explains itself in plain words', /Read-only account/.test(explained.body.error), explained.body);
ok('the refusal does not leak internals', !/role|session|middleware/i.test(explained.body.error), explained.body);

// ─── THE SAFE-POST ALLOWLIST ──────────────────────────────────────────────────
console.log('\n── POSTs that only compute stay open ' + '─'.repeat(39));
for (const p of ['/login', '/logout', '/routes/preview', '/incoming/defenders']) {
    ok(`POST ${p} passes through`, asGuest({ method: 'POST', reqPath: p }).nexted === true);
}
ok('the allowlist is exactly these four', mw.SAFE_POST_PATHS.size === 4, [...mw.SAFE_POST_PATHS]);
// The default has to be "blocked", or a new endpoint is unprotected until someone
// remembers this file exists.
ok('an unknown new endpoint is blocked by default',
    asGuest({ method: 'POST', reqPath: '/some/endpoint/added/next/week' }).nexted === false);
// Near-misses must not slip through the allowlist.
for (const p of ['/routes/preview/evil', '/login/x', '/incoming/defendersX']) {
    ok(`"${p}" does not match the allowlist`, asGuest({ method: 'POST', reqPath: p }).nexted === false);
}

// ─── EVERYONE ELSE IS UNAFFECTED ──────────────────────────────────────────────
console.log('\n── Users and admins are untouched ' + '─'.repeat(42));
for (const p of writePaths.slice(0, 6)) {
    ok(`user POST ${p} passes`, asUser({ method: 'POST', reqPath: p }).nexted === true);
    ok(`admin POST ${p} passes`, asAdmin({ method: 'POST', reqPath: p }).nexted === true);
}
ok('user DELETE passes', asUser({ method: 'DELETE', reqPath: '/plans/1/1' }).nexted === true);
ok('admin DELETE passes', asAdmin({ method: 'DELETE', reqPath: '/plans/1/1' }).nexted === true);

// ─── EDGE CASES ───────────────────────────────────────────────────────────────
console.log('\n── Edges ' + '─'.repeat(66));
// No session: this middleware must NOT answer. requireAuth owns that case and returns
// 401; turning it into a 403 would tell an anonymous caller the wrong thing.
const anon = run(mw.blockGuestWrites, { method: 'POST', reqPath: '/plans', loggedIn: false });
ok('an anonymous write is left to requireAuth (401), not turned into 403', anon.nexted === true);
const noRole = run(mw.blockGuestWrites, { method: 'POST', reqPath: '/plans', role: undefined });
ok('a session with no role recorded is not treated as a guest', noRole.nexted === true);

// A role nobody has defined yet is not a writer — deny by default.
const unknownRole = run(mw.blockGuestWrites, { method: 'POST', reqPath: '/plans', role: 'observer' });
ok('an unrecognised role cannot write', unknownRole.nexted === false && unknownRole.status === 403);

ok('isGuest is false for user/admin and true for guest',
    mw.isGuest({ session: { role: 'user' } }) === false &&
    mw.isGuest({ session: { role: 'admin' } }) === false &&
    mw.isGuest({ session: { role: 'guest' } }) === true);
ok('the writer set is exactly user and admin',
    mw.ROLES_THAT_MAY_WRITE.size === 2 && mw.ROLES_THAT_MAY_WRITE.has('user') && mw.ROLES_THAT_MAY_WRITE.has('admin'),
    [...mw.ROLES_THAT_MAY_WRITE]);

// requireWriteRole is the inline variant, for a route that wants the check locally.
console.log('\n── The inline variant ' + '─'.repeat(53));
ok('requireWriteRole blocks a guest regardless of verb',
    run(mw.requireWriteRole, { method: 'GET', reqPath: '/x', role: 'guest' }).status === 403);
ok('requireWriteRole passes a user', run(mw.requireWriteRole, { method: 'POST', reqPath: '/x', role: 'user' }).nexted === true);

// ─── THE GATE IS ACTUALLY MOUNTED ─────────────────────────────────────────────
// A perfect middleware that nobody calls protects nothing.
console.log('\n── The gate is wired in ' + '─'.repeat(51));
const fs = require('fs');
const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
ok('api.js requires the gate', /blockGuestWrites/.test(apiSrc));
const gateAt = apiSrc.indexOf('router.use(blockGuestWrites)');
const firstDomain = apiSrc.search(/router\.use\(require\(/);
ok('the gate is mounted', gateAt !== -1, gateAt);
ok('and it runs BEFORE every domain router', gateAt !== -1 && firstDomain !== -1 && gateAt < firstDomain, [gateAt, firstDomain]);

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
