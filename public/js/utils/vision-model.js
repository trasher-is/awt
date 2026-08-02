// Who can see which system.
//
// LOADING: no import/export statements — Node require()s it, the browser runs it as a
// side-effect module import with the API on globalThis. Same pattern as the other shared
// modules in this directory.
//   • Browser: import '../utils/vision-model.js';  then globalThis.AWVision
//   • Node:    require('../../public/js/utils/vision-model.js')
//
// ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The rule was written twice and the two copies disagreed.
//
//   !vision in src/discord_bot.js:
//       const visionRadius = (p.biology && p.biology > 0) ? p.biology : (p.science_level || 1);
//
//   the alliance-vision overlay in public/js/ui/dashboard.js:
//       .filter(p => ... && p.origin_system && p.biology > 0)
//       .map(p => ({ ..., range: p.biology }))
//
// So a member whose biology has not been scraped yet — the column defaults to 0 — is
// reported as having vision on Discord and is silently missing from the overlay. Two
// answers to one question, and the quiet one is the one people look at while planning.
//
// The bot's version is the one that matches the game: biology is what grants vision, and
// the science-level fallback is there because that is the ceiling biology can be at, which
// is the best guess available when the real number has never been seen. Both callers now
// come here.
//
// ─── THE RULE ─────────────────────────────────────────────────────────────────
// A player sees a target system when their vision radius is at least the straight-line
// distance between their ORIGIN system and the target, rounded up. Same ceil() the
// distance-to-biology rule in !dist uses.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWVision = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * How far a player can see, in systems.
     * Biology when we have it; otherwise the science level, which is the ceiling biology
     * could be at. Never less than 1 — everyone sees their own system.
     */
    function visionRadius(player) {
        if (!player) return 0;
        const bio = Number(player.biology);
        if (Number.isFinite(bio) && bio > 0) return bio;
        const science = Number(player.science_level);
        return Number.isFinite(science) && science > 0 ? science : 1;
    }

    /** True when the radius came from a real biology reading rather than the fallback. */
    function radiusIsMeasured(player) {
        const bio = Number(player && player.biology);
        return Number.isFinite(bio) && bio > 0;
    }

    function systemDistance(x1, y1, x2, y2) {
        return Math.hypot(x2 - x1, y2 - y1);
    }

    /** Biology needed to cover a distance. Whole levels only, so round up. */
    function bioNeededFor(distance) {
        return Math.ceil(distance);
    }

    function hasVision(radius, distance) {
        return radius >= bioNeededFor(distance);
    }

    /**
     * Which observers cover which systems.
     *
     * observers: [{ playerId, name, biology, science_level, x, y }] — x/y are the
     *            coordinates of the player's ORIGIN system, not the player.
     * systems:   [{ id, x, y }]
     *
     * Returns a Map of system id -> [{ playerId, name, radius, needed, measured }],
     * observers sorted by how much margin they have, most comfortable first. An observer
     * with no coordinates is skipped: origin_system is nullable and a player whose origin
     * has never been scraped cannot be placed on the map at all.
     */
    // Number(null) and Number('') are both 0, and 0 is a perfectly good coordinate, so a
    // bare Number.isFinite check silently teleports every player whose origin has never
    // been scraped to the centre of the galaxy — and then reports them as seeing whatever
    // is near it. Reject the empties explicitly.
    function isCoordinate(v) {
        return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    }

    function coverage(observers, systems) {
        const usable = (observers || []).filter(o => o && isCoordinate(o.x) && isCoordinate(o.y));
        const prepared = usable.map(o => ({
            playerId: o.playerId != null ? o.playerId : o.id,
            name: o.name,
            x: Number(o.x),
            y: Number(o.y),
            radius: visionRadius(o),
            measured: radiusIsMeasured(o),
        }));

        const byId = new Map();
        for (const s of systems || []) {
            if (!isCoordinate(s.x) || !isCoordinate(s.y)) continue;
            const seers = [];
            for (const o of prepared) {
                const needed = bioNeededFor(systemDistance(o.x, o.y, Number(s.x), Number(s.y)));
                if (o.radius >= needed) {
                    seers.push({ playerId: o.playerId, name: o.name, radius: o.radius, needed, measured: o.measured });
                }
            }
            if (seers.length) {
                seers.sort((a, b) => (b.radius - b.needed) - (a.radius - a.needed));
                byId.set(s.id, seers);
            }
        }
        return byId;
    }

    return { visionRadius, radiusIsMeasured, systemDistance, bioNeededFor, hasVision, coverage, isCoordinate };
});
