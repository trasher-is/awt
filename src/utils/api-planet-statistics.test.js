// Synthetic category objects only. Their contents are deliberately uninterpreted:
// the changelog confirms category names, not ranks, fleet counts or battle fields.
const Api = require('../../public/js/utils/aw-api');
const Statistics = require('../../public/js/utils/api-planet-statistics');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}: ${JSON.stringify(detail)}`); }
}
const base = { id: 71001, index: 1, populationLevel: 12, starbaseLevel: 4 };
let planet = Api.mapPlanetsToSyncPayload(710, [{ ...base, statistics: {
    bestPlanet: { synthetic: 'uninterpreted' }, bestGuarded: null,
    strongestFleets: [{ synthetic: 'uninterpreted' }], recentBattles: [],
    secretOwner: 'must not be transported',
} }]).planets[0];
ok('the shared mapper carries availability of verified statistics categories',
    JSON.stringify(planet.api_statistics) === JSON.stringify({
        bestPlanet: true, bestGuarded: false, strongestFleets: true, recentBattles: false,
    }), planet);
ok('ranking statistics do not manufacture observed fleet presence', planet.has_fleet === null);
ok('nested objects and unknown fields are never transported',
    !JSON.stringify(planet).includes('uninterpreted') && !JSON.stringify(planet).includes('secretOwner'), planet);
planet = Api.mapPlanetsToSyncPayload(710, [{ ...base, statistics: null }]).planets[0];
ok('explicit null clears the four category flags', planet.api_statistics
    && Object.values(planet.api_statistics).every(value => value === false), planet);
planet = Api.mapPlanetsToSyncPayload(710, [base]).planets[0];
ok('an older API omitting statistics makes no clearing claim', !Object.hasOwn(planet, 'api_statistics'), planet);
for (const statistics of ['bad', [], 7, false, { other: {} }]) {
    planet = Api.mapPlanetsToSyncPayload(710, [{ ...base, statistics }]).planets[0];
    ok('an unsupported shape makes no clearing or availability claim',
        !Object.hasOwn(planet, 'api_statistics'), statistics);
}
planet = Api.mapPlanetsToSyncPayload(710, [{ ...base, statistics: {
    bestPlanet: 0, bestGuarded: false, strongestFleets: '', recentBattles: {},
} }]).planets[0];
ok('zero and false are available category data without assigning any rank meaning',
    planet.api_statistics?.bestPlanet === true && planet.api_statistics?.bestGuarded === true
    && planet.api_statistics?.strongestFleets === false && planet.api_statistics?.recentBattles === false, planet);
const flags = { bestPlanet: true, bestGuarded: false, strongestFleets: true, recentBattles: true };
ok('the transport validator accepts only the minimal four booleans',
    JSON.stringify(Api.validatePlanetStatisticsAvailability(flags)) === JSON.stringify(flags));
for (const value of [undefined, [], { ...flags, ownerName: 'private' }, { ...flags, bestPlanet: 1 }, { bestPlanet: true }]) {
    ok('nested or partial transport cannot overwrite a stored observation', Api.validatePlanetStatisticsAvailability(value) === undefined, value);
}
ok('null transport is an explicit clearing observation',
    Object.values(Api.validatePlanetStatisticsAvailability(null)).every(value => value === false));
const stamp = '2026-10-10T12:00:00Z';
const now = Date.parse(stamp);
ok('a fresh read offers only available named categories',
    Statistics.activeCategories(flags, stamp, now).join(',') === 'bestPlanet,strongestFleets,recentBattles');
ok('recent battle availability expires exactly at one hour',
    Statistics.activeCategories(flags, stamp, now + Statistics.BATTLES_MAX_AGE_MS).join(',') === 'bestPlanet,strongestFleets');
ok('daily ranking availability expires at 26 hours',
    Statistics.activeCategories(flags, stamp, now + Statistics.SNAPSHOT_MAX_AGE_MS).length === 0);
for (const observed of [null, 'bad', '2026-10-10T12:01:00Z']) {
    ok('missing, unreadable or future observations cannot become current badges',
        Statistics.activeCategories(flags, observed, now).length === 0, observed);
}
ok('SQLite UTC timestamps match explicit UTC timestamps',
    Statistics.activeCategories(flags, '2026-10-10 12:00:00', now).join(',') === 'bestPlanet,strongestFleets,recentBattles');
ok('stored JSON is reduced to unexpired strict flags',
    JSON.stringify(Statistics.readStoredStatistics(JSON.stringify(flags), stamp, now + Statistics.BATTLES_MAX_AGE_MS))
    === JSON.stringify({ ...flags, recentBattles: false }));
for (const value of ['{bad', JSON.stringify({ ...flags, owner: 'private' }), JSON.stringify({ ...flags, bestPlanet: 'true' })]) {
    ok('malformed or expanded stored data yields no statistics', Statistics.readStoredStatistics(value, stamp, now) === null, value);
}
console.log(`api-planet-statistics.test.js: ${failed} failures`);
process.exitCode = failed ? 1 : 0;
