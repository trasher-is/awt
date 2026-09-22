// What to do with the fleet you are looking at.
//
// ─── THE GAP THIS FILLS ───────────────────────────────────────────────────────
// The game's Fleets page lists what you have: a location, five ship counts, a combat value,
// and four links. It says nothing about what any of it is FOR. Every question a commander
// actually has on that page is answered somewhere else in this hub, on a different screen,
// and never all at once:
//
//   • how long would this fleet take to get there          → the travel model
//   • will they be at the keyboard when it lands           → the Sleep Map's hour profiles
//   • can I beat what is sitting there                     → the strongest-fleet rankings
//   • and what will winning cost me                        → the recorded-battle ledger
//
// This joins the four, per fleet, and returns a shortlist. Nothing here is new analysis —
// it is the four existing answers arriving at the moment the decision is actually made.
//
// ─── WHAT "DEFENDER" HONESTLY MEANS ───────────────────────────────────────────
// The hub does NOT know what is parked on an enemy planet. It knows two different proxies,
// and they mean different things:
//
//   • the owner's STRONGEST FLEET as the game's ranking page last published it — an upper
//     bound on their main force, saying nothing about where that force is;
//   • the size of a fleet they were actually seen fielding in a recorded battle — a real
//     force that really existed, at a moment that may be days old.
//
// The rankings cover 69 players; adding the battle-report figure takes the enemy planets
// with any defender estimate at all from 506 of 1014 to 998. Where both exist the LARGER is
// used, because being wrong in the attacker's favour is the expensive direction, and the
// panel is told which source won so "their ranking says" and "we watched them field" are
// never collapsed into one number.
//
// So a ratio computed from it is "you against everything they could bring", not "you
// against what is there". Every target carries the observation age so that is visible, and
// a target whose owner has never appeared in the rankings is reported as UNKNOWN rather
// than as undefended — those are completely different facts, and collapsing them is how a
// fleet gets sent into something nobody looked at.
//
// Planetary defence is not modelled here at all: a starbase level rides along as a number
// for the operator to read, not folded into the ratio, because the CV ratio the battle
// ledger is calibrated on is fleet against fleet.

const travelModel = require('../../public/js/utils/travel-model.js');
const jumpWindows = require('./jump-windows');
const battleLedger = require('./battle-ledger');

const HOUR = 3600 * 1000;

// Verdict buckets. `clear` and `risky` are split at the ledger's own "never observed to
// lose" threshold rather than at a number chosen here, so the advice moves with the
// evidence as more battles are recorded.
const CLEAR = 'clear';
const RISKY = 'risky';
const UNKNOWN = 'unknown';

/**
 * One fleet against one target planet.
 *
 * fleet:   { cv, x, y, planet_index }
 * target:  { x, y, planet_index, defender_cv, defender_seen_at, ... }
 * hours:   the owner's 24-hour away profile, or null when never sampled
 */
function assess(fleet, target, hours, curve, { now = Date.now(), energy = 0, raceSpeed = 0 } = {}) {
    const travelHours = travelModel.calcTravelSeconds(
        fleet.x, fleet.y, fleet.planet_index,
        target.x, target.y, target.planet_index,
        energy, raceSpeed, false,
    ) / 3600;

    const arriveAt = now + travelHours * HOUR;
    const bucket = hours ? jumpWindows.scoreAtArrival(hours, arriveAt) : null;

    const defenderCv = Number.isFinite(Number(target.defender_cv)) && Number(target.defender_cv) > 0
        ? Number(target.defender_cv) : null;
    const defenderSource = defenderCv === null ? null : (target.defender_source || null);
    const ratio = defenderCv && fleet.cv > 0 ? fleet.cv / defenderCv : null;
    const answer = defenderCv ? battleLedger.lookup(curve, fleet.cv, defenderCv) : null;

    // The threshold is the ledger's, not a guess: the lowest band from which the attacker
    // has never been observed to lose. Null when the archive is too thin to have one, and
    // then nothing is called clear.
    const threshold = battleLedger.thresholds(curve).alwaysWonFrom;
    const verdict = defenderCv === null ? UNKNOWN
        : (threshold !== null && ratio >= threshold) ? CLEAR
            : RISKY;

    return {
        travelHours,
        arriveAt,
        arrivalHour: bucket ? bucket.hour : null,
        awayScore: bucket ? bucket.sleepScore : null,
        observedDays: bucket ? bucket.observedDays : 0,
        sampled: !!hours,
        defenderCv,
        defenderSource,
        defenderSeenAt: target.defender_seen_at || null,
        defenderAgeHours: target.defender_seen_at ? (now - Date.parse(target.defender_seen_at)) / HOUR : null,
        ratio,
        verdict,
        // The archive's own sentence, sample count included, or null when there is nothing
        // to say. Never a number on its own.
        cost: answer && answer.confident ? answer.verdict : (answer ? answer.verdict : null),
        costConfident: !!(answer && answer.confident),
    };
}

