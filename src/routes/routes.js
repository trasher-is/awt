const express = require('express');
const db = require('../database');
const { requireAuth } = require('./_middleware');
const { calcTravelSeconds, formatTime } = require('../utils/travel-calc');
const { postEmbed, defuseMentions } = require('../utils/discord-post');
const systemsRepo = require('../repositories/systems');
const routingRepo = require('../repositories/routing');
const alliancesRepo = require('../repositories/alliances');
const playersRepo = require('../repositories/players');
const settingsRepo = require('../repositories/settings');

const router = express.Router();

const MAX_LEGS = 6;             // start -> jump -> ... -> target; more than this is a campaign, not a route
const DEFAULT_TTL_DAYS = 7;     // an unscheduled route expires after this
const KEEP_AFTER_ARRIVAL_H = 24; // a scheduled route lingers this long past arrival
// SQLite timestamps and datetime-local use four-digit years. Reject overflow before
// converting the expiry to its sortable SQLite representation.
const MIN_SCHEDULE_MS = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_SCHEDULE_MS = Date.parse('9999-12-31T23:59:59.999Z');

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────
// One validation step for preview, create and update, run BEFORE any calculation or
// database write. Before this (issue #130) the preview checked the waypoint array's length
// and then dereferenced each element: {"waypoints":[null,{}]} answered 500 with a
// TypeError. parseInt also accepted "12abc" as 12, and the planet index had no server-side
// upper bound although the panel declares max=12.
//
// The ranges enforced here are the ones the game documents (docs/game-rules.md):
//   • a system has 12 planet slots, so a planet index is 1..12;
//   • a race pick is an integer in -4..+4 (the "known range"; the panel offers the same);
//   • energy and biology are science LEVELS: whole numbers from 0 up, with no documented
//     ceiling — so only non-negativity and integrality are checked, nothing invented.
const MAX_PLANET_INDEX = 12;
const RACE_PICK_MIN = -4, RACE_PICK_MAX = 4;

// Strict: the whole string must be an integer. parseInt('12abc') === 12 is the failure
// this replaces. Numbers must already be integers; booleans, arrays and objects are not
// numbers even though Number() would happily coerce some of them.
function strictInt(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
    if (typeof value === 'string' && /^\s*[+-]?\d{1,12}\s*$/.test(value)) return parseInt(value, 10);
    return NaN;
}

const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// A new arrival anchor always identifies an instant, independent of the hub's TZ.
// Preserve the older plannedStartAt parser for existing API clients. Date.parse alone
// accepts local timestamps and silently rolls February 30 into March.
function isArrivalTimestamp(value) {
    if (typeof value !== 'string') return false;
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!parts) return false;
    const [year, month, day, hour, minute, second] = parts.slice(1).map(part => Number(part || 0));
    // A 400-year shift avoids Date.UTC's special interpretation of years 0..99.
    const daysInMonth = new Date(Date.UTC(2000 + year % 400, month, 0)).getUTCDate();
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth
        && hour <= 23 && minute <= 59 && second <= 59;
}

function invalid(field, message) {
    return { error: message, field };
}

/**
 * Validate and normalise a preview/create/update body. Returns either
 *   { error, field }                      — answer 400 with exactly this object, or
 *   { value: { waypoints, energy, raceSpeed, biology, isAllianceMove, plannedStartAt, targetArrivalAt,
 *              visibility, title, note } } — safe to calculate with and to store.
 */
