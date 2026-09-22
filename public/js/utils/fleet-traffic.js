// Where our fleets are right now, for the map to draw them moving.
//
// ─── WHAT THE HUB ACTUALLY KNOWS ABOUT A MOVING FLEET ─────────────────────────
// Two very different things, and the whole design of this module is about not mixing them
// up:
//
//   A PLANNED ROUTE (routes + route_legs) is a path. Every leg has both ends, a duration
//   the travel model produced, and — once the route is scheduled — a departure and an
//   arrival instant. That is enough to say where the fleet is at any moment, because the
//   game flies a leg at constant speed: position is the straight-line interpolation
//   between the two ends by elapsed fraction. A ship drawn from this is a ship we know
//   the course of.
//
//   A SIGHTED FLEET (fleets.arrival_at) is a destination and a clock. The scrape saw a
//   fleet landing somewhere at a time; it did not see where it left from. There is no
//   course to draw, and drawing one would be inventing intelligence — a line on a war map
//   is read as a fact about which direction the enemy came from. Those get a countdown at
//   the destination instead, and nothing else.
//
// So: `shipsFor` animates paths, `inboundMarkers` marks arrivals, and they are separate
// functions returning separate shapes on purpose.
//
// ─── AND WHAT IT DOES NOT KNOW ────────────────────────────────────────────────
// A scheduled route is a plan, not a telemetry feed. Nothing reports that the fleet
// actually launched, so a ship drawn here means "this is where the plan says it is". The
// map labels it as a plan for that reason, and a route with no schedule at all is drawn as
// a dotted path with no ship on it, because an unscheduled plan has no position.
//
// LOADING: dual-runtime, the same pattern as travel-model.js and login-gaps.js, because
// BOTH sides need it and a moving ship must not be drawn by a second copy of the rule. The
// server answers /hub-api/routes/traffic from it; the map re-runs it on every animation
// frame so ships keep moving between fetches instead of teleporting once a minute.
//   • Node:    require('../../public/js/utils/fleet-traffic.js')
//   • Browser: import '../utils/fleet-traffic.js';  then read globalThis.AWFleetTraffic
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWFleetTraffic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

const HOUR = 3600 * 1000;

// A route stays on the map this long after its last arrival, so a move that just landed is
// still visible to the people who were watching for it.
const KEEP_ARRIVED_MS = 2 * HOUR;

