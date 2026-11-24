// The daily ranking jobs must ask the game, never the browser's HTTP cache.
//
// 2026-11-24: a member who had opened the ranking pages by hand the day before was granted
// the daily jobs. Their browser answered both fetches from its cache, so the previous day's
// rankings were stored with a fresh timestamp and the job counted as done until the next
// reset. Each job is run here through the REAL request gate, so a gate that dropped the
// option on its way to fetch() would fail too.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
function ok(name, condition, detail) {
    console.log(`${condition ? '  ok' : '  NOT OK'} - ${name}${condition || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    if (!condition) failed++;
}

const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// The modules are ES modules; strip the import/export syntax and supply the imports as globals.
const asScript = file => read(file)
    .replace(/^import[^;]*;.*$/gm, '')
    .replace(/^export /gm, '');

const JOBS = [
    { file: 'public/js/ui/best-planets-watch.js', init: 'initBestPlanetsWatch', page: '/Ranking/BestPlanets', post: '/hub-api/sync/best-planets-snapshot' },
    { file: 'public/js/ui/highest-population-watch.js', init: 'initHighestPopulationWatch', page: '/Ranking/HighestPopulation', post: '/hub-api/sync/highest-population-snapshot' },
    { file: 'public/js/ui/bonus-goals-sync.js', init: 'initBonusGoalsSync', page: '/Ranking/Example', post: '/hub-api/sync/bonus-goals/ranking-snapshot' },
];

async function run(job) {
    const calls = [];
    const row = { rank: 1, game_planet_id: 1, buildings: {} };
    const context = vm.createContext({
        console, Headers, URL, setTimeout, clearTimeout,
        setInterval() {},
        claimSharedJob: async () => true,
        parseRankingPage: () => [row],
        parseBestPlanetsPage: () => [row],
        DOMParser: class { parseFromString() { return {}; } },
        fetch: async (url, init) => {
            calls.push({ url, init: init || {} });
            return {
                ok: true,
                text: async () => '',
                json: async () => ({ targets: [{ goal_id: 1, config: { ranking_path: job.page } }] }),
            };
        },
    });
    vm.runInContext(read('public/js/utils/game-rate-limit.js'), context);
    vm.runInContext(asScript(job.file), context);
    vm.runInContext(`${job.init}()`, context);
    for (let i = 0; i < 100 && !calls.some(c => c.url === job.post); i++) await new Promise(resolve => setTimeout(resolve, 5));
    return calls;
}

(async () => {
    for (const job of JOBS) {
        const calls = await run(job);
        const game = calls.filter(c => c.url === job.page);
        ok(`${job.file}: one game request per run`, game.length === 1, calls.map(c => c.url));
        ok(`${job.file}: the ranking page is fetched with cache: 'no-store'`, game.length === 1 && game[0].init.cache === 'no-store', game.map(c => c.init.cache));
        ok(`${job.file}: the request still carries the gate's marker`, game.length === 1 && new Headers(game[0].init.headers).get('X-AWT-Automated') === '1');
        ok(`${job.file}: the snapshot is posted to the hub`, calls.some(c => c.url === job.post), calls.map(c => c.url));
    }
    if (failed) process.exitCode = 1;
    else console.log('All ranking-jobs-uncached checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
