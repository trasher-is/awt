// Route-level coverage for /intel/battle-reports-search — the Battle Reports panel's
// search box and sortable columns (search + sort by CV/population). The repository-level
// logic (battleReportsRepo.searchBattleReportsFeed) has its own thorough unit coverage in
// battleReports.test.js; this file exists to confirm the route actually wires query
// params through correctly (clamping, defaults, the total-vs-page-size contract) rather
// than duplicating those checks at the HTTP layer.
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-review-only';
delete process.env.DISCORD_TOKEN;

const http = require('http');
const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) console.log(`  ok - ${desc}`);
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`); }
}

const app = express();
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', intelRouter);

function request(server, path) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port, path }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (950, 'Route Test System', 5, 5)`).run();
db.prepare(`
    INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_name, att_alliance_tag, def_player_name, att_lost_cv, def_lost_cv, killed_population)
    VALUES
        (9900, '2026-09-01T10:00:00Z', 950, 1, 'RouteAttacker', 'RTA', 'RouteDefenderSmall', 5, 3, 1),
        (9901, '2026-09-01T11:00:00Z', 950, 2, 'RouteAttacker2', 'RTB', 'RouteDefenderBig', 200, 50, 90)
`).run();

(async () => {
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));

    try {
        console.log('── /intel/battle-reports-search: defaults and basic shape ' + '─'.repeat(16));
        const noQuery = await request(server, '/hub-api/intel/battle-reports-search');
        ok('succeeds (200) with no query params at all', noQuery.status === 200, noQuery);
        ok('defaults to occurred_at desc — the most recent row leads',
            noQuery.body.feed[0].battle_report_id === 9901, noQuery.body.feed.slice(0, 2));
        ok('reports a total alongside the page', typeof noQuery.body.total === 'number' && noQuery.body.total >= 2, noQuery.body);

        console.log('\n── sort + dir query params ' + '─'.repeat(46));
        const byCv = await request(server, '/hub-api/intel/battle-reports-search?sort=cv&dir=desc');
        ok('sort=cv puts the bigger battle (200+50) first', byCv.body.feed[0].battle_report_id === 9901, byCv.body.feed.slice(0, 2));

        const byCvAsc = await request(server, '/hub-api/intel/battle-reports-search?sort=cv&dir=asc');
        ok('dir=asc reverses it — the smaller battle (5+3) first among these two',
            byCvAsc.body.feed.find(r => r.system_id === 950).battle_report_id === 9900, byCvAsc.body.feed);

        const byPop = await request(server, '/hub-api/intel/battle-reports-search?sort=pop&dir=desc');
        ok('sort=pop puts the 90-population battle first', byPop.body.feed[0].battle_report_id === 9901, byPop.body.feed.slice(0, 2));

        console.log('\n── search (q) ' + '─'.repeat(59));
        const search = await request(server, '/hub-api/intel/battle-reports-search?q=RouteDefenderSmall');
        ok('q matches the defender name and excludes the non-matching row',
            search.body.feed.some(r => r.battle_report_id === 9900) && !search.body.feed.some(r => r.battle_report_id === 9901),
            search.body.feed);

        const noMatch = await request(server, '/hub-api/intel/battle-reports-search?q=DefinitelyNobodyByThisName');
        ok('a search with no matches returns success with an empty feed, not an error',
            noMatch.status === 200 && noMatch.body.total === 0 && noMatch.body.feed.length === 0, noMatch.body);

        console.log('\n── param validation and clamping ' + '─'.repeat(40));
        const badSort = await request(server, '/hub-api/intel/battle-reports-search?sort=nonsense');
        ok('an unrecognized sort key falls back to occurred_at instead of erroring',
            badSort.status === 200 && badSort.body.feed[0].battle_report_id === 9901, badSort.body);

        const hugeLimit = await request(server, '/hub-api/intel/battle-reports-search?limit=99999');
        ok('limit is clamped to the route\'s own ceiling (500), not passed through raw',
            hugeLimit.status === 200 && hugeLimit.body.feed.length <= 500, hugeLimit.body.feed.length);

        const negativeOffset = await request(server, '/hub-api/intel/battle-reports-search?offset=-50');
        ok('a negative offset is clamped to 0 rather than erroring', negativeOffset.status === 200, negativeOffset);
    } finally {
        server.close();
    }

    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch(err => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
