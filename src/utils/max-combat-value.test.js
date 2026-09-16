// The calculated CV ceiling.
//
// The fixtures below are REAL production data, not invented numbers: six alliance members'
// actual CV limits as scraped off their own member sheets on 2026-09-16, which is the one
// place in the game a true value exists to check this against. An enemy's CV limit is
// printed nowhere, which is the whole reason the hub calculates it — and why the scraped
// cv_limit column had sat at 0 for all 160 players on record.
//
// Two of these fixtures are the entire argument for the population-source rule. Harpyie and
// lbahen came out WRONG when the formula used players.total_population — the game's own
// Statistics figure, which it publishes roughly four days behind — understating lbahen by
// 528 CV. Both are exact when it uses the live sum of the planets we have scanned.
//
// Run with: node src/utils/max-combat-value.test.js

const { maxCombatValue, bestKnownPopulation, maxCombatValueForRow } =
    require('../../public/js/utils/max-combat-value.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// name, live planet-scan population, Statistics-page population, social, TRUE scraped limit
const MEMBERS = [
    ['Moardin25', 41, 41, 10, 5863],
    ['Harpyie', 50, 49, 13, 8800],
    ['Tatankamon', 45, 45, 11, 6930],
    ['lbahen', 51, 48, 13, 8976],
    ['BaldWithABeard', 44, 44, 11, 6776],
];

console.log('max-combat-value.test.js');

console.log('\n── Against real scraped CV limits ' + '─'.repeat(42));
{
    for (const [name, live, , social, truth] of MEMBERS) {
        ok(`${name}: ${truth} CV`, maxCombatValue({ populationSum: live, social }) === truth,
            { got: maxCombatValue({ populationSum: live, social }), truth });
    }

    // The two that prove the source matters. Using the Statistics figure is not a rounding
    // difference — it is hundreds of CV of understated ceiling on a player you might be
    // deciding whether to attack.
    const staleHarpyie = maxCombatValue({ populationSum: 49, social: 13 });
    const staleLbahen = maxCombatValue({ populationSum: 48, social: 13 });
    ok('the Statistics-page population would have got Harpyie and lbahen wrong',
        staleHarpyie === 8624 && staleLbahen === 8448, { staleHarpyie, staleLbahen });
    ok('and the live scan population gets both exactly right',
        maxCombatValue({ populationSum: 50, social: 13 }) === 8800
        && maxCombatValue({ populationSum: 51, social: 13 }) === 8976);
}

console.log('\n── Unknown is not zero ' + '─'.repeat(53));
{
    // Zero is a real answer — a player with no planets genuinely cannot hold a fleet — so it
    // must never double as "we don't know". Every intel-gated cell in the hub rests on that.
    ok('no social (never scanned) is null, not a confident ceiling',
        maxCombatValue({ populationSum: 50 }) === null);
    ok('a non-numeric social is null', maxCombatValue({ populationSum: 50, social: '?' }) === null);
    ok('no population is null', maxCombatValue({ social: 13 }) === null);
    ok('but a real zero population computes to a real zero',
        maxCombatValue({ populationSum: 0, social: 13 }) === 0);
}

console.log('\n── Which population figure gets used ' + '─'.repeat(39));
{
    const scanned = bestKnownPopulation({ planet_count: 6, owned_population: 50, total_population: 49 });
    ok('scanned planets win over the four-day-old Statistics figure',
        scanned.value === 50 && scanned.source === 'scans', scanned);

    // The case that makes a naive "always use the live sum" wrong: an enemy nobody has
    // scanned sums to 0 planets, and a confident "0 CV ceiling" is worse than a stale number.
    const unscanned = bestKnownPopulation({ planet_count: 0, owned_population: 0, total_population: 37 });
    ok('a player whose planets we have never scanned falls back to Statistics, not to 0',
        unscanned.value === 37 && unscanned.source === 'statistics', unscanned);

    const nothing = bestKnownPopulation({ planet_count: 0, owned_population: 0, total_population: 0 });
    ok('and with neither on record it stays unknown rather than becoming zero',
        nothing.value === null, nothing);

    // The War Room names its planet count differently from the Players DB; both must work.
    const warRoomShaped = bestKnownPopulation({ total_planets: 4, owned_population: 22, total_population: 20 });
    ok('the War Room row shape resolves the same way', warRoomShaped.value === 22, warRoomShaped);
}

console.log('\n── The row-shaped helper reports its source ' + '─'.repeat(32));
{
    const fresh = maxCombatValueForRow({ planet_count: 6, owned_population: 50, total_population: 49, social: 13 });
    ok('a scanned player: right number, marked as from scans',
        fresh.value === 8800 && fresh.source === 'scans', fresh);

    const stale = maxCombatValueForRow({ planet_count: 0, owned_population: 0, total_population: 49, social: 13 });
    ok('an unscanned one is still answered, but marked as the stale source',
        stale.value === 8624 && stale.source === 'statistics', stale);

    const unknown = maxCombatValueForRow({ planet_count: 6, owned_population: 50 });
    ok('no intel means no ceiling at all', unknown.value === null, unknown);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