function validateRouteInput(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

    const waypoints = b.waypoints;
    if (!Array.isArray(waypoints) || waypoints.length < 2) {
        return invalid('waypoints', 'A route needs at least a start and a target.');
    }
    if (waypoints.length > MAX_LEGS + 1) {
        return invalid('waypoints', `A route can have at most ${MAX_LEGS} legs.`);
    }
    const cleanWaypoints = [];
    for (let i = 0; i < waypoints.length; i++) {
        const w = waypoints[i];
        const field = `waypoints[${i}]`;
        if (w === null || typeof w !== 'object' || Array.isArray(w)) {
            return invalid(field, `Stop ${i + 1} is not a waypoint object.`);
        }
        const systemId = strictInt(w.systemId);
        if (!Number.isInteger(systemId) || systemId <= 0) {
            return invalid(`${field}.systemId`, `Stop ${i + 1} needs a system id.`);
        }
        // Absent means "planet 1", which is what the panel has always sent by default —
        // but a value that IS given has to be a real slot.
        let planetIndex = 1;
        if (!isBlank(w.planetIndex)) {
            planetIndex = strictInt(w.planetIndex);
            if (!Number.isInteger(planetIndex) || planetIndex < 1 || planetIndex > MAX_PLANET_INDEX) {
                return invalid(`${field}.planetIndex`, `Stop ${i + 1}: planet must be a whole number from 1 to ${MAX_PLANET_INDEX}.`);
            }
        }
        cleanWaypoints.push({ systemId, planetIndex });
    }

    const level = (name, label) => {
        if (isBlank(b[name])) return 0;
        const n = strictInt(b[name]);
        if (!Number.isInteger(n) || n < 0) return invalid(name, `${label} must be a whole number of 0 or more.`);
        return n;
    };
    const energy = level('energy', 'Energy');
    if (typeof energy === 'object') return energy;
    const biology = level('biology', 'Biology');
    if (typeof biology === 'object') return biology;

    let raceSpeed = 0;
    if (!isBlank(b.raceSpeed)) {
        raceSpeed = strictInt(b.raceSpeed);
        if (!Number.isInteger(raceSpeed) || raceSpeed < RACE_PICK_MIN || raceSpeed > RACE_PICK_MAX) {
            return invalid('raceSpeed', `Race speed must be a whole number from ${RACE_PICK_MIN} to +${RACE_PICK_MAX}.`);
        }
    }

    if (!isBlank(b.plannedStartAt) && !isBlank(b.targetArrivalAt)) {
        return invalid('targetArrivalAt', 'Choose either a planned start or a target arrival, not both.');
    }
    const anchors = { plannedStartAt: null, targetArrivalAt: null };
    for (const [field, label] of [['plannedStartAt', 'Planned start'], ['targetArrivalAt', 'Target arrival']]) {
        if (isBlank(b[field])) continue;
        const ms = typeof b[field] === 'string' ? Date.parse(b[field]) : NaN;
        if ((field === 'targetArrivalAt' && !isArrivalTimestamp(b[field]))
            || !Number.isFinite(ms) || ms < MIN_SCHEDULE_MS || ms > MAX_SCHEDULE_MS) {
            return invalid(field, `${label} is not a supported date.`);
        }
        anchors[field] = new Date(ms).toISOString();
    }

    let visibility = 'alliance';
    if (!isBlank(b.visibility)) {
        if (b.visibility !== 'alliance' && b.visibility !== 'private') {
            return invalid('visibility', 'Visibility must be "alliance" or "private".');
        }
        visibility = b.visibility;
    }

    for (const name of ['title', 'note']) {
        if (!isBlank(b[name]) && typeof b[name] !== 'string') return invalid(name, `${name[0].toUpperCase() + name.slice(1)} must be text.`);
    }

    return {
        value: {
            waypoints: cleanWaypoints,
            energy, raceSpeed, biology,
            isAllianceMove: !!b.isAllianceMove,
            ...anchors,
            visibility,
            title: String(b.title || '').slice(0, 120) || null,
            note: String(b.note || '').slice(0, 1000) || null,
        }
    };
}

// Legs are computed on the server so that everyone sees the same numbers. The travel
// formula lives in src/utils/travel-calc.js; the biology requirement uses the same rule
// as the !dist command (bio needed = ceil of the vector distance between the systems).
function bioNeededFor(distance) {
    return Math.ceil(distance);
}

// Issue #147: which alliance tags count as "friendly" for the automatic halving rule —
// our own alliance (derived the same way the Galaxy Archive's own-tag detection works: via
// app-linked members' current alliance) plus whatever's configured in Admin -> Alliance
// Relations (the allied list from issue #114). A route to a planet owned by either gets the
// alliance/own-destination travel-time halving automatically, without the member having to
// know and manually tick a box.
function friendlyAllianceTags() {
    const memberIds = alliancesRepo.getAllianceMemberStatIds().map(r => r.player_id);
    const ownTag = (playersRepo.getAllianceTagForMembers(memberIds) || {}).tag || null;
    const tags = new Set(settingsRepo.getTagListSetting('alliance_relations_allied'));
    if (ownTag) tags.add(String(ownTag).toUpperCase());
    return tags;
}

function loadSystems(ids) {
    if (!ids.length) return new Map();
    const rows = systemsRepo.getSystemsByIds(ids);
    return new Map(rows.map(r => [r.id, r]));
}

/**
 * Turn a list of waypoints into legs with distance, travel time and biology requirement.
 * waypoints: [{ systemId, planetIndex }, ...] — at least two, already validated by
 * validateRouteInput (integers in range). Returns { legs, totalSeconds } or { error, field }.
 */
