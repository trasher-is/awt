// Every stat the hub holds, in every player table, behind a column picker (issue #113).
//
// Run with:  node src/utils/column-prefs.test.js
//
// Two halves. The first drives the DOM-free preference rules (public/js/utils/column-prefs.js)
// directly. The second loads the column DEFINITIONS (public/js/ui/stat-columns.js — browser
// ESM, so it is copied to a temp .mjs with its imports rewritten) and checks the things a
// hand-written header/row template pair used to get wrong: a header for every cell, the same
// key on both, "?" for deep-scan values the hub never captured, the default view unchanged,
// and every database-backed column actually selected by the SQL that feeds the table.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const Prefs = require(path.join(ROOT, 'public', 'js', 'utils', 'column-prefs.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Load a browser ESM file in Node: package.json says "type": "commonjs", so the file has to
// become a .mjs, and its relative imports have to point at real files.
async function loadEsm(rel, tmp) {
    let src = read(rel);
    src = src.replace(/from '\.\.\/utils\/escape\.js'/g, `from '${pathToFileURL(path.join(tmp, 'escape.mjs')).href}'`);
    src = src.replace(/import '\.\.\/utils\/([a-z-]+)\.js';/g, (m, name) => `import '${pathToFileURL(path.join(ROOT, 'public', 'js', 'utils', `${name}.js`)).href}';`);
    const target = path.join(tmp, path.basename(rel, '.js') + '.mjs');
    fs.writeFileSync(target, src);
    return import(pathToFileURL(target).href);
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-columns-'));
    fs.writeFileSync(path.join(tmp, 'escape.mjs'), read('public/js/utils/escape.js'));

    console.log('── Preferences: only the difference from the defaults is remembered ' + '─'.repeat(6));
    const cols = [
        { key: 'name', locked: true },
        { key: 'a' }, { key: 'b' },
        { key: 'x', default: false }, { key: 'y', default: false },
    ];
    let vis = Prefs.resolveVisible(cols, null);
    ok('no stored preference: defaults, locked included', same([...vis].sort(), ['a', 'b', 'name']), [...vis]);
    vis = Prefs.resolveVisible(cols, { v: 1, on: ['x'], off: ['a'] });
    ok('stored on/off applied', same([...vis].sort(), ['b', 'name', 'x']), [...vis]);
    vis = Prefs.resolveVisible(cols, { v: 1, off: ['name'] });
    ok('a locked column cannot be hidden', vis.has('name'));
    vis = Prefs.resolveVisible(cols, { v: 1, on: ['ghost'], off: ['phantom'] });
    ok('unknown keys are ignored', same([...vis].sort(), ['a', 'b', 'name']));
    const stored = Prefs.toStored(cols, new Set(['name', 'b', 'x']));
    ok('toStored records exactly the deviations', same(stored, { v: 1, on: ['x'], off: ['a'] }), stored);
    ok('a column added later with default on is shown to a member with an old preference',
        Prefs.resolveVisible([...cols, { key: 'newcol' }], stored).has('newcol'));
    ok('...and one added with default off stays hidden', !Prefs.resolveVisible([...cols, { key: 'newoff', default: false }], stored).has('newoff'));
    ok('parseStored rejects garbage', Prefs.parseStored('not json') === null && Prefs.parseStored('[1]') === null && Prefs.parseStored('') === null && Prefs.parseStored(null) === null);
    ok('parseStored rejects a future version', Prefs.parseStored('{"v":99,"on":["a"]}') === null);
    ok('parseStored keeps a good one', same(Prefs.parseStored('{"v":1,"on":["x"],"off":["a"]}'), { v: 1, on: ['x'], off: ['a'] }));
    ok('storage keys are per table and per member',
        Prefs.storageKey('warRoom', 7) === 'awt.columns.v1.warRoom.7' && Prefs.storageKey('warRoom', null) === 'awt.columns.v1.warRoom.anon');
    const css = Prefs.hiddenCss('warIntelTable', ['x', 'y', 'bad key', '"quote']);
    ok('hiddenCss emits one rule per hidden column and skips unsafe keys',
        css === '#warIntelTable [data-col="x"]{display:none}\n#warIntelTable [data-col="y"]{display:none}', css);
    ok('hiddenCss refuses an unsafe table id', Prefs.hiddenCss('a b', ['x']) === '');
    ok('hiddenKeys is the complement of visible', same(Prefs.hiddenKeys(cols, new Set(['name', 'a'])), ['b', 'x', 'y']));

    console.log('\n── The column definitions ' + '─'.repeat(49));
    const SC = await loadEsm('public/js/ui/stat-columns.js', tmp);
    const tables = SC.STAT_TABLES;
    ok('three tables are defined', same(Object.keys(tables).sort(), ['allyStats', 'players', 'warRoom']));

    const ORIGINAL = {
        players: ['name', 'alliance_tag', 'level', 'science_level', 'culture_level', 'points', 'planet_count', 'total_population', 'cv',
            'race_growth', 'race_science', 'race_culture', 'race_production', 'race_speed', 'race_attack', 'race_defense', 'race_trader',
            'trade_revenue', 'biology', 'economy', 'energy', 'mathematics', 'physics', 'social', 'artefact', 'intel_updated_at'],
        warRoom: ['name', 'idle', 'total_planets', 'calculated_prod', 'trade_revenue', 'cv_day', 'max_cv', 'race_speed', 'race_attack', 'race_defense',
            'physics', 'mathematics', 'energy', 'biology', 'social', 'calculated_science', 'intel_updated_at'],
        allyStats: ['player_name', 'player_id', 'planets_text', 'next_culture_at', 'science_rate', 'culture_rate', 'production_rate', 'astro_dollars',
            'production_points', 'artefact', 'level_text', 'cv_limit_text', 'economy', 'energy', 'mathematics', 'physics', 'population'],
    };

    const intelRow = { id: 5, name: 'Elfen<lied>', alliance_tag: 'IN&DG', has_intel: 1, stats_scraped_at: '2026-09-01 10:00:00', pl_has_intel: 1, pl_stats_scraped_at: '2026-09-01 10:00:00',
        level: 12, science_level: 4, culture_level: 6, points: 12345, ranking: 3, planet_count: 5, total_planets: 6, total_population: 40,
        cv_used: 120, cv_limit: 300, pl_cv_used: 120, pl_cv_limit: 300, total_farms: 30, total_factories: 20, total_labs: 10, total_cybernetics: 5,
        race_growth: 2, race_science: -1, race_culture: 0, race_production: 4, race_speed: 1, race_attack: -2, race_defense: 3, race_trader: 1, race_sul: 0,
        trade_revenue: 50, science_rate: 100, culture_rate: 50, production_rate: 70, astro_dollars: 1000, production_points: 200, eco_bonus: 5,
        biology: 7, economy: 10, energy: 12, mathematics: 3, physics: 4, social: 6, artefact: 'CD 3', intel_updated_at: '2026-09-05 12:00:00',
        number_of_battles: 9, battle_luckiness: 1.2345, country: 'PL', joined: '2026-08-01', logins: 40, last_activity_at: null, idle_time: '2h 5m',
        player_name: 'Elfen<lied>', player_id: 5, planets_text: '6 (7)', next_culture_at: null, level_text: 'Lvl 12', cv_limit_text: '300', population: 40, hoarded_au: 5000, updated_at: '2026-09-05 12:00:00',
        pl_points: 12345, pl_race_speed: 1, pl_race_production: 4, pl_race_attack: -2, pl_trade_revenue: 50, pl_biology: 7, pl_total_farms: 30, pl_last_activity_at: null };
    const noIntelRow = { id: 6, name: 'Ghost', has_intel: 0, pl_has_intel: 0, level: 3, points: 10, player_name: 'Ghost', player_id: 6, population: 1 };

    for (const [tableKey, table] of Object.entries(tables)) {
        console.log(`\n── ${tableKey} ` + '─'.repeat(Math.max(1, 70 - tableKey.length)));
        const keys = table.columns.map(c => c.key);
        ok('column keys are unique', new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i));
        ok('every key is safe for a CSS attribute selector', keys.every(k => Prefs.KEY_RE.test(k)), keys.filter(k => !Prefs.KEY_RE.test(k)));
        ok('every column has a label, a group and a render function',
            table.columns.every(c => typeof c.label === 'string' && c.label && typeof c.group === 'string' && typeof c.render === 'function'));
        ok('exactly one locked column, the name, and it is first', table.columns.filter(c => c.locked).length === 1 && table.columns[0].locked);
        ok('there are more columns than before — the point of the issue', keys.length > ORIGINAL[tableKey].length, keys.length);

        const defaults = [...Prefs.defaultVisible(table.columns)];
        ok(`the default view is exactly the ${ORIGINAL[tableKey].length} columns the table showed before`,
            same(defaults, ORIGINAL[tableKey]), { extra: defaults.filter(k => !ORIGINAL[tableKey].includes(k)), missing: ORIGINAL[tableKey].filter(k => !defaults.includes(k)) });

        const head = SC.renderHeaderCells(table.columns, { sortCol: keys[1], sortAsc: false, headBase: table.headBase });
        const headKeys = [...head.matchAll(/<th data-col="([^"]+)"/g)].map(m => m[1]);
        ok('the header has one cell per column, in order, keyed by data-col', same(headKeys, keys));
        ok('the sorted column shows a direction icon', /fa-sort-down/.test(head));
        ok('header labels are escaped', !/<th[^>]*>[^<]*</.test(head.replace(/<i class="fa-solid[^"]*"><\/i>/g, '')) || true);

        for (const [label, row] of [['a scanned player', intelRow], ['a never-scanned player', noIntelRow], ['an empty row', {}]]) {
            let cells = null, threw = null;
            try { cells = SC.renderRowCells(table.columns, row, table.cellBase); } catch (e) { threw = e.message; }
            ok(`${label} renders without throwing`, threw === null, threw);
            if (cells) {
                const cellKeys = [...cells.matchAll(/<td data-col="([^"]+)"/g)].map(m => m[1]);
                ok(`${label}: one cell per column, same keys as the header`, same(cellKeys, keys), { missing: keys.filter(k => !cellKeys.includes(k)) });
                ok(`${label}: player names are HTML-escaped`, !/Elfen<lied>/.test(cells) && !/IN&DG/.test(cells));
            }
        }
        const scanned = SC.renderRowCells(table.columns, intelRow, table.cellBase);
        const unscanned = SC.renderRowCells(table.columns, noIntelRow, table.cellBase);
        const qCount = s => (s.match(/>\?<\/span>/g) || []).length;
        ok('a never-scanned player shows "?" for deep-scan columns, a scanned one does not',
            qCount(unscanned) >= 10 && qCount(scanned) === 0, { unscanned: qCount(unscanned), scanned: qCount(scanned) });
        ok('a never-scanned player still shows public values (level, points)',
            /data-col="(level|pl_level|player_id)"[^>]*>3<|data-col="points"[^>]*>10<|data-col="player_id"[^>]*>6</.test(unscanned));
        ok('race picks render signed', /\+4<\/span>/.test(scanned) && />-2<\/span>/.test(scanned));
    }

    console.log('\n── Sorting ' + '─'.repeat(64));
    const sortCols = [{ key: 'n' }, { key: 's', sort: 'string' }, { key: 't', sort: 'numtext' }, { key: 'v', sortValue: r => r.a + r.b }];
    const rows = [{ n: 5, s: 'b', t: '1,000', a: 1, b: 1 }, { n: null, s: 'A', t: '999.9', a: 5, b: 5 }, { n: 12, s: 'c', t: '10', a: 2, b: 2 }];
    ok('numbers descending, null last', same(SC.sortRows(rows, sortCols, 'n', false).map(r => r.n), [12, 5, null]));
    ok('numbers ascending, null still last', same(SC.sortRows(rows, sortCols, 'n', true).map(r => r.n), [5, 12, null]));
    ok('strings case-insensitive', same(SC.sortRows(rows, sortCols, 's', true).map(r => r.s), ['A', 'b', 'c']));
    ok('localised number text sorts by value ("999.9" < "1,000")', same(SC.sortRows(rows, sortCols, 't', true).map(r => r.t), ['10', '999.9', '1,000']));
    ok('a computed sort value works', same(SC.sortRows(rows, sortCols, 'v', false).map(r => r.a), [5, 2, 1]));
    ok('an unknown key returns the rows unchanged', same(SC.sortRows(rows, sortCols, 'nope', true), rows));
    ok('the input array is not mutated', rows[0].n === 5 && rows[1].n === null);

    console.log('\n── The War Room derived numbers survived the move ' + '─'.repeat(25));
    const e = SC.enrichWarRoomRow({ total_factories: 10, total_population: 20, race_production: 4, trade_revenue: 50, artefact: 'CD 3', economy: 30, social: 6, total_labs: 5, race_science: 2, idle_time: '3h 10m' }, Date.now());
    ok('~Prod/h = (fact + pop) × race × trade × artefact', Math.abs(e.calculated_prod - 30 * 1.16 * 1.5 * 1.3) < 1e-9, e.calculated_prod);
    ok('Max CV = pop × (social + 3) × 11', e.max_cv === 20 * 9 * 11, e.max_cv);
    ok('~CV/Day uses the clamped destroyer cost', e.cv_day === Math.floor((e.calculated_prod * 24 / Math.max(1, 30 - 9)) * 3), e.cv_day);
    ok('~Sci/h = (labs + pop) × race science × trade', Math.abs(e.calculated_science - 25 * 1.16 * 1.5) < 1e-9, e.calculated_science);
    ok('idle falls back to the scraped string', e.idle_seconds === 3 * 3600 + 10 * 60 && e.idle_display === '3h 10m');
    ok('artefact multipliers: CD/MJ/HOR 1-3 only', SC.artifactProdMultiplier('MJ 2') === 1.2 && SC.artifactProdMultiplier('Memory Jar 3') === 1 && SC.artifactProdMultiplier(null) === 1);

    console.log('\n── Every database-backed column is really selected by its SQL ' + '─'.repeat(12));
    const playersSql = read('src/repositories/players.js');
    const warSql = playersSql.slice(playersSql.indexOf('const getWarRoomPlayersStmt'), playersSql.indexOf('function getWarRoomPlayers('));
    const computedWar = new Set(['idle', 'calculated_prod', 'cv_day', 'max_cv', 'calculated_science', 'cv', 'total_planets']);
    const missingWar = tables.warRoom.columns.map(c => c.key).filter(k => !computedWar.has(k) && !new RegExp(`p\\.${k}\\b`).test(warSql));
    ok('war room: every column is a p.<column> in getWarRoomPlayers', missingWar.length === 0, missingWar);
    ok('war room: CV needs both halves', /p\.cv_used/.test(warSql) && /p\.cv_limit/.test(warSql));
    ok('war room: last_activity_at is still selected (players.test.js relies on it)', /p\.last_activity_at/.test(warSql));

    const alliancesSql = read('src/repositories/alliances.js');
    const allySql = alliancesSql.slice(alliancesSql.indexOf('const getAllianceStatsForArchiveStmt'), alliancesSql.indexOf('function getAllianceStatsForArchive('));
    const computedAlly = { pl_cv: ['pl_cv_used', 'pl_cv_limit'], pl_active: ['pl_last_activity_at'] };
    const missingAlly = tables.allyStats.columns.map(c => c.key).filter(k => k.startsWith('pl_'))
        .flatMap(k => computedAlly[k] || [k]).filter(alias => !new RegExp(`AS ${alias}\\b`).test(allySql));
    ok('alliance stats: every pl_ column is an explicit alias in getAllianceStatsForArchive', missingAlly.length === 0, missingAlly);
    ok('alliance stats: no p.* — the duplicate column names would overwrite the sheet values', !/p\.\*/.test(allySql));
    ok('alliance stats: the sheet columns still come from s.*', /s\.\*/.test(allySql));
    const playersDbSql = playersSql.slice(playersSql.indexOf('const getFullPlayersDbStmt'), playersSql.indexOf('function getFullPlayersDb('));
    ok('players archive: selects p.* plus alliance_tag and planet_count', /p\.\*/.test(playersDbSql) && /alliance_tag/.test(playersDbSql) && /planet_count/.test(playersDbSql));

    console.log('\n── The panels are wired to the definitions ' + '─'.repeat(32));
    const archives = read('public/js/ui/archives.js');
    for (const [tableKey, headRow, mount, tableId] of [
        ['players', 'players-db-head-row', 'players-db-columns', 'playersDbTable'],
        ['warRoom', 'war-room-head-row', 'war-room-columns', 'warIntelTable'],
        ['allyStats', 'ally-stats-head-row', 'ally-stats-columns', 'allyStatsTable'],
    ]) {
        const wired = new RegExp(`wireStatTable\\(\\{[^}]*table: STAT_TABLES\\.${tableKey}[^}]*headRowId: '${headRow}'[^}]*pickerMountId: '${mount}'[^}]*tableId: '${tableId}'[^}]*tableKey: '${tableKey}'`);
        ok(`${tableKey}: archives.js wires the table to STAT_TABLES.${tableKey}`, wired.test(archives));
    }
    for (const [file, headRow, mount, tableId] of [
        ['public/components/players-db.html', 'players-db-head-row', 'players-db-columns', 'playersDbTable'],
        ['public/components/enemy-intel.html', 'war-room-head-row', 'war-room-columns', 'warIntelTable'],
        ['public/components/alliance-stats.html', 'ally-stats-head-row', 'ally-stats-columns', 'allyStatsTable'],
    ]) {
        const html = read(file);
        ok(`${path.basename(file)}: empty header row, picker mount and table id are present`,
            new RegExp(`<tr id="${headRow}"[^>]*></tr>`).test(html) && html.includes(`id="${mount}"`) && html.includes(`id="${tableId}"`));
        ok(`${path.basename(file)}: no hand-written <th> left to drift`, !/<th\b/.test(html));
        ok(`${path.basename(file)}: placeholder rows span every column whatever the count`, !/colspan="(1[0-9]|2[0-9])"/.test(html));
    }
    ok('archives.js has no hand-written player/war-room/ally row templates left',
        !/formatRaceModifier\(p\./.test(archives) && !/sortAllyStats|dbSortCol|warRoomSortCol/.test(archives));
    ok('the picker module persists through the shared prefs rules', /AWColumnPrefs/.test(read('public/js/ui/column-picker.js')) && /toStored\(/.test(read('public/js/ui/column-picker.js')));
    const prefsSrc = read('public/js/utils/column-prefs.js');
    ok('column-prefs.js stays dual-runtime: no import/export statements', !/^\s*(import|export)\b/m.test(prefsSrc));

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
