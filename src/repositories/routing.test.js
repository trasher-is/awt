const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;

const db = require('../database');
const routing = require('./routing');

let failed = 0;
function ok(desc, cond) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}`); }
}

console.log('routing.test.js');

// getRouteById / getRouteOwnership return undefined for a missing id
ok('getRouteById returns undefined for missing id', routing.getRouteById(999) === undefined);
ok('getRouteOwnership returns undefined for missing id', routing.getRouteOwnership(999) === undefined);

// insertRoute with a NULL author_id (no app_users row to resolve; LEFT JOIN should still work)
const orphanRouteId = routing.insertRoute(null, 'Orphan Route', 'note', null, 0, 0, 0, 0, 'private', null);
ok('insertRoute returns a numeric id', typeof orphanRouteId === 'number' && orphanRouteId > 0);
const orphanRoute = routing.getRouteById(orphanRouteId);
ok('getRouteById returns route with no author_name when app_users row absent', orphanRoute && orphanRoute.author_name === null);
routing.deleteRoute(orphanRouteId);

// Insert an app_users row (author) for the rest of the tests
db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES (?, ?)`).run('Author1', 'hash1');
const author1 = db.prepare(`SELECT id FROM app_users WHERE game_name = 'Author1'`).get();
const author1Id = author1.id;

db.prepare(`INSERT INTO app_users (game_name, password_hash) VALUES (?, ?)`).run('Author2', 'hash2');
const author2 = db.prepare(`SELECT id FROM app_users WHERE game_name = 'Author2'`).get();
const author2Id = author2.id;

// insertRoute creates a row and returns its id; getRouteById returns it with matching fields
const routeId = routing.insertRoute(author1Id, 'My Route', 'A note', '2026-09-01 12:00:00', 5, 2, 1, 3, 'private', null);
ok('insertRoute returns a numeric id', typeof routeId === 'number' && routeId > 0);
const route = routing.getRouteById(routeId);
ok('getRouteById returns route with matching fields', route
    && route.author_id === author1Id
    && route.title === 'My Route'
    && route.note === 'A note'
    && route.planned_start_at === '2026-09-01 12:00:00'
    && route.energy === 5
    && route.race_speed === 2
    && route.is_alliance_move === 1
    && route.biology === 3
    && route.visibility === 'private'
    && route.expires_at === null);
ok('getRouteById resolves author_name via LEFT JOIN', route.author_name === 'Author1');

// getRouteOwnership returns id/author_id for existing route
const ownership = routing.getRouteOwnership(routeId);
ok('getRouteOwnership returns id and author_id', ownership && ownership.id === routeId && ownership.author_id === author1Id);

// updateRoute on an existing id changes its fields
const beforeUpdate = routing.getRouteById(routeId);
routing.updateRoute(routeId, 'Updated Title', 'Updated note', '2026-09-02 08:00:00', 9, 4, 0, 1, 'alliance', '2026-10-01 00:00:00');
const afterUpdate = routing.getRouteById(routeId);
ok('updateRoute changes title', afterUpdate.title === 'Updated Title');
ok('updateRoute changes note', afterUpdate.note === 'Updated note');
ok('updateRoute changes planned_start_at', afterUpdate.planned_start_at === '2026-09-02 08:00:00');
ok('updateRoute changes energy', afterUpdate.energy === 9);
ok('updateRoute changes race_speed', afterUpdate.race_speed === 4);
ok('updateRoute changes is_alliance_move', afterUpdate.is_alliance_move === 0);
ok('updateRoute changes biology', afterUpdate.biology === 1);
ok('updateRoute changes visibility', afterUpdate.visibility === 'alliance');
ok('updateRoute changes expires_at', afterUpdate.expires_at === '2026-10-01 00:00:00');
ok('updateRoute sets/changes updated_at', afterUpdate.updated_at !== undefined && afterUpdate.updated_at !== null);

// insertRouteLeg (a few times for the same route_id) followed by getRouteLegsForRouteIds([routeId])
routing.insertRouteLeg(routeId, 0, 1, 0, 2, 1, 100, 10.5, 0);
routing.insertRouteLeg(routeId, 2, 3, 0, 4, 0, 300, 30.5, 1);
routing.insertRouteLeg(routeId, 1, 2, 1, 3, 0, 200, 20.5, 0);