function buildLegs(waypoints, { energy, raceSpeed, isAllianceMove, biology }) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) {
        return invalid('waypoints', 'A route needs at least a start and a target.');
    }
    if (waypoints.length > MAX_LEGS + 1) {
        return invalid('waypoints', `A route can have at most ${MAX_LEGS} legs.`);
    }

    const ids = [...new Set(waypoints.map(w => w.systemId))];
    const systems = loadSystems(ids);

    for (let i = 0; i < waypoints.length; i++) {
        const w = waypoints[i];
        const sys = systems.get(w.systemId);
        if (!sys) return invalid(`waypoints[${i}].systemId`, `System #${w.systemId} is not in the database — scan it in-game first.`);
        if (sys.x == null || sys.y == null) return invalid(`waypoints[${i}].systemId`, `System #${w.systemId} has no coordinates recorded yet.`);
    }

    // Issue #147: auto-detect which legs land on an own/allied planet instead of relying on
    // one manual checkbox applied uniformly to the whole route. Batched over every
    // DESTINATION (waypoints[1:] — a route's first stop is never a leg's target) so this is
    // one query regardless of leg count, not one per leg.
    const friendlyTags = friendlyAllianceTags();
    const destinations = waypoints.slice(1).map(w => ({ systemId: w.systemId, planetIndex: w.planetIndex }));
    const ownersByLocation = systemsRepo.getPlanetOwnersByLocations(destinations);

    const legs = [];
    let totalSeconds = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const sa = systems.get(a.systemId);
        const sb = systems.get(b.systemId);
        const ap = a.planetIndex;
        const bp = b.planetIndex;

        const destTag = ownersByLocation.get(`${b.systemId}:${b.planetIndex}`);
        const autoAllianceMove = destTag != null && friendlyTags.has(String(destTag).toUpperCase());
        // The manual checkbox still ORs in as an override — for a destination our own data
        // doesn't know about yet (never scanned, or a future colony), the member can still
        // force the halving by hand.
        const legIsAllianceMove = !!isAllianceMove || autoAllianceMove;

        const dx = sb.x - sa.x, dy = sb.y - sa.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const seconds = calcTravelSeconds(sa.x, sa.y, ap, sb.x, sb.y, bp, energy, raceSpeed, legIsAllianceMove);
        const bioNeeded = bioNeededFor(distance);
        // The inputs are integers in range, so this only trips on corrupt coordinates —
        // but a NaN or Infinity stored as travel_seconds would poison every list view.
        if (!Number.isFinite(seconds) || !Number.isFinite(distance)) {
            return invalid(`waypoints[${i + 1}].systemId`, `Travel time between #${sa.id} and #${sb.id} could not be calculated.`);
        }

        totalSeconds += seconds;
        legs.push({
            legIndex: i,
            from: { systemId: sa.id, systemName: sa.name, planetIndex: ap, x: sa.x, y: sa.y },
            to: { systemId: sb.id, systemName: sb.name, planetIndex: bp, x: sb.x, y: sb.y },
            distance: Math.round(distance * 100) / 100,
            isAllianceMove: legIsAllianceMove,
            autoAllianceMove, // so the UI can label it "auto-detected" vs. "forced by you"
            travelSeconds: seconds,
            travelTime: formatTime(seconds),
            bioNeeded,
            // Warning, not a block: intel on your own biology can be stale, and the
            // planner is also used to sketch routes for later.
            outOfReach: biology > 0 && bioNeeded > biology
        });
    }
    return { legs, totalSeconds };
}

// Attach arrival timestamps to each leg, given a planned departure.
function withSchedule(legs, plannedStartAt) {
    const startMs = plannedStartAt ? Date.parse(plannedStartAt) : NaN;
    if (isNaN(startMs)) return legs.map(l => ({ ...l, departsAt: null, arrivesAt: null }));
    let cursor = startMs;
    return legs.map(l => {
        const departsAt = new Date(cursor).toISOString();
        cursor += l.travelSeconds * 1000;
        return { ...l, departsAt, arrivesAt: new Date(cursor).toISOString() };
    });
}

