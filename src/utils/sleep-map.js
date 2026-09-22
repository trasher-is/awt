// When is a whole roster asleep? — the galaxy-wide version of the profile's quiet-window card.
//
// ─── WHY THIS EXISTS NEXT TO login-gaps.js ────────────────────────────────────
// public/js/utils/login-gaps.js answers "is this ONE player provably away right now, and
// which hours were quiet on EVERY observed day". That proof rule is deliberately strict:
// one login at 04:00 in fourteen days is enough to disqualify 04:00 forever. Run against
// the live database it returns nothing at all for most players — checked on the real
// roster, 9 of 10 enemy players had no proven window, because over two weeks almost
// everybody logs in at almost every hour at least once.
//
// That is the correct answer to "prove they are away". It is the wrong answer to the
// question a fleet commander actually asks, which is comparative:
//
//     of the people I could hit, who is LEAST likely to be at the keyboard when my
//     fleet lands, and at what hour is that true?
//
// So this module keeps login-gaps.js's evidence rule exactly — an interval between two
// consecutive scans is `active` when the login counter moved and `quiet` when it did not,
// and an hour is only classified when scans cover it — and changes only what is done with
// the classified hours: instead of requiring every observed day of an hour to be quiet, it
// counts them. Fourteen observations of 04:00 of which one was active is an 04:00 that is
// quiet 93% of the time, which is a real and usable fact about a target even though it is
// not a proof.
//
// ─── THE SCORE ────────────────────────────────────────────────────────────────
// Per hour of the day: `quietDays` out of `observedDays`, scored with a Laplace prior
//
//     sleepScore = (quietDays + 1) / (observedDays + 2)
//
// which is the point of the prior: an hour seen quiet once reads 0.67, not 1.00, so a
// barely-observed hour cannot outrank a well-observed one just by being lucky. The score
// is "probability this player does not log in during this hour", never a promise.
//
// ─── TIME BASE ────────────────────────────────────────────────────────────────
// Hours here are UTC hours of the day, because the epoch is aligned to UTC and hour
// bucketing is then exact integer arithmetic. The hub's own clock display converts for the
// viewer. That is a deliberate difference from login-gaps.js's local-calendar grid: this
// runs for the whole roster at once, and DST-correct per-viewer bucketing of ~160 players
// is not worth a per-minute walk of every day. The response carries UTC epoch times for
// every window it proposes, so the browser formats them in the viewer's own zone and
// nothing here has to know what zone that is.
//
// ─── COST ─────────────────────────────────────────────────────────────────────
// login-gaps.js's grid() re-scans the whole band list once per (day, hour) cell: for one
// player over 14 days that is 336 cells x ~1600 bands. Fine for one profile card, ~85M
// band comparisons for a 160-player roster. accumulate() below walks each band once and
// adds it to the hour cells it overlaps, which is linear in bands plus cells and gives the
// same classification — sleep-map.test.js asserts that equivalence against grid() itself
// rather than trusting this comment.

const gaps = require('../../public/js/utils/login-gaps.js');

const HOUR = 3600 * 1000;

// Hours whose scans do not cover the whole hour are not counted at all (same rule as
// login-gaps.js): a half-covered hour says nothing about the half nobody watched.
const COVERAGE_SLACK_MS = 1000;

/**
 * Walk the bands once and classify every absolute hour cell they touch.
 * Returns a Map of hourIndex (epoch ms / HOUR, floored) -> { active, quiet }.
 */
function accumulate(bandList) {
    const cells = new Map();
    for (const band of bandList) {
        let cursor = band.start;
        while (cursor < band.end) {
            const index = Math.floor(cursor / HOUR);
            const cellEnd = (index + 1) * HOUR;
            const chunkEnd = Math.min(cellEnd, band.end);
            let cell = cells.get(index);
            if (!cell) { cell = { active: 0, quiet: 0 }; cells.set(index, cell); }
            cell[band.kind === 'active' ? 'active' : 'quiet'] += chunkEnd - cursor;
            cursor = chunkEnd;
        }
    }
    return cells;
}

/**
 * Every absolute hour cell in [now - days, now], classified by login-gaps.js's rule.
 * Returns { cells: Map(hourIndex -> 'active' | 'quiet'), candidates } — an hour nobody's
 * scans covered is absent from the map rather than guessed at.
 */
function classifyHourCells(samples, { now = Date.now(), days = 14 } = {}) {
    const from = now - days * 24 * HOUR;
    const totals = accumulate(gaps.bands(gaps.normalise(samples), from, now));
    const cells = new Map();
    let candidates = 0;
    for (let index = Math.floor(from / HOUR); index <= Math.floor(now / HOUR); index++) {
        const cellStart = index * HOUR;
        // The hour in progress only runs up to now, and the oldest cell may start before
        // the window; both are scored against the part that could actually be observed.
        const span = Math.min(now, cellStart + HOUR) - Math.max(from, cellStart);
        if (span <= 0) continue;
        candidates++;
        const total = totals.get(index);
        if (!total) continue;
        if (total.active > 0) cells.set(index, 'active');
        else if (total.quiet >= span - COVERAGE_SLACK_MS) cells.set(index, 'quiet');
    }
    return { cells, candidates };
}

/**
 * One player's samples -> per-UTC-hour-of-day counts and scores.
 *
 * samples: [{ t, n }] as stored — SQLite UTC strings are understood, see login-gaps.toMs.
 * Returns { hours: [24 x {hour, quietDays, activeDays, observedDays, sleepScore}],
 *           sampleCount, quietSince, coverage }.
 */
