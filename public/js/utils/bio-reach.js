// What the Biology threat modal says about how close a player is to seeing your origin.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────
// Each row under a Biology threat pill (Science page, issue #153) carries one line saying
// whether that player can see you. Biology 25 opens the whole map, so two things about that
// line were wrong once the vision model learned the rule (vision-model.js, WHOLE_MAP_BIOLOGY):
//
//   • a player at 25+ was "can see your origin", which hides the reason and hides that it
//     holds wherever he sits — the thing you want to know about him;
//   • a player at 24 forty squares away was "needs 1 more bio to see your origin", which
//     reads as though 40 squares still stood between you, when one research tick opens the
//     whole map to him.
//
// Plain text and a tone come back, not HTML: the caller escapes and colours, and the wording
// can be tested without a browser.
//
// LOADING: dual Node/browser, no imports.
//   • Node:    require('../../public/js/utils/bio-reach.js')
//   • Browser: import '../utils/bio-reach.js';  then globalThis.AWBioReach
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWBioReach = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // p: a threat row as /hub-api/intel/bio-threats returns it, with `vision` attached by
    // threat-vision.js (wholeMap, wholeMapLevel, required, levelsAway, unknown).
    //
    // Returns { tone, text, title? }
    //   tone  'whole-map' already sees everything · 'closing' short of seeing you ·
    //         'unknown' could not be placed · 'sees' reaches you by distance · 'requirement'
    //         an unscanned player, where only the requirement can be stated
    function describeReach(player) {
        const p = player || {};
        const v = p.vision || {};
        const level = v.wholeMapLevel;
        // The gap is only honest when we know their actual biology. For an UNSCANNED player
        // the radius is their science level — the ceiling biology could be at, not a
        // reading — so those rows state the REQUIREMENT and leave the judgement to a reader
        // who knows more.
        const knownBio = Number.isFinite(Number(p.biology)) && Number(p.biology) > 0 && !!p.has_intel;

        // Checked before "position unknown": at the whole-map level it does not matter where
        // he is, so a player we could not place still gets a definite answer.
        if (v.wholeMap) {
            return knownBio
                ? { tone: 'whole-map', text: `sees the whole map (bio ${level}+)` }
                : { tone: 'whole-map', text: `may see the whole map (science ${level}+, bio never scanned)` };
        }
        if (v.unknown) return { tone: 'unknown', text: 'position unknown', title: v.unknown };

        // `required` is capped at the whole-map level, so reaching it IS the whole map
        // opening: the distance to you no longer matters at that point.
        const opensWholeMap = Number.isFinite(level) && v.required >= level;

        if (knownBio && v.levelsAway > 0) {
            return opensWholeMap
                ? { tone: 'closing', text: `${v.levelsAway} more bio and he sees the whole map (bio ${level})` }
                : { tone: 'closing', text: `needs ${v.levelsAway} more bio to see your origin` };
        }
        if (knownBio) return { tone: 'sees', text: 'can see your origin' };

        return opensWholeMap
            ? { tone: 'requirement', text: `needs bio ${level} — the whole map opens (bio never scanned)` }
            : { tone: 'requirement', text: `needs bio ${v.required} to see your origin` };
    }

    return { describeReach };
});
