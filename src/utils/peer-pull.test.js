// The inbound side: reading a partner hub that may be broken, out of date or hostile.
//
// What matters: a partner's address cannot be the game; a page is cut down to the fields
// we store; bad keys, bad and future timestamps are dropped; an older copy of an item never
// overwrites a newer one; a partner that answers "more" forever cannot loop us; a failed
// pull is recorded with its reason and keeps what we already had.
//
// No network: fetch is replaced with a scripted partner. Run with: node src/utils/peer-pull.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AWT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-peer-pull-test-')), 'test.db');
delete process.env.DISCORD_TOKEN;
delete process.env.PEER_ALLOW_HTTP;

const db = require('../database');
const peersRepo = require('../repositories/peers');
const { validateBaseUrl, validatePage, pullSource } = require('./peer-pull');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) console.log(`  ok - ${desc}`);
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

// A scripted partner: route(url) -> { status, body }.
function fakeFetch(route) {
    const calls = [];
    const fn = async (url, opts) => {
        calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
        const { status = 200, body } = route(new URL(url));
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: status >= 200 && status < 300, status, body: null, text: async () => text };
    };
    fn.calls = calls;
    return fn;
}

(async () => {
    console.log('peer-pull.test.js');

    // ─── addresses ───
    ok('https partner hub is accepted and normalised', validateBaseUrl('https://hub.example.org/awt/ ').url === 'https://hub.example.org/awt');
    ok('plain http is refused by default', !!validateBaseUrl('http://hub.example.org').error);
    ok('the game host is refused', !!validateBaseUrl('https://astrowars.games').error);
    ok('a game subdomain is refused', !!validateBaseUrl('https://redzone.astrowars.games').error);
    ok('credentials in the URL are refused', !!validateBaseUrl('https://user:pw@hub.example.org').error);
    ok('garbage is refused', !!validateBaseUrl('not a url').error);

    // ─── page validation ───
    const now = Date.parse('2026-10-10T00:00:00Z');
    const v = validatePage('players', {
        kind: 'players', more: false, next: '2026-10-01 00:00:00|5',
        items: [
            { key: '1', changedAt: '2026-10-01 00:00:00', data: { name: 'Ok', race_attack: '3', password_hash: 'x', country: 'XX' } },
            { key: 'DROP TABLE', changedAt: '2026-10-01 00:00:00', data: { name: 'BadKey' } },
            { key: '2', changedAt: 'yesterday', data: { name: 'BadTime' } },
            { key: '3', changedAt: '2027-01-01 00:00:00', data: { name: 'FromTheFuture' } },
            { key: '4', changedAt: '2026-10-01 00:00:00', data: 'not an object' },
            { key: '5', changedAt: '2026-10-01 00:00:00', data: { name: 'x'.repeat(5000), level: 1.5 } },
        ],
    }, now);
    ok('valid items are kept, the rest dropped and counted', v.items.length === 2 && v.dropped === 4, v);
    const it1 = v.items.find(i => i.key === '1');
    ok('unknown fields are stripped', it1 && !('password_hash' in it1.data) && !('country' in it1.data), it1);
    ok('numeric strings are coerced for int fields', it1 && it1.data.race_attack === 3, it1);
    const it5 = v.items.find(i => i.key === '5');
    ok('long text is capped and a non-integer int becomes null', it5 && it5.data.name.length === 200 && it5.data.level === null, it5);
    ok('a page for the wrong kind is an error', !!validatePage('players', { kind: 'systems', items: [] }).error);
    ok('a page without items is an error', !!validatePage('players', { kind: 'players' }).error);

    const fl = validatePage('fleet_locations', {
        kind: 'fleet_locations', more: false, next: null,
        items: [{ key: '7', changedAt: '2026-10-01 00:00:00', data: { owner_name: 'Foe',
            fleets: [{ rank: 1, cv: '900', system_id: 100, secret: 'x' }, 'junk', ...Array.from({ length: 30 }, (_, i) => ({ rank: i + 2 }))] } }],
    }, now);
    const flf = fl.items[0] && fl.items[0].data.fleets;
    ok('received fleet locations keep only listed fields, nested and capped', flf && flf.length === 15
        && flf[0].cv === 900 && !('secret' in flf[0]), flf && flf.slice(0, 2));
    const inc = validatePage('incomings', {
        kind: 'incomings', more: false, next: null,
        items: [{ key: '9', changedAt: '2026-10-01 00:00:00', data: { attacker_name: 'Foe', arrival_unix: 1790000000, covering: 'Someone' } }],
    }, now);
    ok('a received incoming drops fields outside the list', inc.items.length === 1 && inc.items[0].data.arrival_unix === 1790000000
        && !('covering' in inc.items[0].data), inc.items);

    // ─── pruning received intel ───
    const pruneSrc = peersRepo.createSource({ name: 'Prune', baseUrl: 'https://prune.example', token: 'awtp_' + 'p'.repeat(43) });
    const ago = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    for (const [kind, key, days] of [['fleet_locations', '1', 6], ['fleet_locations', '2', 1], ['incomings', '3', 11], ['incomings', '4', 3], ['players', '5', 90]]) {
        peersRepo.storePage(pruneSrc.id, kind, [{ key, changedAt: ago(days), data: {} }], null);
    }
    peersRepo.pruneIntel();
    const left = db.prepare(`SELECT item_key FROM peer_intel WHERE source_id = ? ORDER BY item_key`).all(pruneSrc.id).map(r => r.item_key).join();
    ok('stale fleet locations (5 d) and incomings (10 d) are pruned, profiles kept', left === '2,4,5', left);
    peersRepo.deleteSource(pruneSrc.id);

    // ─── pulling ───
    const tok = 'awtp_' + 'k'.repeat(43);
    const src = peersRepo.createSource({ name: 'Partner', baseUrl: 'https://partner.example', token: tok });

    let version = { name: 'Foe', points: 10, changedAt: '2026-10-02 00:00:00' };
    const partner = fakeFetch(u => {
        if (u.pathname === '/peer-api/v1/hello') return { body: { v: 1, kinds: ['players', 'secrets'] } };
        const after = u.searchParams.get('after');
        if (after) return { body: { kind: 'players', items: [], next: after, more: false } };
        return { body: { kind: 'players', items: [{ key: '20', changedAt: version.changedAt, data: { name: version.name, points: version.points } }], next: `${version.changedAt}|20`, more: false } };
    });
    const r1 = await pullSource(src.id, { fetchImpl: partner });
    ok('first pull stores the item', r1.ok && r1.received === 1, r1);
    ok('the token is sent as a bearer header', partner.calls.every(c => c.auth === `Bearer ${tok}`));
    ok('kinds we do not know are ignored, not requested', r1.kinds.join() === 'players' && !partner.calls.some(c => c.url.includes('secrets')), r1.kinds);
    ok('the cursor is saved', peersRepo.getSource(src.id).cursors.players === '2026-10-02 00:00:00|20');

    // An older copy arriving later (partner restored a backup, cursor reset by us) must not win.
    db.prepare(`UPDATE peer_sources SET cursors = '{}' WHERE id = ?`).run(src.id);
    version = { name: 'Foe (stale)', points: 1, changedAt: '2026-09-01 00:00:00' };
    await pullSource(src.id, { fetchImpl: partner });
    const held = peersRepo.queryIntel({ kind: 'players' })[0];
    ok('an older observation does not overwrite a newer one', held && held.data.points === 10, held);

    // A partner that says "more" forever with the same cursor.
    let loops = 0;
    const stuck = fakeFetch(u => {
        if (u.pathname.endsWith('/hello')) return { body: { kinds: ['players'] } };
        loops++;
        return { body: { kind: 'players', items: [], next: '2026-10-02 00:00:00|20', more: true } };
    });
    db.prepare(`UPDATE peer_sources SET cursors = json_object('players', '2026-10-02 00:00:00|20') WHERE id = ?`).run(src.id);
    const r3 = await pullSource(src.id, { fetchImpl: stuck });
    ok('a cursor that never moves stops after one page', r3.ok && loops === 1, { loops });

    // A partner that is down.
    const down = fakeFetch(() => ({ status: 503, body: { error: 'maintenance' } }));
    const r4 = await pullSource(src.id, { fetchImpl: down });
    const after4 = peersRepo.getSource(src.id);
    ok('a failed pull reports why', !r4.ok && /503/.test(r4.error) && /503/.test(after4.lastError), r4);
    ok('…and keeps what we already had', peersRepo.queryIntel({ kind: 'players' }).length === 1);

    const notJson = fakeFetch(() => ({ body: '<html>login</html>' }));
    const r5 = await pullSource(src.id, { fetchImpl: notJson });
    ok('an HTML answer (wrong address) is reported, not stored', !r5.ok && /JSON/.test(r5.error), r5);

    console.log(failed ? `\n${failed} FAILED` : '\nall passed');
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