/**
 * Free planets this fleet could colonise, nearest first.
 *
 * A fleet carrying colony ships is not asking the attack question at all, and offering it
 * a battle it cannot fight would be worse than offering it nothing. Each candidate carries
 * the age of the observation that called it free, because a planet last looked at nine days
 * ago is evidence about nine days ago — in a land rush that is the evidence most likely to
 * be stale, and stale only ever flatters the answer.
 */
function rankColonies(fleet, freePlanets, { now = Date.now(), energy = 0, raceSpeed = 0, maxHours = 24, limit = 5 } = {}) {
    const out = [];
    let tooFar = 0;
    for (const planet of freePlanets || []) {
        if (!Number.isFinite(planet.x) || !Number.isFinite(planet.y)) continue;
        const travelHours = travelModel.calcTravelSeconds(
            fleet.x, fleet.y, fleet.planet_index,
            planet.x, planet.y, planet.planet_index,
            energy, raceSpeed, false,
        ) / 3600;
        if (travelHours > maxHours) { tooFar++; continue; }
        const observedMs = planet.observed_at ? Date.parse(String(planet.observed_at).replace(' ', 'T') + 'Z') : NaN;
        out.push({
            ...planet,
            travelHours,
            arriveAt: now + travelHours * HOUR,
            observedAgeHours: Number.isFinite(observedMs) ? (now - observedMs) / HOUR : null,
        });
    }
    // Nearest first, and among equals the one we looked at most recently — a shorter flight
    // is also less time for somebody else to take it.
    out.sort((a, b) => a.travelHours - b.travelHours
        || (a.observedAgeHours === null ? Infinity : a.observedAgeHours) - (b.observedAgeHours === null ? Infinity : b.observedAgeHours));
    return { colonies: out.slice(0, Math.max(0, limit)), inRange: out.length, outOfRange: tooFar };
}

/**
 * Rank the targets worth sending ONE fleet to.
 *
 * Ordering is deliberate and, in order: a target we can beat outranks one we know nothing
 * about; among those, the one most likely to be unattended when the fleet lands; then the
 * shorter flight, because a fleet in space is visible and cannot be recalled; then the
 * bigger population, because that is what the trip is for.
 *
 * Targets we would lose to are NOT returned — they are not dispatch suggestions — but they
 * are counted, because "nothing to send this at" and "twelve things that would eat it" are
 * different situations and the panel should be able to say which.
 */
function rankForFleet(fleet, targets, profiles, curve, {
    now = Date.now(), energy = 0, raceSpeed = 0, maxHours = 24, limit = 6,
} = {}) {
    const out = [];
    let risky = 0, tooFar = 0, considered = 0;

    for (const target of targets || []) {
        if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) continue;
        considered++;
        const profile = profiles.get(target.player_id) || null;
        const seen = assess(fleet, target, profile ? profile.hours : null, curve, { now, energy, raceSpeed });
        if (seen.travelHours > maxHours) { tooFar++; continue; }
        if (seen.verdict === RISKY) { risky++; continue; }
        out.push({ ...target, ...seen, trough: profile ? profile.trough : null });
    }

    const rank = t => (t.verdict === CLEAR ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b)
        || (b.awayScore || 0) - (a.awayScore || 0)
        || a.travelHours - b.travelHours
        || (b.population || 0) - (a.population || 0));

    return {
        targets: out.slice(0, Math.max(0, limit)),
        inRange: out.length,
        riskyExcluded: risky,
        outOfRange: tooFar,
        considered,
    };
}

/**
 * Every fleet on the page, each with the shortlist that fits what it is carrying.
 *
 * A fleet with no combat value is asked no attack question — it cannot fight, and a list of
 * battles for it would be noise at best. A fleet with colony ships is asked where to settle.
 * A fleet carrying both gets both lists.
 *
 * fleets: [{ key, cv, colonyShips, system_id, planet_index, x, y }]
 */
function dispatch(fleets, targets, profiles, curve, options = {}, freePlanets = []) {
    return (fleets || []).map(fleet => {
        const canFight = (fleet.cv || 0) > 0;
        const canSettle = (fleet.colonyShips || 0) > 0;
        const attack = canFight
            ? rankForFleet(fleet, targets, profiles, curve, options)
            : { targets: [], inRange: 0, riskyExcluded: 0, outOfRange: 0, considered: 0 };
        const settle = canSettle
            ? rankColonies(fleet, freePlanets, options)
            : { colonies: [], inRange: 0, outOfRange: 0 };
        return {
            key: fleet.key,
            system_id: fleet.system_id,
            planet_index: fleet.planet_index,
            cv: fleet.cv,
            colonyShips: fleet.colonyShips || 0,
            canFight,
            canSettle,
            ...attack,
            colonies: settle.colonies,
            coloniesInRange: settle.inRange,
            coloniesOutOfRange: settle.outOfRange,
        };
    });
}

module.exports = { HOUR, CLEAR, RISKY, UNKNOWN, assess, rankForFleet, rankColonies, dispatch };