function expiryFor(plannedStartAt, totalSeconds) {
    const startMs = plannedStartAt ? Date.parse(plannedStartAt) : NaN;
    if (!isNaN(startMs)) {
        return new Date(startMs + totalSeconds * 1000 + KEEP_AFTER_ARRIVAL_H * 3600 * 1000)
            .toISOString().replace('T', ' ').slice(0, 19);
    }
    return new Date(Date.now() + DEFAULT_TTL_DAYS * 86400 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
}

// Use the already-rounded per-leg durations, including each destination's alliance
// modifier. Working back from the final arrival then walking forward keeps every hop
// continuous, with no extra rounding or implicit waiting between legs.
function routeSchedule(legs, plannedStartAt, targetArrivalAt) {
    if (!plannedStartAt && !targetArrivalAt) {
        return { legs: withSchedule(legs, null), departsAt: null, arrivesAt: null,
            expiresAt: expiryFor(null, 0) };
    }
    const totalSeconds = legs.reduce((total, leg) => total + leg.travelSeconds, 0);
    const field = targetArrivalAt ? 'targetArrivalAt' : 'plannedStartAt';
    const startMs = targetArrivalAt ? Date.parse(targetArrivalAt) - totalSeconds * 1000 : Date.parse(plannedStartAt);
    const arrivalMs = startMs + totalSeconds * 1000;
    const expiryMs = arrivalMs + KEEP_AFTER_ARRIVAL_H * 3600 * 1000;
    if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 0
        || !Number.isFinite(startMs) || startMs < MIN_SCHEDULE_MS
        || !Number.isFinite(expiryMs) || expiryMs > MAX_SCHEDULE_MS) {
        return invalid(field, 'The route schedule is outside the supported date range.');
    }
    const departsAt = new Date(startMs).toISOString();
    return {
        legs: withSchedule(legs, departsAt),
        departsAt,
        arrivesAt: new Date(arrivalMs).toISOString(),
        expiresAt: expiryFor(departsAt, totalSeconds)
    };
}

// Routes rot fast — a plan for last Tuesday is noise. Sweep on read so the list is always
// current without needing a scheduler.
function purgeExpired() {
    try {
        const changes = routingRepo.purgeExpiredRoutes();
        if (changes > 0) console.log(`[Routes] Removed ${changes} expired route(s).`);
    } catch (err) {
        console.error('[Routes] Expiry sweep failed:', err.message);
    }
}

function hydrate(routeRows) {
    if (!routeRows.length) return [];
    const ids = routeRows.map(r => r.id);
    const legs = routingRepo.getRouteLegsForRouteIds(ids);

    const byRoute = new Map(ids.map(id => [id, []]));
    for (const l of legs) {
        byRoute.get(l.route_id).push({
            legIndex: l.leg_index,
            from: { systemId: l.from_system_id, systemName: l.from_system_name, planetIndex: l.from_planet_index, x: l.from_x, y: l.from_y },
            to: { systemId: l.to_system_id, systemName: l.to_system_name, planetIndex: l.to_planet_index, x: l.to_x, y: l.to_y },
            distance: l.distance,
            isAllianceMove: !!l.is_alliance_move,
            travelSeconds: l.travel_seconds,
            travelTime: formatTime(l.travel_seconds || 0),
            bioNeeded: l.bio_needed
        });
    }

    return routeRows.map(r => {
        // The reach warning is re-evaluated on read against the biology stored with the
        // route, so a shared route shows the same warning its author saw.
        const rl = (byRoute.get(r.id) || []).map(l => ({
            ...l,
            outOfReach: (r.biology || 0) > 0 && l.bioNeeded > r.biology
        }));
        const total = rl.reduce((s, l) => s + (l.travelSeconds || 0), 0);
        const schedule = routeSchedule(rl, r.planned_start_at, r.target_arrival_at);
        if (schedule.error) throw new Error(schedule.error);
        return {
            id: r.id,
            title: r.title,
            note: r.note,
            author: r.author_name || 'Unknown',
            authorId: r.author_id,
            plannedStartAt: r.planned_start_at,
            targetArrivalAt: r.target_arrival_at || null,
            departsAt: schedule.departsAt,
            arrivesAt: schedule.arrivesAt,
            energy: r.energy,
            raceSpeed: r.race_speed,
            isAllianceMove: !!r.is_alliance_move,
            biology: r.biology,
            visibility: r.visibility,
            expiresAt: r.expires_at,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            totalSeconds: total,
            totalTime: formatTime(total),
            legs: schedule.legs
        };
    });
}

