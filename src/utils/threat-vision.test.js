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

const { resolveThreatOrigin, assessThreat, filterThreatsInRange, splitThreats } = require('./threat-vision');

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

console.log('\n── The cliff: someone one level from seeing you ' + '─'.repeat(30));
{
    // The maintainer's scenario, and the reason banding exists. Before this, a player at
    // biology 15 sixteen systems out cleared NEITHER the +6 bar nor the vision check, then
    // cleared both on the same research tick — silent, then "already watching you", with no
    // warning in between. He is the most dangerous player on the board precisely because he
    // picks the moment.
    const opts = { myBio: 10, confirmedMargin: 6 };
    const at16 = bio => ({ name: `bio${bio}`, biology: bio, has_intel: 1, origin_system: 5, origin_x: 16, origin_y: 0 });

    const almost = splitThreats([at16(15)], me, opts);
    ok('biology 15 at distance 16 is now surfaced at all — it used to appear nowhere',
        almost.red.length + almost.yellow.length === 1, almost);
    ok('and lands in YELLOW, because a warning must not look like a sighting',
        almost.yellow.length === 1 && almost.red.length === 0, almost);
    ok('flagged as closing, with the gap stated',
        almost.yellow[0].closing === true && almost.yellow[0].vision.levelsAway === 1, almost.yellow[0]);

    const arrived = splitThreats([at16(16)], me, opts);
    ok('at biology 16 he can see you, and the decisive gap puts him in RED',
        arrived.red.length === 1 && arrived.red[0].closing === false, arrived);

    const tooFar = splitThreats([at16(12)], me, opts);
    ok('biology 12 is four levels short — still far enough away to stay off the list',
        tooFar.red.length === 0 && tooFar.yellow.length === 0, tooFar);
}

console.log('\n── Nobody falls between the two bars ' + '─'.repeat(40));
{
    // Splitting one margin into two opened a hole: a CONFIRMED player above the yellow bar
    // but below the red one matched neither query, because yellow only ever looked at
    // unscanned players. Banding after the fetch is what closes it.
    const opts = { myBio: 10, confirmedMargin: 6 };
    const midGap = { name: 'Mid', biology: 14, has_intel: 1, origin_system: 5, origin_x: 2, origin_y: 0 };
    const out = splitThreats([midGap], me, opts);
    ok('a confirmed +4 who can see you shows in yellow rather than vanishing',
        out.yellow.length === 1 && out.red.length === 0, out);

    const bigGap = { name: 'Big', biology: 20, has_intel: 1, origin_system: 5, origin_x: 2, origin_y: 0 };
    ok('a confirmed +10 who can see you is red', splitThreats([bigGap], me, opts).red.length === 1);

    // A large gap is not enough on its own: if they cannot see you yet, it is still a warning.
    const bigButClosing = { name: 'BigFar', biology: 20, has_intel: 1, origin_system: 5, origin_x: 21, origin_y: 0 };
    const r = splitThreats([bigButClosing], me, opts);
    ok('even a +10 gap stays YELLOW while they are only closing, not yet watching',
        r.yellow.length === 1 && r.red.length === 0 && r.yellow[0].closing === true, r);

    // An unscanned player is judged on science, and can never be red — it is a ceiling,
    // not a reading.
    const unscanned = { name: 'Unscanned', biology: null, science_level: 30, has_intel: 0, origin_system: 5, origin_x: 2, origin_y: 0 };
    const u = splitThreats([unscanned], me, opts);
    ok('an unscanned player stays yellow however high their science ceiling',
        u.yellow.length === 1 && u.red.length === 0, u);
}

console.log('\n── Biology 25 opens the whole map ' + '─'.repeat(42));
{
    // The gate above is distance-based, but at biology 25 distance stops mattering: the whole
    // map is visible (docs/game-rules.md). Before this, a player at 25 forty systems away was
    // dismissed as "a statistic, not a threat" although he could see your origin.
    const opts = { myBio: 10, confirmedMargin: 6 };
    const far = bio => ({ name: `bio${bio}`, biology: bio, has_intel: 1, origin_system: 5, origin_x: 40, origin_y: 0 });

    const whole = assessThreat(far(25), me);
    ok('biology 25 reaches you from 40 systems away', whole.reaches === true && whole.levelsAway === 0, whole);
    ok('and the requirement is stated as 25, not the raw 40', whole.required === 25, whole);
    ok('biology above 25 is the same', assessThreat(far(29), me).reaches === true);

    const short = assessThreat(far(24), me);
    ok('biology 24 still does not — it is one level from the whole map',
        short.reaches === false && short.levelsAway === 1, short);

    const seen = splitThreats([far(25)], me, opts);
    ok('a confirmed 25 far away is RED: he can see you and the gap is decisive',
        seen.red.length === 1 && seen.yellow.length === 0 && seen.red[0].closing === false, seen);

    const closing = splitThreats([far(24)], me, opts);
    ok('biology 24 far away is YELLOW and closing: one research tick from seeing everything',
        closing.yellow.length === 1 && closing.yellow[0].closing === true && closing.yellow[0].vision.levelsAway === 1, closing);

    const two = splitThreats([far(23)], me, opts);
    ok('biology 23 is two levels out, still inside the closing window', two.yellow.length === 1, two);

    const three = splitThreats([far(22)], me, opts);
    ok('biology 22 is three levels out and stays off the list', three.red.length + three.yellow.length === 0, three);

    // An unscanned player is judged on the science ceiling, as everywhere else.
    const ceiling = assessThreat(at(40, { biology: null, science_level: 25 }), me);
    ok('an unscanned player whose science ceiling is 25 is counted like any other ceiling',
        ceiling.reaches === true && ceiling.radius === 25, ceiling);

    // Below 25 nothing changed: a distant player is still a statistic.
    ok('biology 20 forty systems away is still excluded', assessThreat(far(20), me).reaches === false);

    // The verdict also hands the modal the facts it words the row from.
    ok('the verdict says a 25 sees the whole map, and which level that is',
        whole.wholeMap === true && whole.wholeMapLevel === 25, whole);
    ok('a 24 does not yet', short.wholeMap === false && short.wholeMapLevel === 25, short);
    ok('an unscanned science ceiling of 25 is flagged too — the modal words it as "may"',
        ceiling.wholeMap === true, ceiling);

    // Position is irrelevant once the map is open, so the flag is set even where the verdict
    // has to give up on placing the player — while `unknown` is left as it was.
    const ghost = assessThreat({ name: 'Ghost', biology: 30 }, me);
    const ghostLow = assessThreat({ name: 'Ghost', biology: 10 }, me);
    ok('a 25+ we cannot place is still flagged whole-map', ghost.wholeMap === true && !!ghost.unknown, ghost);
    ok('a low one we cannot place is not', ghostLow.wholeMap === false && !!ghostLow.unknown, ghostLow);
    const noViewer = assessThreat(far(26), { origin_x: null, origin_y: null });
    ok('nor does not knowing YOUR origin hide it', noViewer.wholeMap === true && !!noViewer.unknown, noViewer);
    const noStats = assessThreat(at(2, { biology: null, science_level: null }), me);
    ok('a player with no stats recorded is never flagged', noStats.wholeMap === false, noStats);
}

console.log('\n' + '─'.repeat(75));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
