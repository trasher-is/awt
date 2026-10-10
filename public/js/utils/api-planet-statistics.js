// Availability of the four categories named by the 6.0.2 changelog. These flags
// disclose no ranks, building champions, fleet counts, combat values or battle details.
(function (root, factory) {
    const time = typeof module === 'object' && module.exports ? require('./sqlite-time') : root.AWSqliteTime;
    const api = factory(time);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AWPlanetStatistics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (time) {
    'use strict';
    const CATEGORIES = {
        bestPlanet: { icon: '🪐', label: 'Best Planets statistics available' },
        bestGuarded: { icon: '🛡️', label: 'Best Guarded statistics available' },
        strongestFleets: { icon: '⚔️', label: 'Strongest Fleets statistics available' },
        recentBattles: { icon: '💥', label: 'Recent battles statistics available' },
    };
    const SNAPSHOT_MAX_AGE_MS = 26 * 60 * 60 * 1000;
    const BATTLES_MAX_AGE_MS = 60 * 60 * 1000;

    function activeCategories(flags, observedAt, now = Date.now()) {
        if (!flags || typeof flags !== 'object' || Array.isArray(flags) || !Number.isFinite(now)) return [];
        const stamp = time?.parseTimestamp(observedAt);
        if (!stamp) return [];
        const age = now - stamp.getTime();
        if (age < 0 || age >= SNAPSHOT_MAX_AGE_MS) return [];
        return Object.keys(CATEGORIES).filter(kind => flags[kind] === true
            && (kind !== 'recentBattles' || age < BATTLES_MAX_AGE_MS));
    }

    // Reads only the minimal flags stored by /sync/system. Malformed old/imported
    // rows cannot become category markers. Missing/future capture times fail closed.
    function readStoredStatistics(value, observedAt, now = Date.now()) {
        let flags;
        try { flags = typeof value === 'string' ? JSON.parse(value) : value; }
        catch (_) { return null; }
        if (!flags || typeof flags !== 'object' || Array.isArray(flags)
            || Object.keys(flags).length !== Object.keys(CATEGORIES).length
            || !Object.keys(CATEGORIES).every(kind => Object.prototype.hasOwnProperty.call(flags, kind)
                && typeof flags[kind] === 'boolean')) return null;
        const categories = activeCategories(flags, observedAt, now);
        return categories.length ? Object.fromEntries(Object.keys(CATEGORIES)
            .map(kind => [kind, categories.includes(kind)])) : null;
    }
    return { CATEGORIES, SNAPSHOT_MAX_AGE_MS, BATTLES_MAX_AGE_MS, activeCategories, readStoredStatistics };
});
