// A player's MAXIMUM combat value — the biggest fleet the game will let them hold.
//
//   MaxCV = (sum of the population levels of every planet they own) × (SocialLevel + 3) × 11
//
// WHY IT IS CALCULATED AND NOT SCRAPED (2026-09-16): the game shows a player their own
// "CV limit" and shows an alliance its members', and nowhere else. For an enemy — the only
// case anyone actually wants it for — there is no page that prints it, so the hub scraped a
// field that stayed 0 for all 160 players on record. Everything the formula needs, though,
// the hub already has: planet populations come from ordinary system scans, and SocialLevel
// comes from an intelligence report.
//
// VERIFIED against the real CV limits scraped off our own alliance's member sheets, which
// is the one place a true value exists to check it against. Five of six matched exactly —
// 5.863, 8.800, 6.930, 8.976 and 6.776 CV, to the digit. The sixth was caveman's own row at
// 7.084 against a computed 6.930, and the difference is exactly 154 = 1 × (11 + 3) × 11:
// one population point, on a planet whose population had last been observed two days
// earlier. So the mismatch confirmed the formula rather than denting it, and showed a
// second use for it — when a member's computed figure disagrees with their scraped one, it
// is our PLANET data that is behind, not the arithmetic.
//
// WHAT IT IS NOT: a reading of what they are flying. It is a ceiling, and it moves as they
// colonise, lose planets, or research Social. It is only as fresh as the planet populations
// behind it, which for a distant enemy can be very old.
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AWMaxCombatValue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    // The game's own constant. Named rather than inlined so the formula below reads like the
    // rule it implements.
    const MAX_COMBAT_VALUE_FACTOR = 11;
    const SOCIAL_OFFSET = 3;

    // Returns null — never 0 — when the inputs are not there. Zero is a real answer (a
    // player with no planets genuinely cannot hold a fleet), so it must not double as "we
    // don't know", which is exactly the distinction every intel-gated column in this hub
    // depends on. Social is the usual reason for null: without an intelligence report we do
    // not know it, and guessing would turn an unknown ceiling into a confident wrong one.
    function maxCombatValue({ populationSum, social } = {}) {
        const pop = Number(populationSum);
        const soc = Number(social);
        if (!Number.isFinite(pop) || pop < 0) return null;
        if (!Number.isFinite(soc) || soc < 0) return null;
        return Math.floor(pop * (soc + SOCIAL_OFFSET) * MAX_COMBAT_VALUE_FACTOR);
    }

    // Which population figure to trust, in order.
    //
    // The live sum of the planets we have actually scanned beats players.total_population,
    // because that column is the game's OWN Statistics page figure and the game publishes it
    // roughly four days behind. Measured against real scraped CV limits: using the Statistics
    // figure got Harpyie and lbahen wrong (8.624 and 8.448 against true 8.800 and 8.976 —
    // understating lbahen by 528 CV), and the live sum got all of them exactly right.
    //
    // But the live sum is only meaningful once we have scanned any of their planets at all.
    // With none on record it is 0, which would render a confident "0 CV ceiling" for a player
    // we simply have not looked at — so a stale real number is preferred to a fresh fictional
    // one, and "we have neither" stays null rather than becoming zero.
    function bestKnownPopulation(row = {}) {
        const planets = Number(row.planet_count != null ? row.planet_count : row.total_planets);
        const live = Number(row.owned_population);
        if (Number.isFinite(planets) && planets > 0 && Number.isFinite(live) && live > 0) {
            return { value: live, source: 'scans' };
        }
        const stats = Number(row.total_population);
        if (Number.isFinite(stats) && stats > 0) return { value: stats, source: 'statistics' };
        return { value: null, source: null };
    }

    // Row-shaped convenience used by every table: picks the population source, then applies
    // the formula. Returns { value, source } so a caller can say which figure it used —
    // "calculated from a four-day-old population" and "calculated from last night's scan"
    // deserve to be distinguishable by anyone deciding whether to attack into it.
    function maxCombatValueForRow(row = {}) {
        const pop = bestKnownPopulation(row);
        if (pop.value == null) return { value: null, source: null };
        return { value: maxCombatValue({ populationSum: pop.value, social: row.social }), source: pop.source };
    }

    return { maxCombatValue, bestKnownPopulation, maxCombatValueForRow, MAX_COMBAT_VALUE_FACTOR, SOCIAL_OFFSET };
});
