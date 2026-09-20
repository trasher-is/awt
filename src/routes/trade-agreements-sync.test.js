// Trade Agreements completion sync + reconciliation (2026-09-20): POST
// /hub-api/sync/trade-agreements. The body is every partner currently listed on the
// logged-in member's own /Game/Trade/Agreements page — a complete, current snapshot of
// their real agreements, regardless of that row's exact Status text (this alliance's own
// rule: any name listed means at least one side already sent money, so it's "done").
//
// This file's focus is the reconciliation half: a 'done' pair whose partner has dropped
// off that list (declined before completing, or the partner resigned) must be cleared so
// the Board stops showing it as done and that member starts saving again — but only
// 'done' pairs. A 'proposed'/'confirmed' Board-only intent that never got an in-game offer
// sent yet must survive an empty/unrelated sync.
//
// Run with: node src/routes/trade-agreements-sync.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-ta-sync-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const tradeRouter = require('./trade');
const tradeRepo = require('../repositories/trade');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('trade-agreements-sync.test.js');

let sessionGameName = 'caveman';
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: sessionGameName }; next(); });
app.use('/hub-api', tradeRouter);

function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', (c) => raw += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { /* non-JSON body */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const statusOf = (pairKey) => { const row = tradeRepo.getAgreementStatusByPairKey(pairKey); return row ? row.status : null; };

(async () => {
    const server = app.listen(0);
    try {
        console.log('\n── A listed partner is marked done ' + '─'.repeat(41));
        let r = await request(server, 'POST', '/hub-api/sync/trade-agreements', { partners: ['bob'] });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        ok('caveman|bob is done', statusOf('bob|caveman') === 'done', statusOf('bob|caveman'));

        console.log('\n── A second, unrelated done pair for the same member ' + '─'.repeat(23));
        tradeRepo.markAgreementDoneByInitiator('carol|caveman', 'carol', 'caveman', 'caveman');
        ok('caveman|carol starts done', statusOf('carol|caveman') === 'done', statusOf('carol|caveman'));

        console.log('\n── Re-syncing with only "bob" clears the "carol" pair, leaves "bob" alone ' + '─'.repeat(2));
        r = await request(server, 'POST', '/hub-api/sync/trade-agreements', { partners: ['bob'] });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        ok('bob is still done — still listed', statusOf('bob|caveman') === 'done', statusOf('bob|caveman'));
        ok('carol is cleared — no longer listed (declined, or resigned)', statusOf('carol|caveman') === null, statusOf('carol|caveman'));

        console.log('\n── An empty sync ("No Agreements!") clears every done pair of mine ' + '─'.repeat(8));
        r = await request(server, 'POST', '/hub-api/sync/trade-agreements', { partners: [] });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        ok('bob is cleared too once nothing is listed at all', statusOf('bob|caveman') === null, statusOf('bob|caveman'));

        console.log('\n── A proposed/confirmed pair (no in-game offer sent yet) survives an unrelated sync ' + '─'.repeat(0));
        tradeRepo.proposeAgreement('caveman|dave', 'caveman', 'dave', 'caveman');
        const daveId = tradeRepo.getActiveAgreements().find(a => a.pair_key === 'caveman|dave').id;
        tradeRepo.confirmAgreement(daveId);
        ok('dave is confirmed, not done', statusOf('caveman|dave') === 'confirmed', statusOf('caveman|dave'));
        r = await request(server, 'POST', '/hub-api/sync/trade-agreements', { partners: ['bob'] });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        ok('the confirmed-but-not-done pair is untouched by reconciliation', statusOf('caveman|dave') === 'confirmed', statusOf('caveman|dave'));

        console.log('\n── Reconciliation only looks at pairs the syncing member is party to ' + '─'.repeat(7));
        tradeRepo.markAgreementDoneByScan('erin|frank', 'erin', 'frank');
        r = await request(server, 'POST', '/hub-api/sync/trade-agreements', { partners: [] });
        ok('sync succeeds', r.status === 200 && r.body.success, r.body);
        ok('a done pair between two other members is untouched', statusOf('erin|frank') === 'done', statusOf('erin|frank'));
    } finally {
        server.close();
    }

    console.log('\n' + '─'.repeat(77));
    console.log(failed === 0 ? 'All checks passed' : `${failed} check(s) failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
