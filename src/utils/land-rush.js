// How much of the galaxy is still unclaimed, how fast it is going, and where the last of
// it is.
//
// ─── THE NUMBER NOBODY WAS LOOKING AT ─────────────────────────────────────────
// The hub records an OWNER_CHANGE event every time a planet's owner changes, and has done
// since the round opened. 1138 of them so far. 974 are colonisations — a planet that had
// no owner acquiring one — and they arrive at roughly 36 a day, every day, with no sign of
// slowing.
//
// Against that, the planets table currently holds 467 planets last observed with no owner.
//
//     467 free / 36.5 claimed per day ≈ 13 days until there is nothing left to colonise
//
// (9.7 days counting only the 353 of those the hub has actually looked at in the last
// three days — see below for why that second number is the more honest one.)
//
// Nothing in the hub says this. The Planets panel can filter to free planets, which answers
// "where can I settle" but not "for how long" — and those are different decisions. A round
// where free land runs out in under a fortnight is a round where expansion beats economy
// now and stops being an option later.
//
// ─── WHY THE SNAPSHOT ALONE WOULD LIE ─────────────────────────────────────────
// "467 free" is not a fact about the galaxy, it is a fact about the hub's last look at each
// planet. A planet scanned nine days ago and recorded free is evidence about nine days ago.
// In a land rush that is precisely the evidence most likely to be stale, and in exactly the
// direction that flatters the number: planets get taken, not released.
//
// So everything here carries its observation age, and:
//
//   - the headline free count is split by freshness, never reported as one number
//   - the exhaustion projection runs off a chosen freshness horizon, and says which
//   - the claim RATE comes from events, not from differencing snapshots. An event is an
//     observed transition with a timestamp; a snapshot difference is two guesses subtracted
//
// The projection is a straight line through the last N days of events. That is stated
// wherever it is shown, because the honest thing about a linear extrapolation is the word
// "linear" — a land rush that accelerates as the free planets get closer together, or
// stalls when only the awkward ones are left, will not follow it.