// --- PREVIEW: compute a route without saving it (the panel calls this as you type) ---
router.post('/routes/preview', requireAuth, (req, res) => {
    const checked = validateRouteInput(req.body);
    if (checked.error) return res.status(400).json({ error: checked.error, field: checked.field });
    const { waypoints, energy, raceSpeed, isAllianceMove, biology, plannedStartAt, targetArrivalAt } = checked.value;

    const built = buildLegs(waypoints, { energy, raceSpeed, isAllianceMove, biology });
    if (built.error) return res.status(400).json({ error: built.error, field: built.field });

    const schedule = routeSchedule(built.legs, plannedStartAt, targetArrivalAt);
    if (schedule.error) return res.status(400).json({ error: schedule.error, field: schedule.field });
    res.json({
        success: true,
        plannedStartAt,
        targetArrivalAt,
        legs: schedule.legs,
        totalSeconds: built.totalSeconds,
        totalTime: formatTime(built.totalSeconds),
        departsAt: schedule.departsAt,
        arrivesAt: schedule.arrivesAt
    });
});

// --- LIST: own routes plus everything shared with the alliance ---
router.get('/routes', requireAuth, (req, res) => {
    try {
        purgeExpired();
        const rows = routingRepo.getRoutesForUser(req.session.userId);
        // Arrival-based plans have no planned_start_at. Sort after hydration so both
        // modes use the same computed departure and the saved duration snapshot.
        const routes = hydrate(rows).sort((a, b) => {
            const when = r => Date.parse(r.departsAt || `${r.createdAt.replace(' ', 'T')}Z`);
            return when(a) - when(b) || a.id - b.id;
        });
        res.json({ success: true, routes });
    } catch (err) {
        console.error('[DB Error] Failed to list routes:', err);
        res.status(500).json({ error: 'Failed to list routes' });
    }
});

router.get('/routes/:id', requireAuth, (req, res) => {
    try {
        const row = routingRepo.getRouteById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (row.visibility !== 'alliance' && row.author_id !== req.session.userId) {
            return res.status(403).json({ error: 'That route is private.' });
        }
        res.json({ success: true, route: hydrate([row])[0] });
    } catch (err) {
        console.error('[DB Error] Failed to load route:', err);
        res.status(500).json({ error: 'Failed to load route' });
    }
});

// Validation and the leg calculation both happen BEFORE the transaction opens: a rejected
// body must leave the database exactly as it was, including on an update.
function writeRoute(routeId, body, authorId) {
    const checked = validateRouteInput(body);
    if (checked.error) return { error: checked.error, field: checked.field };
    const { waypoints, energy, raceSpeed, biology, plannedStartAt, targetArrivalAt, visibility, title, note } = checked.value;
    const isAllianceMove = checked.value.isAllianceMove ? 1 : 0;

    const built = buildLegs(waypoints, { energy, raceSpeed, isAllianceMove: !!isAllianceMove, biology });
    if (built.error) return { error: built.error, field: built.field };

    const schedule = routeSchedule(built.legs, plannedStartAt, targetArrivalAt);
    if (schedule.error) return { error: schedule.error, field: schedule.field };
    const expiresAt = schedule.expiresAt;

    const tx = db.transaction(() => {
        let id = routeId;
        if (id) {
            routingRepo.updateRoute(id, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, targetArrivalAt);
            routingRepo.deleteRouteLegsForRoute(id);
        } else {
            id = routingRepo.insertRoute(authorId, title, note, plannedStartAt, energy, raceSpeed, isAllianceMove, biology, visibility, expiresAt, targetArrivalAt);
        }

        for (const l of built.legs) {
            routingRepo.insertRouteLeg(id, l.legIndex, l.from.systemId, l.from.planetIndex,
                    l.to.systemId, l.to.planetIndex, l.travelSeconds, l.distance, l.bioNeeded, l.isAllianceMove);
        }
        return id;
    });

    return { id: tx() };
}

router.post('/routes', requireAuth, (req, res) => {
    try {
        const out = writeRoute(null, req.body || {}, req.session.userId);
        if (out.error) return res.status(400).json({ error: out.error, field: out.field });
        res.json({ success: true, id: out.id });
    } catch (err) {
        console.error('[DB Error] Failed to save route:', err);
        res.status(500).json({ error: 'Failed to save route' });
    }
});

// Same rule as planet_plans: the author or an admin, nobody else. Orphaned rows (author
// deleted, so author_id is NULL) are editable by anyone so they can be cleaned up.
function mayModify(row, session) {
    return session.role === 'admin' || row.author_id === session.userId || row.author_id == null;
}

