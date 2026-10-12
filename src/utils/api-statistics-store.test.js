const Database = require('better-sqlite3');
const { storePlanetStatistics, applyStatisticsWrite } = require('./api-statistics-store');
const db = new Database(':memory:');
db.exec(`CREATE TABLE planets(system_id INTEGER,planet_index INTEGER,game_planet_id INTEGER,
    api_statistics TEXT,api_statistics_observed_at TEXT);
    INSERT INTO planets VALUES(1,1,7001,NULL,NULL);`);
let failures = 0;
function ok(name, condition) { console.log(`${condition ? 'ok' : 'NOT OK'} - ${name}`); if (!condition) failures++; }
const row = () => db.prepare('SELECT * FROM planets').get();
const stamp = '2026-10-10T12:00:00.000Z';
const flags = { bestPlanet: true, bestGuarded: false, strongestFleets: true, recentBattles: true };
const planet = { planet_index: 1, game_planet_id: 7001, api_statistics: flags };
try {
    applyStatisticsWrite(db, 1, 1, storePlanetStatistics(db, 1, planet, stamp));
    ok('the exact validated flags and observation date are stored', JSON.stringify(JSON.parse(row().api_statistics)) === JSON.stringify(flags) && row().api_statistics_observed_at === stamp);
    applyStatisticsWrite(db, 1, 1, storePlanetStatistics(db, 1, { planet_index: 1, game_planet_id: 7001 }, null));
    ok('older clients that omit stats preserve the same planet observation', row().api_statistics_observed_at === stamp);
    applyStatisticsWrite(db, 1, 1, storePlanetStatistics(db, 1, { ...planet, api_statistics: { ...flags, arbitrary: true } }, stamp));
    ok('extra payload fields cannot become recorded stats', Object.keys(JSON.parse(row().api_statistics)).length === 4);
    applyStatisticsWrite(db, 1, 1, storePlanetStatistics(db, 1, { ...planet, game_planet_id: 7002, api_statistics: undefined }, stamp));
    ok('a replacement planet cannot inherit the previous identity stats', row().api_statistics === null && row().api_statistics_observed_at === null);
    applyStatisticsWrite(db, 1, 1, storePlanetStatistics(db, 1, { ...planet, api_statistics: null }, stamp));
    ok('explicit API null clears every available category', Object.values(JSON.parse(row().api_statistics)).every(v => v === false));
    applyStatisticsWrite(db, 1, 1, storePlanetStatistics(db, 1, planet, null));
    ok('unknown observation age is never manufactured from arrival time', row().api_statistics_observed_at === null);
} finally { db.close(); }
process.exitCode = failures ? 1 : 0;