const travelModel = require('../../public/js/utils/travel-model.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Freshness buckets for an observation, in hours. A planet last seen free eight days ago
// is not evidence of anything much, and is counted apart rather than dropped, so the gap
// between "we think it is free" and "we checked recently" stays visible.
const FRESHNESS_HOURS = [24, 72, 168];

function toMs(t) {
    if (t instanceof Date) return t.getTime();
    if (typeof t === 'number') return t;
    if (typeof t === 'string') {
        // SQLite's "YYYY-MM-DD HH:MM:SS" is UTC with no zone marker; ISO strings carry
        // their own. Both appear in this database.
        const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t;
        const ms = new Date(iso).getTime();
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

/**
 * Free-planet rows -> counts by how recently each was observed.
 * rows: [{ system_id, planet_index, observed_at }]
 */
function freshnessBuckets(rows, { now = Date.now() } = {}) {
    const buckets = FRESHNESS_HOURS.map(hours => ({ withinHours: hours, planets: 0 }));
    const older = { withinHours: null, planets: 0 };
    let unknown = 0;
    for (const row of rows || []) {
        const at = toMs(row.observed_at);
        if (at === null) { unknown++; continue; }
        const ageHours = (now - at) / HOUR;
        const bucket = buckets.find(b => ageHours <= b.withinHours);
        (bucket || older).planets++;
    }
    return { buckets, older, unknown, total: (rows || []).length };
}

/** How many of those free planets were observed within `hours`. */
function freeWithin(rows, hours, { now = Date.now() } = {}) {
    return (rows || []).filter(row => {
        const at = toMs(row.observed_at);
        return at !== null && (now - at) / HOUR <= hours;
    }).length;
}

/**
 * Colonisation events -> claims per day.
 *
 * events: [{ timestamp, system_id, alliance_tag }] — already filtered to colonisations by
 * the caller (a conquest moves a planet between owners and does not consume free land).
 * The day the window opens on is excluded from the mean when it is partial, because a
 * half day of events divided by a whole day is a rate that is wrong by construction.
 */
function claimRate(events, { now = Date.now(), windowDays = 7 } = {}) {
    const from = now - windowDays * DAY;
    const perDay = new Map();
    let counted = 0;
    for (const event of events || []) {
        const at = toMs(event.timestamp);
        if (at === null || at < from || at > now) continue;
        perDay.set(dayKey(at), (perDay.get(dayKey(at)) || 0) + 1);
        counted++;
    }

    // Only UTC days lying WHOLLY inside the window are averaged. Deciding that by position
    // in the list — "drop the first and last" — is wrong twice over: the first day in the
    // window may be complete, the last may have no events at all and so not be in the list,
    // and either way a partial day divided by a whole day is a rate that is low by
    // construction. A day inside the window with no claims is a real zero and IS averaged
    // in; dropping it would let a quiet stretch read as fast as a busy one.
    const rated = [];
    for (let start = Math.ceil(from / DAY) * DAY; start + DAY <= now; start += DAY) {
        rated.push({ date: dayKey(start), claims: perDay.get(dayKey(start)) || 0 });
    }
    const basis = rated.length ? rated : [...perDay.entries()].map(([date, claims]) => ({ date, claims }));
    const rate = basis.length ? basis.reduce((n, d) => n + d.claims, 0) / basis.length : 0;

    return {
        claims: counted,
        windowDays,
        days: [...perDay.entries()].sort().map(([date, claims]) => ({ date, claims })),
        ratedDays: rated,
        claimsPerDay: rate,
        ratedOnDays: basis.length,
        partialDaysExcluded: rated.length > 0,
    };
}

function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * When the free planets run out, if the last `windowDays` repeat themselves exactly.
 * Returns null when nothing is being claimed — an unchanging galaxy has no deadline.
 */
function projectExhaustion(freeCount, claimsPerDay, { now = Date.now() } = {}) {
    if (!(claimsPerDay > 0) || !(freeCount > 0)) return null;
    const days = freeCount / claimsPerDay;
    return { days, at: now + days * DAY, linear: true };
}

/**
 * Per-system view of what is left: how many free planets, how stale that belief is, who
 * has been claiming there lately, and how far it is from home.
 *
 * free:     [{ system_id, planet_index, observed_at }]
 * events:   [{ system_id, timestamp, alliance_tag }] colonisations
 * systems:  [{ id, name, x, y }]
 * origin:   { x, y } or null — distances are omitted without one
 */
function systemFrontier(free, events, systems, { now = Date.now(), windowDays = 7, origin = null } = {}) {
    const byId = new Map((systems || []).map(s => [s.id, s]));
    const rows = new Map();

    const row = (systemId) => {
        if (!rows.has(systemId)) {
            const system = byId.get(systemId) || null;
            rows.set(systemId, {
                system_id: systemId,
                name: system ? system.name : null,
                x: system ? system.x : null,
                y: system ? system.y : null,
                freePlanets: 0,
                oldestObservationHours: null,
                newestObservationHours: null,
                recentClaims: 0,
                claimingTags: [],
                // Claims by a player in no alliance, or in one the hub has never indexed.
                // Counted apart so a system busy with unallied settlers does not read as
                // an empty row next to "3 recent claims".
                unalliedClaims: 0,
                distance: null,
            });
        }
        return rows.get(systemId);
    };

    for (const planet of free || []) {
        const entry = row(planet.system_id);
        entry.freePlanets++;
        const at = toMs(planet.observed_at);
        if (at === null) continue;
        const ageHours = (now - at) / HOUR;
        if (entry.oldestObservationHours === null || ageHours > entry.oldestObservationHours) entry.oldestObservationHours = ageHours;
        if (entry.newestObservationHours === null || ageHours < entry.newestObservationHours) entry.newestObservationHours = ageHours;
    }

    const from = now - windowDays * DAY;
    const tags = new Map();
    for (const event of events || []) {
        const at = toMs(event.timestamp);
        if (at === null || at < from || at > now) continue;
        const entry = row(event.system_id);
        entry.recentClaims++;
        const key = event.system_id;
        if (!tags.has(key)) tags.set(key, new Map());
        const tag = event.alliance_tag || null;
        if (tag) tags.get(key).set(tag, (tags.get(key).get(tag) || 0) + 1);
        else entry.unalliedClaims++;
    }
    for (const [systemId, counts] of tags) {
        row(systemId).claimingTags = [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([tag, claims]) => ({ tag, claims }));
    }

    const out = [...rows.values()];
    if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
        for (const entry of out) {
            if (Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
                entry.distance = travelModel.systemDistance(origin.x, origin.y, entry.x, entry.y);
            }
        }
    }

    // Most left, then most contested, then nearest — the order someone deciding where to
    // send a colony ship reads in.
    out.sort((a, b) => b.freePlanets - a.freePlanets
        || b.recentClaims - a.recentClaims
        || (a.distance === null ? Infinity : a.distance) - (b.distance === null ? Infinity : b.distance)
        || a.system_id - b.system_id);
    return out;
}

/**
 * Systems where more than one alliance has been claiming inside the window. Two alliances
 * settling the same system is the shape a border takes before anyone calls it one.
 */
function contestedSystems(frontier) {
    return (frontier || [])
        .filter(s => s.claimingTags.length > 1)
        .sort((a, b) => b.recentClaims - a.recentClaims || b.claimingTags.length - a.claimingTags.length);
}

/**
 * The centre of mass of one alliance's recent claims, and how far it has moved from the
 * centre of its earlier ones. A front is not a place, it is a direction.
 *
 * Returns null when either half of the window is empty — two points are needed for a line.
 */
function expansionDrift(events, systems, { now = Date.now(), windowDays = 14 } = {}) {
    const byId = new Map((systems || []).map(s => [s.id, s]));
    const half = now - (windowDays / 2) * DAY;
    const from = now - windowDays * DAY;
    const early = [], late = [];
    for (const event of events || []) {
        const at = toMs(event.timestamp);
        if (at === null || at < from || at > now) continue;
        const system = byId.get(event.system_id);
        if (!system || !Number.isFinite(system.x) || !Number.isFinite(system.y)) continue;
        (at < half ? early : late).push(system);
    }
    if (!early.length || !late.length) return null;
    const centre = list => ({
        x: list.reduce((n, s) => n + s.x, 0) / list.length,
        y: list.reduce((n, s) => n + s.y, 0) / list.length,
    });
    const a = centre(early), b = centre(late);
    return {
        early: { ...a, claims: early.length },
        late: { ...b, claims: late.length },
        moved: travelModel.systemDistance(a.x, a.y, b.x, b.y),
    };
}

module.exports = {
    FRESHNESS_HOURS,
    toMs,
    freshnessBuckets,
    freeWithin,
    claimRate,
    projectExhaustion,
    systemFrontier,
    contestedSystems,
    expansionDrift,
};
