// Which of our planets to launch from, so the fleet lands while the target is asleep.
//
// ─── WHY THE ORIGIN IS A CHOICE AND NOT A GIVEN ───────────────────────────────
// The obvious way to pick a launch planet is "the nearest one". That is right only when you
// are free to choose the launch TIME as well — with a free launch time any travel duration
// can be made to land on any hour, so the shortest flight wins and nothing else matters.
//
// Nobody is free like that. A member is at the keyboard now, and the fleet they can send is
// the fleet they send now. Fix the launch time at "now" and the arithmetic inverts:
//
//     arrival hour = now + travel time from THIS planet
//
// so every planet we hold is a different arrival hour, and the choice of jump point IS the
// choice of when the fleet arrives. A target who is reliably away between 02:00 and 06:00
// is not reachable inside that window from the planet six hours away — but they are from
// the one eleven hours away, which the "nearest origin" rule would never have suggested.
//
// So this module answers both questions and keeps them apart:
//
//   launchNow  — of every jump point we hold, which one lands this fleet deepest in the
//                target's quiet hours if it leaves immediately
//   scheduled  — if we can wait, the shortest flight plus the launch time to use
//
// ─── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// The away score comes from src/utils/sleep-map.js and is a frequency over observed days,
// never a promise: "they did not log in during this hour on 13 of the 14 days we watched".
// Nothing here raises that to a certainty, and a target the hub has never sampled scores at
// the 0.5 prior rather than being quietly rated "safe".
//
// The alliance/own-destination travel halving is deliberately NOT applied. It is for moves
// to your own or an allied planet (see travel-model.js); an attack on an enemy planet is
// neither, and halving it here would produce launch times that land the fleet hours after
// the window it was aimed at.

const travelModel = require('../../public/js/utils/travel-model.js');
const sleepMap = require('./sleep-map');

const HOUR = 3600 * 1000;

/**
 * Flight time in hours between two planets, by the hub's one travel formula.
 * Never halved — see the note above about the alliance factor.
 */
function travelHours(origin, target, { energy = 0, raceSpeed = 0 } = {}) {
    const seconds = travelModel.calcTravelSeconds(
        origin.x, origin.y, origin.planet_index,
        target.x, target.y, target.planet_index,
        energy, raceSpeed, false,
    );
    return seconds / 3600;
}

/**
 * The away score for the hour an arrival lands in.
 * `hours` is sleep-map's 24-entry profile, indexed by UTC hour of the day.
 */
function scoreAtArrival(hours, arriveAtMs) {
    const index = ((Math.floor(arriveAtMs / HOUR) % 24) + 24) % 24;
    return hours[index];
}

/**
 * Of every jump point we hold, the one whose flight time lands a fleet launched NOW deepest
 * in this target's quiet hours.
 *
 * Ties are broken by the shorter flight: two origins that both land in the same quiet hour
 * are not equally good, because the fleet that is in space for less time is seen for less
 * time and can be recalled sooner.
 */
function bestOriginNow(origins, target, hours, { now = Date.now(), energy = 0, raceSpeed = 0 } = {}) {
    let best = null;
    for (const origin of origins) {
        if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) continue;
        const flight = travelHours(origin, target, { energy, raceSpeed });
        const arriveAt = now + flight * HOUR;
        const bucket = scoreAtArrival(hours, arriveAt);
        const candidate = {
            origin,
            travelHours: flight,
            launchAt: now,
            arriveAt,
            arrivalHour: bucket.hour,
            awayScore: bucket.sleepScore,
            observedDays: bucket.observedDays,
        };
        if (!best
            || candidate.awayScore > best.awayScore
            || (candidate.awayScore === best.awayScore && candidate.travelHours < best.travelHours)) {
            best = candidate;
        }
    }
    return best;
}

/** The shortest flight to this target, whatever the arrival hour turns out to be. */
function nearestOrigin(origins, target, { energy = 0, raceSpeed = 0 } = {}) {
    let best = null;
    for (const origin of origins) {
        if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) continue;
        const flight = travelHours(origin, target, { energy, raceSpeed });
        if (!best || flight < best.travelHours) best = { origin, travelHours: flight };
    }
    return best;
}

/**
 * Both answers for one target planet.
 *
 * hours:   the target player's 24-hour away profile (sleep-map.hourProfile().hours)
 * origins: our jump points, [{ system_id, planet_index, x, y, ... }]
 *
 * Returns { launchNow, scheduled } — either may be null when there is no usable origin.
 * `scheduled` carries the launch time to use, from the nearest jump point.
 */
function planStrike(origins, target, hours, { now = Date.now(), energy = 0, raceSpeed = 0, horizonHours = 48 } = {}) {
    const launchNow = bestOriginNow(origins, target, hours, { now, energy, raceSpeed });
    const nearest = nearestOrigin(origins, target, { energy, raceSpeed });

    let scheduled = null;
    if (nearest) {
        const [window] = sleepMap.bestLaunchWindows(hours, {
            now, travelHours: nearest.travelHours, horizonHours, top: 1,
        });
        if (window) {
            scheduled = {
                origin: nearest.origin,
                travelHours: nearest.travelHours,
                launchAt: window.launchAt,
                arriveAt: window.arriveAt,
                arrivalHour: window.arrivalHour,
                awayScore: window.sleepScore,
                observedDays: window.observedDays,
                waitHours: (window.launchAt - now) / HOUR,
            };
        }
    }

    return { launchNow, scheduled };
}

/**
 * Every target planet, planned and ranked.
 *
 * targets:  [{ player_id, ... , x, y, planet_index }]
 * profiles: Map(player_id -> { hours, trough })
 *
 * Targets whose owner the hub has never sampled are kept, at the 0.5 prior, rather than
 * dropped: "we do not know when this one sleeps" is a different answer from "this one is
 * never away", and hiding the row would make the second look like the first.
 */
function rankTargets(origins, targets, profiles, { now = Date.now(), energy = 0, raceSpeed = 0, horizonHours = 48, minScore = 0 } = {}) {
    const flat = sleepMap.hourProfile([], { now }).hours;   // the untouched prior
    const out = [];
    for (const target of targets || []) {
        if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) continue;
        const profile = profiles.get(target.player_id) || null;
        const hours = profile ? profile.hours : flat;
        const plan = planStrike(origins, target, hours, { now, energy, raceSpeed, horizonHours });
        if (!plan.launchNow) continue;
        if (plan.launchNow.awayScore < minScore) continue;
        out.push({
            ...target,
            sampled: !!profile,
            trough: profile ? profile.trough : null,
            launchNow: plan.launchNow,
            scheduled: plan.scheduled,
        });
    }
    // The question the panel opens on is "what can I hit right now", so that is the sort.
    out.sort((a, b) => b.launchNow.awayScore - a.launchNow.awayScore
        || a.launchNow.travelHours - b.launchNow.travelHours);
    return out;
}

module.exports = {
    HOUR,
    travelHours,
    scoreAtArrival,
    bestOriginNow,
    nearestOrigin,
    planStrike,
    rankTargets,
};