function toMs(t) {
    if (t instanceof Date) return t.getTime();
    if (typeof t === 'number') return Number.isFinite(t) ? t : null;
    if (typeof t === 'string') {
        const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t;
        const ms = Date.parse(iso);
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

/**
 * Which leg a route is on at `now`, and how far along it.
 *
 * legs: [{ from: {x, y, ...}, to: {x, y, ...}, departsAt, arrivesAt }] in order.
 * Returns:
 *   { status: 'unscheduled' }            — no leg carries times; a plan with no position
 *   { status: 'pending', startsInMs }    — scheduled, not yet departed
 *   { status: 'flying', legIndex, fraction, from, to, arrivesAt }
 *   { status: 'arrived', arrivedAt }
 *
 * A fraction is clamped to [0, 1]: a leg whose end times are equal (a zero-length hop, or
 * a rounding artefact) would otherwise divide by zero and put the ship at infinity.
 */
function legStateAt(legs, now = Date.now()) {
    const list = (legs || []).map(l => ({
        ...l,
        departs: toMs(l.departsAt),
        arrives: toMs(l.arrivesAt),
    }));
    const timed = list.filter(l => l.departs !== null && l.arrives !== null);
    if (!timed.length) return { status: 'unscheduled' };

    const first = timed[0], last = timed[timed.length - 1];
    if (now < first.departs) return { status: 'pending', startsInMs: first.departs - now, departsAt: first.departs };
    if (now >= last.arrives) return { status: 'arrived', arrivedAt: last.arrives };

    for (let i = 0; i < timed.length; i++) {
        const leg = timed[i];
        if (now >= leg.departs && now < leg.arrives) {
            const span = leg.arrives - leg.departs;
            const fraction = span > 0 ? Math.max(0, Math.min(1, (now - leg.departs) / span)) : 1;
            return {
                status: 'flying',
                legIndex: list.indexOf(leg),
                fraction,
                from: leg.from,
                to: leg.to,
                arrivesAt: leg.arrives,
                legArrivesAt: leg.arrives,
            };
        }
        // Between two legs — a gap left by rounding, or a route whose legs were scheduled
        // with a pause. The fleet is at the end of the leg it finished, not in deep space
        // between two positions it was never at.
        const next = timed[i + 1];
        if (next && now >= leg.arrives && now < next.departs) {
            return {
                status: 'flying', legIndex: list.indexOf(leg), fraction: 1,
                from: leg.from, to: leg.to, arrivesAt: next.departs, legArrivesAt: leg.arrives,
            };
        }
    }
    return { status: 'arrived', arrivedAt: last.arrives };
}

/**
 * The position of a fleet part-way along a leg, plus the heading to point the glyph at.
 * Straight-line: the game flies a leg at constant speed between two fixed points.
 */
function positionFor(from, to, fraction) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    const x = from.x + (to.x - from.x) * f;
    const y = from.y + (to.y - from.y) * f;
    return { x, y, heading: Math.atan2(to.y - from.y, to.x - from.x) };
}

/**
 * Every route worth drawing at `now`, with a position for the ones in flight.
 *
 * Routes whose last arrival is more than `keepArrivedMs` in the past are dropped: the map
 * is a picture of now, not an archive, and the route planner already keeps the history.
 */
function shipsFor(routes, { now = Date.now(), keepArrivedMs = KEEP_ARRIVED_MS } = {}) {
    const out = [];
    for (const route of routes || []) {
        const legs = (route.legs || []).filter(l => l.from && l.to
            && Number.isFinite(l.from.x) && Number.isFinite(l.from.y)
            && Number.isFinite(l.to.x) && Number.isFinite(l.to.y));
        if (!legs.length) continue;

        const state = legStateAt(legs, now);
        if (state.status === 'arrived' && (now - state.arrivedAt) > keepArrivedMs) continue;

        const entry = {
            id: route.id,
            title: route.title || null,
            author: route.author || null,
            isAllianceMove: !!route.isAllianceMove,
            status: state.status,
            legs: legs.map(l => ({ from: l.from, to: l.to, departsAt: toMs(l.departsAt), arrivesAt: toMs(l.arrivesAt) })),
            position: null,
            heading: null,
            legIndex: state.legIndex != null ? state.legIndex : null,
            etaMs: null,
        };

        if (state.status === 'flying') {
            const { x, y, heading } = positionFor(state.from, state.to, state.fraction);
            entry.position = { x, y };
            entry.heading = heading;
            entry.etaMs = state.arrivesAt - now;
        } else if (state.status === 'pending') {
            // Sitting on the launch pad: drawn at the origin, not in space.
            entry.position = { x: legs[0].from.x, y: legs[0].from.y };
            entry.heading = positionFor(legs[0].from, legs[0].to, 0).heading;
            entry.startsInMs = state.startsInMs;
        } else if (state.status === 'arrived') {
            const lastLeg = legs[legs.length - 1];
            entry.position = { x: lastLeg.to.x, y: lastLeg.to.y };
            entry.arrivedAt = state.arrivedAt;
        }
        out.push(entry);
    }
    return out;
}

/**
 * Sighted fleets with a landing time still ahead of them.
 *
 * No course, on purpose: the scrape saw a destination and a clock, never an origin. What
 * comes back is a destination, a countdown and who owns it.
 */
function inboundMarkers(fleets, { now = Date.now() } = {}) {
    const out = [];
    for (const fleet of fleets || []) {
        const arrivesAt = toMs(fleet.arrival_at);
        if (arrivesAt === null || arrivesAt <= now) continue;
        if (!Number.isFinite(fleet.x) || !Number.isFinite(fleet.y)) continue;
        out.push({
            system_id: fleet.system_id,
            system_name: fleet.system_name || null,
            planet_index: fleet.planet_index,
            x: fleet.x,
            y: fleet.y,
            owner: fleet.owner_name || null,
            tag: fleet.tag || null,
            cv: Number(fleet.combat_value) || 0,
            ships: {
                destroyers: Number(fleet.destroyers) || 0,
                cruisers: Number(fleet.cruisers) || 0,
                battleships: Number(fleet.battleships) || 0,
            },
            arrivesAt,
            etaMs: arrivesAt - now,
        });
    }
    return out.sort((a, b) => a.etaMs - b.etaMs);
}

    return { HOUR, KEEP_ARRIVED_MS, toMs, legStateAt, positionFor, shipsFor, inboundMarkers };
});
