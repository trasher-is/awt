// SB buster plan (public/js/utils/sb-buster.js): fewest ships per fleet to grind a
// starbase down to a target level with fleets landing in front of the main fleet.
const B = require('../../public/js/utils/sb-buster.js');

let failed = false;
const ok = (name, cond, got) => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`);
    if (!cond) failed = true;
};

console.log('── SB buster ──');
ok('a visible whole level counts as x.99; a typed fraction stays as given',
    B.worstCase(11) === 11.99 && B.worstCase(11.5) === 11.5 && B.worstCase(11, false) === 11 && B.worstCase(0) === 0);

// His example (2026-11-22, game calculator): SB 11.99 and 4 × 10 DS → 11.69, 11.41, 11.15, 10.86.
const chain = B.chainFor({ sbLevel: 11.99, perFleet: 10, fleets: 4 });
ok('4 × 10 DS take SB 11.99 to 11.69, 11.41, 11.15, 10.86',
    chain.steps.map(s => s.after).join(' ') === '11.69 11.41 11.15 10.86' && chain.end === 10.86, chain.steps);

const exact = B.plan({ sbLevel: B.worstCase(11), target: 10.86, fleets: 4 });
ok('to reach 10.86 from a visible SB 11 the plan is exactly 4 × 10 DS', exact.perFleet === 10 && exact.total === 40, exact);
const fewer = B.chainFor({ sbLevel: 11.99, perFleet: 9, fleets: 4 });
ok('…and 4 × 9 DS would fall short', fewer.end > 10.86, fewer.end);

const ten = B.plan({ sbLevel: B.worstCase(11), target: 10, fleets: 4 });
ok('a visible SB 11 to level 10 takes 4 × 16 DS', ten.perFleet === 16 && ten.end <= 10, ten);
const tough = B.plan({ sbLevel: B.worstCase(11), target: 10, fleets: 4, def: { math: 20, rd: 4 } });
ok('a defender with Mathematics 20 and race defence +4 needs more busters', tough.perFleet > ten.perFleet, tough.perFleet);
const raceAtk = B.plan({ sbLevel: B.worstCase(11), target: 10, fleets: 4, atk: { ra: 4, phys: 30 } });
ok('the attacker\'s race attack and physics do not change the count (only win chance)', raceAtk.perFleet === ten.perFleet, raceAtk.perFleet);
const two = B.plan({ sbLevel: B.worstCase(11), target: 10, fleets: 2 });
ok('fewer fleet slots need more ships per fleet', two.perFleet > ten.perFleet, two.perFleet);
const cruisers = B.plan({ sbLevel: B.worstCase(11), target: 10, fleets: 4, ship: 'cruisers' });
ok('cruisers: fewer ships than destroyers (24 CV each)', cruisers.perFleet > 0 && cruisers.perFleet < ten.perFleet, cruisers.perFleet);

ok('a target at or above the level needs nothing', B.plan({ sbLevel: 5, target: 6 }).reason === 'already_at_target');
ok('a target below level 1 cannot be reached by busters that lose', B.plan({ sbLevel: 12, target: 0.5 }).reason === 'below_level_1');
ok('the plan is the smallest count that works', (() => {
    const p = B.plan({ sbLevel: 14.99, target: 12, fleets: 4 });
    return B.chainFor({ sbLevel: 14.99, perFleet: p.perFleet, fleets: 4 }).end <= 12
        && B.chainFor({ sbLevel: 14.99, perFleet: p.perFleet - 1, fleets: 4 }).end > 12;
})());

if (failed) process.exit(1);
