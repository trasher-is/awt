// src/utils/fleet-traffic.js — where our fleets are, for the map to draw them moving.
//
// The assertion this file is really for is the last group: a sighted fleet has a
// destination and a clock and no origin, and nothing here may invent a course for it. A
// line drawn on a war map is read as a fact about where something came from.
//
// Run with: node src/utils/fleet-traffic.test.js

const traffic = require('../../public/js/utils/fleet-traffic.js');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('fleet-traffic.test.js');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();

const a = { system_id: 1, planet_index: 2, x: 0, y: 0, name: 'Home' };
const b = { system_id: 2, planet_index: 4, x: 10, y: 0, name: 'Waypoint' };
const c = { system_id: 3, planet_index: 1, x: 10, y: 10, name: 'Target' };

// Two legs: A->B from 10:00 to 14:00, B->C from 14:00 to 16:00.
const legs = [
    { from: a, to: b, departsAt: iso(NOW - 2 * HOUR), arrivesAt: iso(NOW + 2 * HOUR) },
    { from: b, to: c, departsAt: iso(NOW + 2 * HOUR), arrivesAt: iso(NOW + 4 * HOUR) },
];

// --- Timestamps -------------------------------------------------------------
ok('a SQLite timestamp is read as UTC', traffic.toMs('2026-09-22 12:00:00') === NOW);
ok('an ISO timestamp with an offset keeps it', traffic.toMs('2026-09-22T14:00:00+02:00') === NOW);
ok('rubbish is null, not NaN pretending to be a time', traffic.toMs('soon') === null);

// --- Which leg, and how far along ------------------------------------------
const flying = traffic.legStateAt(legs, NOW);
ok('a route mid-flight reports flying', flying.status === 'flying', flying);
ok('it names the leg it is on', flying.legIndex === 0, flying);
ok('half way through a four-hour leg is a fraction of 0.5', Math.abs(flying.fraction - 0.5) < 1e-9, flying.fraction);
ok('it carries the arrival of the leg it is on', flying.arrivesAt === NOW + 2 * HOUR, flying);

const onSecondLeg = traffic.legStateAt(legs, NOW + 3 * HOUR);
ok('an hour into the second leg is leg 1 at a half', onSecondLeg.legIndex === 1 && Math.abs(onSecondLeg.fraction - 0.5) < 1e-9, onSecondLeg);

ok('before the first departure the route is pending',
    traffic.legStateAt(legs, NOW - 3 * HOUR).status === 'pending');
ok('pending says how long until launch',
    traffic.legStateAt(legs, NOW - 3 * HOUR).startsInMs === HOUR, traffic.legStateAt(legs, NOW - 3 * HOUR));
ok('after the last arrival the route has arrived',
    traffic.legStateAt(legs, NOW + 5 * HOUR).status === 'arrived');
ok('a route with no times at all is unscheduled, not "arrived"',
    traffic.legStateAt([{ from: a, to: b, departsAt: null, arrivesAt: null }], NOW).status === 'unscheduled');

// A gap between two legs — rounding, or a deliberate pause. The fleet is parked at the end
// of the leg it finished, not floating between two places it was never at.
const gapped = [
    { from: a, to: b, departsAt: iso(NOW - 2 * HOUR), arrivesAt: iso(NOW - HOUR) },
    { from: b, to: c, departsAt: iso(NOW + HOUR), arrivesAt: iso(NOW + 2 * HOUR) },
];
const inGap = traffic.legStateAt(gapped, NOW);
ok('between two legs the fleet sits at the end of the finished one',
    inGap.status === 'flying' && inGap.fraction === 1 && inGap.to.system_id === b.system_id, inGap);

// A zero-length leg must not divide by zero.
const instant = traffic.legStateAt([{ from: a, to: b, departsAt: iso(NOW), arrivesAt: iso(NOW) }], NOW);
ok('a zero-duration leg does not put the ship at infinity', instant.status === 'arrived', instant);

// --- Position ---------------------------------------------------------------
const mid = traffic.positionFor(a, b, 0.5);
ok('a half-way position is the midpoint', mid.x === 5 && mid.y === 0, mid);
ok('the heading points from origin to destination', Math.abs(mid.heading) < 1e-9, mid.heading);
ok('a heading north is a quarter turn', Math.abs(traffic.positionFor(a, { x: 0, y: 10 }, 0.5).heading - Math.PI / 2) < 1e-9);
ok('a fraction past the end is clamped to the destination', traffic.positionFor(a, b, 9).x === 10);
ok('a negative fraction is clamped to the origin', traffic.positionFor(a, b, -3).x === 0);

