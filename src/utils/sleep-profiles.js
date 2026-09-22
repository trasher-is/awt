// One place that turns the login-sample table into every player's hour profile, and one
// cache in front of it.
//
// Two routes need the same thing now — /routes/jump-windows and /intel/fleet-dispatch —
// and building it is the expensive half of both: two weeks of samples for the whole galaxy
// is a six-figure row scan, ~1.5s. It depends on the WINDOW IN DAYS and on nothing else, so
// a member nudging an energy selector, or opening the fleet page right after the map, was
// rebuilding something that could not have changed.
//
// The memo lived inside routes.js when only one route needed it. It is here now so the two
// callers share one build rather than keeping a cache each, which would have made the
// second panel pay the full cost while a perfectly good answer sat in the first one.
const db = require('../database');
const sleepMap = require('./sleep-map');

// Far shorter than the interval at which a scan adds a sample, and long enough to cover
// somebody playing with the controls on a panel.
const TTL_MS = 2 * 60 * 1000;

const SAMPLES_SQL = `
    SELECT player_id, observed_at, total_logins
    FROM player_login_samples
    WHERE observed_at >= datetime('now', ?)
    ORDER BY player_id, observed_at
`;

// Under this many samples a player is left out entirely: two observations are one interval,
// which classifies almost nothing, and a profile built from it would be mostly prior.
const MIN_SAMPLES = 20;

let cache = null;   // { days, builtAt, profiles }

function build(now, days) {
    const profiles = new Map();
    let current = null, samples = [];
    const flush = () => {
        if (current === null || samples.length < MIN_SAMPLES) return;
        const profile = sleepMap.hourProfile(samples, { now, days });
        profiles.set(current, { hours: profile.hours, trough: sleepMap.troughWindow(profile.hours) });
    };
    // Streamed and grouped as the rows arrive; there is no reason for the whole table to be
    // resident at once.
    for (const row of db.prepare(SAMPLES_SQL).iterate(`-${days} days`)) {
        if (current !== row.player_id) { flush(); current = row.player_id; samples = []; }
        samples.push({ t: row.observed_at, n: row.total_logins });
    }
    flush();
    return profiles;
}

/**
 * Every sampled player's away-profile, keyed by player id.
 * Returns { profiles, cached } — `cached` so a route can report honestly whether the
 * numbers it just served were recomputed or reused.
 */
function sleepProfiles({ now = Date.now(), days = 14 } = {}) {
    if (cache && cache.days === days && (now - cache.builtAt) < TTL_MS) {
        return { profiles: cache.profiles, cached: true };
    }
    const profiles = build(now, days);
    cache = { days, builtAt: now, profiles };
    return { profiles, cached: false };
}

// The tests need to age the memo without waiting two minutes.
function clearSleepProfileCache() { cache = null; }

module.exports = { TTL_MS, MIN_SAMPLES, sleepProfiles, clearSleepProfileCache };
