// Research tracker: POST /hub-api/sync/science-research and the repository the Discord
// command reads.
//
// Run with: node src/routes/scienceResearch.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-science-research-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const usersRepo = require('../repositories/users');
const repo = require('../repositories/scienceResearch');
const router = require('./scienceResearch');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('scienceResearch.test.js');

let sessionUserId = 1;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: sessionUserId }; next(); });
app.use('/hub-api', router);

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

const sciences = (patch = {}) => ['Biology', 'Economy', 'Energy', 'Mathematics', 'Physics', 'Social']
    .map((science, i) => Object.assign({ science, level: 5 + i, active_seconds: null, queued: [] }, patch[science] || {}));

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        usersRepo.createUser('Researcher', 'not-a-real-hash', 'user', null);
        usersRepo.createUser('Quiet', 'not-a-real-hash', 'user', null);
        usersRepo.createUser('Ghost', 'not-a-real-hash', 'user', null); // no player row
        const me = usersRepo.getUserByGameName('Researcher');
        db.prepare(`INSERT INTO players (id, name) VALUES (401, 'researcher'), (402, 'Quiet'), (403, 'Bystander')`).run();

        console.log('\n── Refusals ' + '─'.repeat(64));
        sessionUserId = usersRepo.getUserByGameName('Ghost').id;
        let r = await request(server, 'POST', '/hub-api/sync/science-research', { sciences: sciences() });
        ok('an account with no player on record is a 404', r.status === 404, r.body);
        sessionUserId = me.id;
        r = await request(server, 'POST', '/hub-api/sync/science-research', {});
        ok('a missing sciences list is a 400', r.status === 400, r.body);
        r = await request(server, 'POST', '/hub-api/sync/science-research', { sciences: [{ science: 'Physics', level: 3 }, { science: 'Nonsense', level: 1 }] });
        ok('too few recognised sciences is a 400, not an empty snapshot', r.status === 400, r.body);

        console.log('\n── A read is stored against the session\'s own player ' + '─'.repeat(21));
        const before = Date.now();
        r = await request(server, 'POST', '/hub-api/sync/science-research', {
            player_id: 403, // ignored: a member can only report their own research
            science_rate: 250.5,
            sciences: sciences({
                Physics: { active_seconds: 3600, queued: [{ slot: '1', seconds: 3700, active: true }] },
                Energy: { queued: [{ slot: '2', seconds: 1800 }] },
            }),
        });
        ok('sync succeeds with two items', r.status === 200 && r.body.success && r.body.items === 2, r.body);
        const list = repo.listResearch();
        ok('one snapshot, for the session\'s player — not the one in the body', list.length === 1 && list[0].player_id === 401, list);
        const snap = list[0];
        ok('finish times are on the server clock and chained', snap.items[0].finishes_at_ms - snap.observed_at_ms === 3600 * 1000
            && snap.items[1].finishes_at_ms - snap.items[0].finishes_at_ms === 1800 * 1000 && snap.observed_at_ms >= before - 1000, snap.items);
        ok('levels and rate are kept', snap.levels.Physics === 9 && snap.science_rate === 250.5, snap);
        ok('lookup by name is case-insensitive', repo.findResearchByName('RESEARCHER') && repo.findResearchByName('RESEARCHER').player_id === 401);
        ok('an unknown name is null', repo.findResearchByName('Bystander') === null);
        const missing = repo.listMembersWithoutResearch();
        ok('active members who have not reported are listed; unmapped accounts are not', JSON.stringify(missing) === JSON.stringify(['Quiet']), missing);

        console.log('\n── A later read replaces the earlier one ' + '─'.repeat(34));
        r = await request(server, 'POST', '/hub-api/sync/science-research', { sciences: sciences() });
        const after = repo.listResearch();
        ok('still one row, now with nothing queued', after.length === 1 && after[0].items.length === 0, after);
    } finally {
        server.close();
    }
    console.log(failed ? `\n${failed} FAILED` : '\nall passed');
    process.exit(failed ? 1 : 0);
})();