router.put('/routes/:id', requireAuth, (req, res) => {
    try {
        const row = routingRepo.getRouteOwnership(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (!mayModify(row, req.session)) {
            return res.status(403).json({ error: 'That route belongs to someone else. Ask them or an admin to change it.' });
        }
        const out = writeRoute(row.id, req.body || {}, row.author_id);
        if (out.error) return res.status(400).json({ error: out.error, field: out.field });
        res.json({ success: true, id: row.id });
    } catch (err) {
        console.error('[DB Error] Failed to update route:', err);
        res.status(500).json({ error: 'Failed to update route' });
    }
});

router.delete('/routes/:id', requireAuth, (req, res) => {
    try {
        const row = routingRepo.getRouteOwnership(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (!mayModify(row, req.session)) {
            return res.status(403).json({ error: 'That route belongs to someone else. Ask them or an admin to remove it.' });
        }
        routingRepo.deleteRouteLegsForRoute(row.id);
        routingRepo.deleteRoute(row.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[DB Error] Failed to delete route:', err);
        res.status(500).json({ error: 'Failed to delete route' });
    }
});

// --- ANNOUNCE: one click to the alliance Discord channel ---
router.post('/routes/:id/announce', requireAuth, async (req, res) => {
    try {
        const row = routingRepo.getRouteById(req.params.id);
        if (!row) return res.status(404).json({ error: 'Route not found' });
        if (row.visibility !== 'alliance' && row.author_id !== req.session.userId) {
            return res.status(403).json({ error: 'That route is private.' });
        }

        const route = hydrate([row])[0];
        const startLine = route.departsAt
            ? `Departs <t:${Math.floor(Date.parse(route.departsAt) / 1000)}:D> <t:${Math.floor(Date.parse(route.departsAt) / 1000)}:T> (<t:${Math.floor(Date.parse(route.departsAt) / 1000)}:R>)`
            : 'No planned start time';
        const targetLine = route.targetArrivalAt
            ? `Target arrival <t:${Math.floor(Date.parse(route.targetArrivalAt) / 1000)}:D> <t:${Math.floor(Date.parse(route.targetArrivalAt) / 1000)}:T>`
            : '';

        const legLines = route.legs.map(l => {
            const from = `[${l.from.systemId}] ${defuseMentions(l.from.systemName || '?')} #${l.from.planetIndex}`;
            const to = `[${l.to.systemId}] ${defuseMentions(l.to.systemName || '?')} #${l.to.planetIndex}`;
            const eta = l.arrivesAt ? ` — arrives <t:${Math.floor(Date.parse(l.arrivesAt) / 1000)}:T>` : '';
            const allied = l.isAllianceMove ? ' · allied' : '';
            return `**${l.legIndex + 1}.** ${from} → ${to}\n\`${l.travelTime}\` · dist ${l.distance} · bio ${l.bioNeeded}${allied}${eta}`;
        }).join('\n');

        // Issue #147: halving is now per-leg (auto-detected per destination), so a single
        // route-wide "halved" tag on the total would be misleading for a mixed route —
        // note it only when EVERY leg actually got it; each leg already says "allied" above.
        const allLegsAllied = route.legs.length > 0 && route.legs.every(l => l.isAllianceMove);
        const embed = {
            title: `🗺️ ${defuseMentions(route.title || 'Planned route')}`,
            color: 0x8b5cf6,
            description: [
                `by **${defuseMentions(route.author)}**`,
                startLine,
                targetLine,
                '',
                legLines,
                '',
                `**Total:** \`${route.totalTime}\`${allLegsAllied ? ' (allied move, halved)' : ''}`,
                route.note ? `\n${defuseMentions(route.note)}` : ''
            ].filter(Boolean).join('\n'),
            footer: { text: `Energy ${route.energy} · race speed ${route.raceSpeed >= 0 ? '+' : ''}${route.raceSpeed}` }
        };

        const result = await postEmbed('discord_announce_channel', embed);
        if (!result.ok) return res.status(502).json({ error: `Could not post to Discord: ${result.reason}` });
        res.json({ success: true, messageId: result.messageId });
    } catch (err) {
        console.error('[Routes] Announce failed:', err);
        res.status(500).json({ error: 'Announce failed' });
    }
});

module.exports = router;
module.exports.buildLegs = buildLegs;
module.exports.withSchedule = withSchedule;
module.exports.expiryFor = expiryFor;
module.exports.validateRouteInput = validateRouteInput;
module.exports.strictInt = strictInt;
module.exports.MAX_PLANET_INDEX = MAX_PLANET_INDEX;