const legs = routing.getRouteLegsForRouteIds([routeId]);
ok('getRouteLegsForRouteIds returns all legs for the route', legs.length === 3);
ok('getRouteLegsForRouteIds orders by leg_index', legs[0].leg_index === 0 && legs[1].leg_index === 1 && legs[2].leg_index === 2);

// getRouteLegsForRouteIds([]) returns [] without querying (no error)
const emptyLegs = routing.getRouteLegsForRouteIds([]);
ok('getRouteLegsForRouteIds returns [] for empty ids array', Array.isArray(emptyLegs) && emptyLegs.length === 0);

// Second route with its own legs, to test attribution and isolation across two route ids
const routeId2 = routing.insertRoute(author2Id, 'Second Route', null, null, 0, 0, 0, 0, 'private', null);
routing.insertRouteLeg(routeId2, 0, 5, 0, 6, 0, 50, 5.5, 0);
routing.insertRouteLeg(routeId2, 1, 6, 0, 7, 0, 60, 6.5, 0);

const bothLegs = routing.getRouteLegsForRouteIds([routeId, routeId2]);
ok('getRouteLegsForRouteIds([id1, id2]) returns legs from both routes', bothLegs.length === 5);
ok('getRouteLegsForRouteIds attributes legs correctly via route_id',
    bothLegs.filter(l => l.route_id === routeId).length === 3
    && bothLegs.filter(l => l.route_id === routeId2).length === 2);

// deleteRouteLegsForRoute(routeId) removes only that route's legs, leaving another route's legs untouched
routing.deleteRouteLegsForRoute(routeId);
const legsAfterDelete = routing.getRouteLegsForRouteIds([routeId, routeId2]);
ok('deleteRouteLegsForRoute removes only the target route legs', legsAfterDelete.length === 2 && legsAfterDelete.every(l => l.route_id === routeId2));

// deleteRoute(id) removes the route row; getRouteById(id) afterward returns undefined
routing.deleteRoute(routeId);
ok('deleteRoute removes the route row', routing.getRouteById(routeId) === undefined);

// getRoutesForUser(userId): visibility='alliance' OR author_id = userId, excludes private route belonging to a different user
const privateOther = routing.insertRoute(author2Id, 'Private Other', null, null, 0, 0, 0, 0, 'private', null);
const alliancePublic = routing.insertRoute(author2Id, 'Alliance Public', null, null, 0, 0, 0, 0, 'alliance', null);
const privateMine = routing.insertRoute(author1Id, 'Private Mine', null, null, 0, 0, 0, 0, 'private', null);

const forUser1 = routing.getRoutesForUser(author1Id);
const idsForUser1 = forUser1.map(r => r.id);
ok('getRoutesForUser includes own private route', idsForUser1.includes(privateMine));
ok('getRoutesForUser includes alliance-visible route from another user', idsForUser1.includes(alliancePublic));
ok('getRoutesForUser excludes private route belonging to a different user', !idsForUser1.includes(privateOther));

routing.deleteRoute(privateOther);
routing.deleteRoute(alliancePublic);
routing.deleteRoute(privateMine);
routing.deleteRoute(routeId2);

// purgeExpiredRoutes() removes a route with expires_at in the past, leaves future/NULL untouched, returns count removed
const pastRoute = routing.insertRoute(author1Id, 'Expired', null, null, 0, 0, 0, 0, 'private', '2020-01-01 00:00:00');
const futureRoute = routing.insertRoute(author1Id, 'Future', null, null, 0, 0, 0, 0, 'private', '2099-01-01 00:00:00');
const nullExpiryRoute = routing.insertRoute(author1Id, 'NoExpiry', null, null, 0, 0, 0, 0, 'private', null);

const purgedCount = routing.purgeExpiredRoutes();
ok('purgeExpiredRoutes returns count of removed rows', purgedCount === 1);
ok('purgeExpiredRoutes removed the expired route', routing.getRouteById(pastRoute) === undefined);
ok('purgeExpiredRoutes left the future-expiry route untouched', routing.getRouteById(futureRoute) !== undefined);
ok('purgeExpiredRoutes left the null-expiry route untouched', routing.getRouteById(nullExpiryRoute) !== undefined);

console.log(failed === 0 ? 'All tests passed.' : `${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