function hourProfile(samples, { now = Date.now(), days = 14 } = {}) {
    const from = now - days * 24 * HOUR;
    const normalised = gaps.normalise(samples);
    const { cells, candidates } = classifyHourCells(normalised, { now, days });

    const hours = Array.from({ length: 24 }, (_, hour) => ({
        hour, quietDays: 0, activeDays: 0, observedDays: 0, sleepScore: 0.5,
    }));

    for (const [index, kind] of cells) {
        const bucket = hours[((index % 24) + 24) % 24];
        if (kind === 'active') bucket.activeDays++; else bucket.quietDays++;
        bucket.observedDays++;
    }

    for (const bucket of hours) {
        bucket.sleepScore = (bucket.quietDays + 1) / (bucket.observedDays + 2);
    }

    return {
        hours,
        sampleCount: normalised.filter(s => s.t >= from && s.t <= now).length,
        quietSince: gaps.quietSince(normalised),
        coverage: candidates ? cells.size / candidates : 0,
    };
}

/**
 * The longest circular run of hours whose sleepScore is at or above `threshold`, ignoring
 * hours nobody has observed at least `minObserved` times. This is the "they are usually
 * away between X and Y" line, and unlike login-gaps.windows() it tolerates the occasional
 * login inside the run — that is the whole point of the score.
 *
 * Returns null when no hour qualifies.
 */
function troughWindow(hours, { threshold = 0.8, minObserved = 3 } = {}) {
    const eligible = hours.map(h => h.observedDays >= minObserved && h.sleepScore >= threshold);
    if (eligible.every(Boolean)) {
        return { startHour: 0, endHour: 0, hours: 24, meanScore: mean(hours.map(h => h.sleepScore)) };
    }
    const firstGap = eligible.indexOf(false);
    if (firstGap === -1) return null;

    let best = null, run = null;
    for (let step = 1; step <= 24; step++) {
        const hour = (firstGap + step) % 24;
        if (eligible[hour]) {
            if (!run) run = { startHour: hour, hours: 0, scores: [] };
            run.hours++;
            run.scores.push(hours[hour].sleepScore);
        } else if (run) {
            best = better(best, run);
            run = null;
        }
    }
    best = better(best, run);
    if (!best) return null;
    return {
        startHour: best.startHour,
        endHour: (best.startHour + best.hours) % 24,
        hours: best.hours,
        meanScore: mean(best.scores),
    };
}

function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

// Longer run wins; equal length is broken by the quieter mean, so "04-08 at 0.95" beats
// "13-17 at 0.81" rather than whichever happened to be found first.
function better(current, candidate) {
    if (!candidate) return current;
    const score = mean(candidate.scores);
    if (!current) return { ...candidate, mean: score };
    if (candidate.hours > current.hours) return { ...candidate, mean: score };
    if (candidate.hours === current.hours && score > current.mean) return { ...candidate, mean: score };
    return current;
}

/**
 * Launch times whose ARRIVAL lands in the target's quietest hours.
 *
 * This is the join the hub could not make before: the profile card knows when a player is
 * away and the route planner knows how long a fleet takes, but nobody multiplied them. A
 * fleet that leaves at a convenient hour for the attacker and lands at the defender's
 * breakfast has thrown the intel away.
 *
 * `travelHours` may be fractional. Arrivals are evaluated on whole UTC hours inside
 * [now + travel, now + travel + horizonHours]; the launch time is simply arrival - travel,
 * and launches already in the past are impossible and dropped.
 *
 * Returns [{ launchAt, arriveAt, arrivalHour, sleepScore, observedDays }] best first.
 */
function bestLaunchWindows(hours, { now = Date.now(), travelHours = 0, horizonHours = 48, top = 3 } = {}) {
    const travelMs = Math.max(0, travelHours) * HOUR;
    const earliest = now + travelMs;
    const out = [];
    const firstHour = Math.ceil(earliest / HOUR);
    for (let index = firstHour; index * HOUR <= earliest + horizonHours * HOUR; index++) {
        const arriveAt = index * HOUR;
        const launchAt = arriveAt - travelMs;
        if (launchAt < now) continue;
        const bucket = hours[((index % 24) + 24) % 24];
        out.push({
            launchAt,
            arriveAt,
            arrivalHour: bucket.hour,
            sleepScore: bucket.sleepScore,
            observedDays: bucket.observedDays,
        });
    }
    // Quietest first; a tie goes to the sooner launch, because intel ages.
    out.sort((a, b) => b.sleepScore - a.sleepScore || a.launchAt - b.launchAt);
    return out.slice(0, Math.max(0, top));
}

/**
 * Full analysis for one player: the profile, its trough, how quiet the hour we are in
 * right now is, and — when a travel time is supplied — the launch times to use.
 */
function analysePlayer(samples, { now = Date.now(), days = 14, travelHours = null, horizonHours = 48, top = 3 } = {}) {
    const profile = hourProfile(samples, { now, days });
    const currentHour = profile.hours[((Math.floor(now / HOUR) % 24) + 24) % 24];
    return {
        ...profile,
        trough: troughWindow(profile.hours),
        currentHour,
        launchWindows: travelHours === null ? [] : bestLaunchWindows(profile.hours, { now, travelHours, horizonHours, top }),
    };
}

module.exports = {
    HOUR,
    accumulate,
    classifyHourCells,
    hourProfile,
    troughWindow,
    bestLaunchWindows,
    analysePlayer,
};
