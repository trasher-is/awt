// Synthetic archive integration checks: real schema, repository, authenticated Express
// routes and downloaded payloads. Never opens the operator database or calls the game.
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-export-test';
const originalLog = console.log;
let db;
try {
    console.log = () => {};
    db = require('../database');
} finally { console.log = originalLog; }
const express = require('express');
const repo = require('../repositories/battleReports');
const { serializeBattleReportExport } = require('./battle-report-export');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ok - ${name}`); }
    else { fail++; console.error(`  NOT OK - ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`); }
}
const ids = rows => rows.map(row => row.battle_report_id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Parse CSV independently, including CRLF/newlines/quotes inside quoted text.
function parseCsv(text) {
    const rows = []; let row = [], value = '', quoted = false;
    const input = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (quoted) {
            if (char === '"' && input[i + 1] === '"') { value += '"'; i++; }
            else if (char === '"') quoted = false;
            else value += char;
        } else if (char === '"') quoted = true;
        else if (char === ',') { row.push(value); value = ''; }
        else if (char === '\r' && input[i + 1] === '\n') {
            row.push(value); rows.push(row); row = []; value = ''; i++;
        } else value += char;
    }
    return rows;
}

let server;
(async () => {
try {
    db.exec(`
        INSERT INTO systems (id, name) VALUES (1, 'Synthetic Orbit'), (2, 'Synthetic Quiet');
        INSERT INTO players (id, name) VALUES (11, 'Synthetic Owner');
        INSERT INTO planets (system_id, planet_index, owner_id) VALUES (1, 1, 11), (2, 1, 11);
        INSERT INTO battle_reports (id, started_at, system_id, planet_index, att_player_name,
            def_player_name, att_alliance_tag, att_combat_value, def_combat_value,
            att_lost_cv, def_lost_cv, killed_population, att_destroyers, att_destroyers_lost, random_number)
        VALUES (101, '2026-09-01T13:00:00+02:00', 1, 1, 'Synthetic Alpha', 'Synthetic Owner',
            'SYN', 200, 100, 25, 10, 4, 20, 2, 0.15),
            (102, '2026-09-01T11:30:00Z', 1, 1, 'Synthetic Beta', 'Synthetic Owner',
            'OTH', 100, 200, 10, 30, 0, NULL, NULL, 0.82),
            (103, '2026-09-02T12:00:00Z', NULL, NULL, 'Synthetic Unlocated', NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            (104, '2026-09-01T09:00:00Z', 999, 1, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
        INSERT INTO planet_events (system_id, planet_index, event_type_id, old_value, new_value, timestamp)
        VALUES (1, 1, 2, '100', '96', '2026-09-01 11:15:00'),
            (2, 1, 2, '80', '73', '2026-09-01 15:00:00');
    `);
    const full = repo.getBattleReportsExport({ scope: 'all' });
    ok('all scope includes unlocated reports and excludes population observations',
        full.rows.length === 4 && full.rows.every(row => row.record_type === 'battle_report') && ids(full.rows).includes(103));
    const stored = db.prepare('SELECT * FROM battle_reports WHERE id=101').get();
    const exported = full.rows.find(row => row.id === 101);
    ok('all raw report fields retain their exact stored values',
        Object.keys(stored).every(key => exported[key] === stored[key]), exported);
    ok('all current schema fields have CSV headers', Object.keys(stored).every(key => full.columns.includes(key)));
    ok('all scope ignores search filters', repo.getBattleReportsExport({ scope: 'all', q: 'absent' }).rows.length === 4);
    const filtered = repo.getBattleReportsExport({ scope: 'filtered' }).rows;
    ok('unfiltered current results include an unnamed report and the unmatched drop',
        same(ids(filtered), [null, 102, 101, 104]), ids(filtered));
    ok('matched population observations do not duplicate real reports',
        filtered.filter(row => row.record_type === 'population_drop').length === 1);
    const drop = filtered.find(row => row.record_type === 'population_drop');
    ok('drop records identify the source and preserve observations without invented report fields',
        drop.id === null && drop.att_destroyers === null && drop.battle_report_id === null
        && drop.defender_name === 'Synthetic Owner' && Number(drop.old_population) === 80 && drop.killed_population === 7);
    for (const q of ['', 'Synthetic Owner', 'SYN', 'Orbit', 'Beta', 'no match']) {
        for (const sort of ['occurred_at', 'cv', 'pop', 'att_cv', 'def_cv']) {
            for (const dir of ['asc', 'desc']) {
                const result = repo.getBattleReportsExport({ scope: 'filtered', q, sort, dir }).rows;
                const visible = repo.searchBattleReportsFeed({ q, sort, dir, limit: 500 }).rows;
                ok(`filtered export matches search: ${q || '(empty)'}, ${sort}, ${dir}`,
                    same(result.map(row => Object.fromEntries(Object.keys(visible[0] || {}).map(key => [key, row[key]]))), visible));
            }
        }
    }
    const insert = db.prepare(`INSERT INTO battle_reports (id, started_at, system_id, att_player_name, att_combat_value)
        VALUES (?, '2026-08-01T12:00:00Z', 1, 'Synthetic Large History', ?)`);
    db.transaction(() => { for (let n = 1; n <= 5010; n++) insert.run(1000 + n, n); })();
    const large = repo.getBattleReportsExport({ scope: 'filtered', q: 'Large History', sort: 'att_cv', dir: 'asc' }).rows;
    ok('export exceeds both display pagination and former 5000-source cap', large.length === 5010);
    ok('large-history sorting includes oldest/lower-ranked matches', large[0].att_combat_value === 1 && large.at(-1).att_combat_value === 5010);
    ok('search total and page agree with complete exported results',
        repo.searchBattleReportsFeed({ q: 'Large History', limit: 150 }).total === 5010);

    const hostile = ['=1+1', '+SUM(A1)', '-formula', '@SUM(A1)', '\tvalue', '\rvalue', '\nvalue', ' \t=1', '\u0000=1'];
    const values = [...hostile, 'Synthetic "Żółw",\r\nnext line', '', null, 0, -5, 0.15];
    const csv = serializeBattleReportExport({ columns: ['value'], rows: values.map(value => ({ value })), format: 'csv' });
    const decoded = parseCsv(csv);
    ok('CSV is UTF-8 BOM and CRLF with a stable header', csv.startsWith('\uFEFF"value"\r\n'));
    ok('CSV neutralizes formulas even behind whitespace/control characters', hostile.every((value, n) => decoded[n + 1][0] === `'${value}`));
    ok('CSV quoting preserves Unicode, comma, quote and embedded CRLF', decoded[hostile.length + 1][0] === values[hostile.length]);
    ok('CSV preserves zero/negative numbers and exports missing values as empty cells', same(decoded.slice(-5).map(row => row[0]), ['', '', '0', '-5', '0.15']));
    const json = JSON.parse(serializeBattleReportExport({ columns: ['value'], rows: values.map(value => ({ value })), format: 'json', scope: 'filtered', filters: { q: 'Synthetic' }, exportedAt: '2026-09-12T12:00:00Z' }));
    ok('JSON is lossless for text, nulls and numbers and includes export metadata', same(json.records.map(row => row.value), values) && json.total === values.length && json.schema_version === 1 && json.filters.q === 'Synthetic');
    ok('empty CSV still contains every header', parseCsv(serializeBattleReportExport({ columns: full.columns, rows: [], format: 'csv' })).length === 1);

    const app = express();
    app.use((req, res, next) => { if (req.get('x-test-member')) req.session = { userId: 1, role: 'user' }; next(); });
    app.use('/hub-api', require('../routes/intel'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/hub-api/intel/battle-reports-export`;
    const request = (query, authenticated = true) => fetch(`${base}?${query}`, { headers: authenticated ? { 'x-test-member': '1' } : {} });
    let response = await request('scope=all&format=json', false);
    ok('anonymous exports require authentication', response.status === 401);
    for (const query of ['scope=all&format=xml', 'scope=unknown&format=csv', 'format=json', 'scope=all&format=json&format=csv']) {
        response = await request(query);
        ok(`invalid export options return 400: ${query}`, response.status === 400);
    }
    response = await request('scope=filtered&format=json&q=Large%20History&sort=att_cv&dir=asc&limit=1&offset=100');
    const payload = await response.json();
    ok('authenticated route downloads complete filtered data ignoring pagination', response.status === 200 && payload.total === 5010 && payload.records[0].att_combat_value === 1);
    ok('download has JSON attachment type, safe filename and no cache',
        response.headers.get('content-type').includes('application/json')
        && /^attachment; filename="battle-reports-filtered-[\dTZ-]+\.json"$/.test(response.headers.get('content-disposition'))
        && response.headers.get('cache-control') === 'private, no-store');
    response = await request('scope=filtered&format=csv&q=missing');
    ok('zero-match CSV download is successful and retains schema', response.status === 200 && parseCsv(await response.text())[0].includes('att_destroyers'));
    response = await request('scope=all&format=json&q=missing');
    const allPayload = await response.json();
    ok('all endpoint ignores q and includes reports absent from the feed', allPayload.total === 5014 && allPayload.filters === null && allPayload.records.some(row => row.id === 103));
} catch (error) {
    fail++; console.error('  NOT OK - export integration test crashed:', error);
} finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db && db.open) db.close();
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
}
})();
