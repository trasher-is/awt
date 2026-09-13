// Works out which system a Discord channel is about, from its name alone.
//
// The hub cannot ask anyone to configure channel ids (that was the whole point — see
// announceSystemMilestones), so it has to read the convention off the name. The original
// rule was "trust the trailing number", which fit RAID's own "phact-41" exactly and
// nothing else. Real channel lists from other alliances (2026-09-13) break it completely:
//
//   system-87-antares          id at the FRONT, behind a word    -> no trailing number
//   14_al-bali                 id at the front, underscores      -> no trailing number
//   29-praepes-3-9             id at the front, COORDINATES last -> "9", i.e. Alphirk
//   62-oculus-boreus-11-3      likewise                          -> "3", i.e. Meboula
//
// Of 25 real channel names across two alliances the trailing-number rule got 0 right, 19
// no-matches, and 6 confidently WRONG — routing one system's intel into a channel about a
// different system entirely, because a coordinate looks exactly like an id.
//
// The one thing every convention shares is the system's NAME, so that is what this matches
// on. Numbers are then used only as confirmation, never as the primary key: a channel
// naming a system AND carrying its id is a certainty, while a bare number is just as likely
// to be a coordinate.
//
// LOADING: dual Node/browser, same pattern as sqlite-time.js — server-side today, but it
// belongs with the other shared models rather than buried in the bot.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    root.AWSystemChannelMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // "Difda al Auwel" -> "difda-al-auwel"; "system-88_cebalrai" -> "system-88-cebalrai".
    // Every separator a Discord channel name can carry (Discord itself lowercases and
    // hyphenates, but underscores survive, and people paste unicode) collapses to one.
    function slugifyName(value) {
        return String(value == null ? '' : value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    // Whole-token containment: "rana" is inside "rana-secunda" as tokens, but "ana" is not
    // inside "rana" at all. Padding both sides makes the boundaries explicit instead of
    // relying on a regex built from user-supplied text.
    function containsTokens(haystackSlug, needleSlug) {
        if (!needleSlug) return false;
        return `-${haystackSlug}-`.includes(`-${needleSlug}-`);
    }

    // systems: [{id, name}]. Returns the best-matching system, or null.
    //
    // Ambiguity is resolved by LENGTH: ten real system names contain another system's name
    // as whole tokens ("Rana Secunda" contains "Rana", "Difda al Thani" contains "Difda"),
    // so a channel for the longer one would otherwise also answer for the shorter. The
    // longest name that fits is the one the channel is actually about.
    function bestSystemForChannel(channelName, systems) {
        const slug = slugifyName(channelName);
        if (!slug) return null;

        const numbers = new Set(
            slug.split('-').filter(part => /^\d+$/.test(part)).map(part => parseInt(part, 10))
        );

        let best = null;
        let bestSlugLength = -1;
        for (const system of Array.isArray(systems) ? systems : []) {
            if (!system || !Number.isInteger(system.id)) continue;
            const nameSlug = slugifyName(system.name);
            if (!containsTokens(slug, nameSlug)) continue;

            const confirmed = numbers.has(system.id);
            const bestConfirmed = best ? numbers.has(best.id) : false;
            // A name match backed by the id beats a longer name match that is not, because
            // the pair agreeing is far stronger evidence than either alone.
            if (best && bestConfirmed && !confirmed) continue;
            if (!best || (confirmed && !bestConfirmed) || nameSlug.length > bestSlugLength) {
                best = system;
                bestSlugLength = nameSlug.length;
            }
        }
        return best;
    }

    return { slugifyName, containsTokens, bestSystemForChannel };
});
