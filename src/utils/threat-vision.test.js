// Regression coverage for the vision gate on bio threats (2026-09-13).
//
// A biology advantage on the far side of the map is a statistic, not a threat: the game
// measures vision from the system a player STARTED in, so what matters is whether their
// radius reaches your origin.
//
// The awkward part, and the reason the fallback exists: the game only reveals a player's
// origin for a system WE have vision of — which excludes precisely the distant, high-biology
// players this check is for. Their biggest planet stands in, which against all 34 players
// whose true origin the game did give us picked the right system every time. It is still an
// inference, so it is labelled rather than hidden.
//
// Uncertainty fails TOWARD warning throughout: a threat nobody told you about is worse than
// one you were told about and could dismiss.
//
// Run with: node src/utils/threat-vision.test.js

const { resolveThreatOrigin, assessThreat, filterThreatsInRange } = require('./threat-vision');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

// You sit at the origin of the coordinate grid; distances below are simply the x offset.
const me = { origin_x: 0, origin_y: 0 };
const at = (x, extra = {}) => ({ name: 'T', origin_system: 7, origin_x: x, origin_y: 0, ...extra });
const estimatedAt = (x, extra = {}) => ({ name: 'T', origin_system: null, origin_x: null, origin_y: null, est_origin_system: 9, est_origin_x: x, est_origin_y: 0, ...extra });

console.log('threat-vision.test.js');

console.log('\n── Which origin gets used ' + '─'.repeat(50));
{
    const real = resolveThreatOrigin(at(3));
    ok('the game\'s own origin wins when we have it', real.source === 'game' && real.x === 3, real);

    const est = resolveThreatOrigin(estimatedAt(4));
    ok('their biggest planet stands in when the game will not say', est.source === 'estimated' && est.x === 4, est);

    const none = resolveThreatOrigin({ name: 'T' });
    ok('neither available leaves it unplaced rather than guessing zero', none.source === null && none.x === null, none);

    // An origin_system id with no coordinates on file is not usable as a position.
    const half = resolveThreatOrigin({ origin_system: 12, origin_x: null, origin_y: null, est_origin_x: 6, est_origin_y: 0 });
    ok('a known origin id with no mapped coordinates falls through to the estimate',
        half.source === 'estimated' && half.x === 6, half);
}

console.log('\n── Reach ' + '─'.repeat(67));
{
    // Biology IS the radius, and distance is rounded up to whole levels.
    const near = assessThreat(at(3, { biology: 5, has_intel: 1 }), me);
    ok('biology 5 reaches a target 3 systems away', near.reaches === true && near.required === 3, near);

    const far = assessThreat(at(12, { biology: 5, has_intel: 1 }), me);
    ok('biology 5 does NOT reach 12 systems away — a statistic, not a threat', far.reaches === false, far);

    const exact = assessThreat(at(5, { biology: 5, has_intel: 1 }), me);
    ok('exactly at the edge counts as reaching', exact.reaches === true, exact);

    // An unscanned player has no biology, so science level stands in as its ceiling — the
    // same fallback the shared vision model uses.
    const byScience = assessThreat(at(8, { biology: null, science_level: 9 }), me);
    ok('an unscanned player is judged on science level, the ceiling biology could be at',
        byScience.reaches === true && byScience.radius === 9, byScience);
}

console.log('\n── Uncertainty fails toward warning ' + '─'.repeat(41));
{
    const unplaceable = assessThreat({ name: 'Ghost', biology: 30 }, me);
    ok('a player we cannot place at all is still counted', unplaceable.reaches === true, unplaceable);
    ok('and is marked as unplaced rather than passed off as a finding', !!unplaceable.unknown, unplaceable);

    const noViewerOrigin = assessThreat(at(50, { biology: 3 }), { origin_x: null, origin_y: null });
    ok('not knowing YOUR own origin counts everyone rather than silently clearing the list',
        noViewerOrigin.reaches === true && !!noViewerOrigin.unknown, noViewerOrigin);

    const noStats = assessThreat(at(2, { biology: null, science_level: null }), me);
    ok('a player with neither biology nor science recorded is counted, not dismissed',
        noStats.reaches === true && !!noStats.unknown, noStats);
}

console.log('\n── Estimates are flagged, never hidden ' + '─'.repeat(38));
{
    const est = assessThreat(estimatedAt(2, { biology: 6 }), me);
    ok('an in-range estimate counts', est.reaches === true, est);
    ok('and says it rests on a guess', est.estimated === true, est);

    const real = assessThreat(at(2, { biology: 6 }), me);
    ok('a real origin is not flagged as estimated', real.estimated === false, real);

    // The estimate is used for the verdict like any other position — being far away still
    // excludes you, otherwise the fallback would quietly admit the whole map.
    const farEst = assessThreat(estimatedAt(40, { biology: 6 }), me);
    ok('a distant estimate is excluded just as a distant real origin would be', farEst.reaches === false, farEst);
}

console.log('\n── Filtering a list ' + '─'.repeat(56));
{
    const rows = [
        { name: 'Near', biology: 9, origin_system: 1, origin_x: 2, origin_y: 0 },
        { name: 'Far', biology: 3, origin_system: 2, origin_x: 30, origin_y: 0 },
        { name: 'Guessed', biology: 9, est_origin_system: 3, est_origin_x: 1, est_origin_y: 0 },
        { name: 'Unplaceable', biology: 40 },
    ];
    const kept = filterThreatsInRange(rows, me).map(r => r.name);
    ok('only those who can reach you survive', JSON.stringify(kept) === JSON.stringify(['Near', 'Guessed', 'Unplaceable']), kept);

    const withVerdicts = filterThreatsInRange(rows, me);
    ok('each survivor carries its verdict for the UI to label',
        withVerdicts.every(r => r.vision) && withVerdicts.find(r => r.name === 'Guessed').vision.estimated === true,
        withVerdicts.map(r => ({ n: r.name, e: r.vision.estimated, u: r.vision.unknown })));
    ok('the original row fields survive the filter', withVerdicts[0].biology === 9, withVerdicts[0]);

    ok('an empty list stays empty', filterThreatsInRange([], me).length === 0);
    ok('a non-array is survivable', filterThreatsInRange(null, me).length === 0);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