// --- Whole routes -----------------------------------------------------------
const routes = [
    { id: 1, title: 'LB 9th cult', author: 'Harpyie', isAllianceMove: true, legs },
    { id: 2, title: 'Landed a while ago', legs: [{ from: a, to: b, departsAt: iso(NOW - 10 * HOUR), arrivesAt: iso(NOW - 9 * HOUR) }] },
    { id: 3, title: 'Just landed', legs: [{ from: a, to: b, departsAt: iso(NOW - 2 * HOUR), arrivesAt: iso(NOW - 30 * 60 * 1000) }] },
    { id: 4, title: 'No coordinates', legs: [{ from: { system_id: 9, x: null, y: null }, to: b, departsAt: iso(NOW), arrivesAt: iso(NOW + HOUR) }] },
    { id: 5, title: 'A plan with no date', legs: [{ from: a, to: b, departsAt: null, arrivesAt: null }] },
];
const ships = traffic.shipsFor(routes, { now: NOW });
const byId = id => ships.find(s => s.id === id);

ok('a route in flight is drawn', byId(1) && byId(1).status === 'flying', byId(1));
ok('its position is the interpolated point, not an endpoint',
    byId(1).position.x > 0 && byId(1).position.x < 10, byId(1).position);
ok('it carries an ETA', byId(1).etaMs === 2 * HOUR, byId(1).etaMs);
ok('it keeps the alliance-move flag, which is what halves the flight', byId(1).isAllianceMove === true);
ok('a route that landed ten hours ago is gone from the map', !byId(2), ships.map(s => s.id));
ok('a route that landed half an hour ago is still shown', !!byId(3) && byId(3).status === 'arrived', byId(3));
ok('a leg with no coordinates cannot be drawn', !byId(4), ships.map(s => s.id));
ok('an unscheduled plan is kept, with no position to animate',
    byId(5) && byId(5).status === 'unscheduled' && byId(5).position === null, byId(5));
ok('every drawable route carries its legs so the path can be drawn behind the ship',
    byId(1).legs.length === 2 && byId(1).legs[0].from.x === 0, byId(1).legs);

const pending = traffic.shipsFor([{ id: 6, legs: [{ from: a, to: b, departsAt: iso(NOW + HOUR), arrivesAt: iso(NOW + 3 * HOUR) }] }], { now: NOW });
ok('a fleet that has not launched sits at its origin, not in space',
    pending[0].position.x === a.x && pending[0].position.y === a.y, pending[0].position);
ok('and says how long until it goes', pending[0].startsInMs === HOUR, pending[0]);

// --- Sighted fleets: a destination and a clock, never a course ---------------
const fleets = [
    { system_id: 70, system_name: 'Gomeisa', planet_index: 7, x: 3, y: 4, owner_name: 'caveman', tag: 'RAID', destroyers: 23, combat_value: 69, arrival_at: iso(NOW + 90 * 60 * 1000) },
    { system_id: 41, system_name: 'Merak', planet_index: 2, x: 1, y: 1, owner_name: 'Tatankamon', tag: 'RAID', destroyers: 14, arrival_at: iso(NOW + 30 * 60 * 1000) },
    { system_id: 42, planet_index: 11, x: 2, y: 2, owner_name: 'Harpyie', arrival_at: null },                    // parked, not moving
    { system_id: 43, planet_index: 1, x: 2, y: 3, owner_name: 'lbahen', arrival_at: iso(NOW - HOUR) },           // already landed
    { system_id: 44, planet_index: 1, x: null, y: null, owner_name: 'Ghost', arrival_at: iso(NOW + HOUR) },      // unplaceable
];
const inbound = traffic.inboundMarkers(fleets, { now: NOW });
ok('only fleets still in the air are marked', inbound.length === 2, inbound.map(f => f.system_id));
ok('the soonest arrival comes first', inbound[0].system_id === 41, inbound.map(f => f.system_id));
ok('a parked fleet is not an arrival', !inbound.some(f => f.system_id === 42));
ok('a fleet that already landed is not an arrival', !inbound.some(f => f.system_id === 43));
ok('a fleet with no coordinates cannot be placed', !inbound.some(f => f.system_id === 44));
ok('the countdown is reported', inbound[0].etaMs === 30 * 60 * 1000, inbound[0].etaMs);
ok('the ship counts ride along for the tooltip', inbound[1].ships.destroyers === 23, inbound[1].ships);
// The point of the whole split: no origin, therefore no course.
ok('a sighted fleet carries NO origin and NO path — the scrape never saw one',
    inbound.every(f => !('from' in f) && !('legs' in f) && !('heading' in f)), Object.keys(inbound[0]));

console.log(failed === 0 ? '  PASS' : `  FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
