// The empire build simulator: the rules it must not get wrong.
//
// Run with:  node src/utils/empire-model.test.js
//
// Several assertions here are regressions against the sim this replaces
// (public/js/ui/build-order.js), which levelled Social science but capped population with a
// hardcoded 7, colonised instantly regardless of travel time, and topped its cost tables out
// at building 8 / population 7 / culture 9 / science 8 so that every 60-day run converged.

const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'game-tables.js'));
const E = require(path.join(__dirname, '..', '..', 'public', 'js', 'utils', 'empire-model.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Targets that cost nothing, for isolating rates.
const NO_TARGETS = { HF: 0, RF: 0, GC: 0, RL: 0, SB: 0 };

(async () => {
    console.log('── Bonuses multiply, they do not add ' + '─'.repeat(43));
    // The doc's own worked example: +4 science race pick (32%) x Memory Jar 3 (+30%) x
    // 85% TR (80% trade rate + the 5% economy bonus, which is additive to TR) = +217%,
    // not 32+30+85 = 147%. Read off sci/h for a lone planet at population 1 and no labs,
    // where the base rate is exactly 1.0 and the rate IS the multiplier.
    const stack = E.simulate({
        days: 0, targets: NO_TARGETS, sciencePlan: [],
        race: { science: 4, growth: -4 },
        artifact: 'Memory Jar 3', artifactFromDay: 0,
        tradeRate: 0.80, economyBonus: true
    });
    ok('the doc\'s worked example comes out at +217%, not +147%',
        near(stack.final.sciRate, 3.1746, 0.001), stack.final.sciRate);

    const additive = 1 + 0.32 + 0.30 + 0.85;
    ok('and it is measurably not the additive answer',
        !near(stack.final.sciRate, additive, 0.01), { multiplied: stack.final.sciRate, added: additive });

    console.log('');
    console.log('── Social science actually caps population ' + '─'.repeat(37));
    // The old sim spent science on Social and then capped population at a flat 7 regardless,
    // which made Social a no-op that only consumed research.
    const noSocial = E.simulate({
        days: 40, sciencePlan: [], targets: { HF: 8, RF: 8, GC: 8, RL: 0, SB: 0 }
    });
    ok('with no Social research, no planet passes population 5',
        noSocial.final.buildings.every(p => p.pop <= 5),
        noSocial.final.buildings.map(p => p.pop));
    ok('and the reported cap says 5, not 7',
        noSocial.final.popCap === 5, noSocial.final.popCap);

    const social12 = E.simulate({
        days: 40, sciencePlan: [{ field: 'social', level: 12 }],
        targets: { HF: 8, RF: 8, GC: 8, RL: 0, SB: 0 }
    });
    ok('researching Social to 12 raises the cap to 12',
        social12.final.popCap === 12, social12.final.popCap);
    ok('and population then goes past the old hardcoded 7',
        social12.final.buildings.some(p => p.pop > 7),
        social12.final.buildings.map(p => p.pop));

    console.log('');
    console.log('── Nothing tops out where the old tables did ' + '─'.repeat(35));
    const tall = E.simulate({
        days: 60, targets: { HF: 14, RF: 14, GC: 14, RL: 14, SB: 0 },
        sciencePlan: [{ field: 'social', level: 20 }, { field: 'economy', level: 30 }],
        colonyShips: 3, tradeRate: 0.5
    });
    ok('buildings pass level 8', tall.final.buildings.some(p => p.buildings.RF > 8));
    ok('culture passes level 9', tall.final.cultureLevel > 9, tall.final.cultureLevel);
    ok('science passes level 8', tall.final.science.social > 8, tall.final.science);
    ok('population passes level 7', tall.final.buildings.some(p => p.pop > 7));

    console.log('');
    console.log('── The target vector is the input, and it is reported honestly ' + '─'.repeat(17));
    // All four building types share one cost table, so 12/13/13/13 is 1,286 + 3 x 1,935.
    const cost = E.targetCostPP({ HF: 12, RF: 13, GC: 13, RL: 13 }, 20);
    ok('12 HF / 13 RF / 13 GC / 13 RL costs 7,091 PP per planet',
        cost.perPlanet === 1286 + 1935 * 3 && cost.perPlanet === 7091, cost.perPlanet);
    ok('and 141,820 PP across 20 planets', cost.total === 141820, cost.total);

    const unreachable = E.simulate({
        days: 10, targets: { HF: 20, RF: 20, GC: 20, RL: 20, SB: 0 }, colonyShips: 1
    });
    ok('a target it cannot finish reports never caught up, with the shortfall',
        unreachable.firstCaughtUpDay === null && unreachable.final.remainingBuildPP > 0,
        { day: unreachable.firstCaughtUpDay, short: unreachable.final.remainingBuildPP });

    const trivial = E.simulate({
        days: 5, targets: { HF: 3, RF: 3, GC: 0, RL: 0, SB: 0 }, maxPlanets: 1, sciencePlan: []
    });
    ok('a target it starts with enough PP for is caught up on day 1',
        trivial.firstCaughtUpDay === 1, trivial.firstCaughtUpDay);
    ok('and it is still caught up at the end', trivial.caughtUpAtEnd === true);

    console.log('');
    console.log('── Levels past 30 need Supply Units, not production points ' + '─'.repeat(21));
    const past = E.simulate({ days: 1, targets: { HF: 35, RF: 0, GC: 0, RL: 0, SB: 0 } });
    ok('a target past level 30 is capped and says why',
        past.config.targets.HF === 30 &&
        past.warnings.some(w => /Supply Units/.test(w)), past.warnings);

    console.log('');
    console.log('── Speed and Energy change when a colony lands ' + '─'.repeat(33));
    // The old sim colonised the instant it could afford to, so a speeder was indistinguishable
    // from anyone else. Only Speed differs between these two races; attack/defence absorb the
    // points and do not touch a build sim.
    const route = { planetDelta: 3, systemDistance: 0 };
    const runSpeed = speed => E.simulate({
        days: 30, targets: { HF: 4, RF: 4, GC: 6, RL: 0, SB: 0 }, maxPlanets: 2,
        colonyRoute: route, sciencePlan: [],
        race: { speed, attack: -speed / 2, defence: -speed / 2 }
    });
    const slow = runSpeed(-4), fast = runSpeed(4);
    const landing = r => (r.milestones.find(m => m.kind === 'colony') || {});
    const slowAt = landing(slow), fastAt = landing(fast);
    ok('both races do colonise', slowAt.day !== undefined && fastAt.day !== undefined);
    ok('the +4 speed race lands its colony ship sooner than the -4 speed race',
        (fastAt.day * 24 + fastAt.hour) < (slowAt.day * 24 + slowAt.hour),
        { fast: fastAt, slow: slowAt });

    // Same check for Energy, which only applies at launch.
    const flight = energy => {
        const r = E.simulate({
            days: 30, targets: { HF: 4, RF: 4, GC: 6, RL: 0, SB: 0 }, maxPlanets: 2,
            colonyRoute: { planetDelta: 3, systemDistance: 2 },
            sciencePlan: energy ? [{ field: 'energy', level: energy }] : []
        });
        return landing(r);
    };
    const e0 = flight(0), e30 = flight(30);
    ok('deep-space colonisation is slower at energy 0 than after energy 30',
        (e0.day * 24 + e0.hour) > (e30.day * 24 + e30.hour), { energy0: e0, energy30: e30 });

    console.log('');
    console.log('── Colony ship batches, including the 2-ship trap ' + '─'.repeat(30));
    const two = E.simulate({ days: 20, targets: { HF: 4, RF: 4, GC: 6, RL: 0, SB: 0 }, colonyShips: 2 });
    ok('sending 2 colony ships is flagged as wasting 60 PP',
        two.warnings.some(w => /wastes 60 PP/.test(w)), two.warnings);

    const one = E.simulate({ days: 25, targets: { HF: 6, RF: 6, GC: 8, RL: 0, SB: 0 }, colonyShips: 1, maxPlanets: 3 });
    const five = E.simulate({ days: 25, targets: { HF: 6, RF: 6, GC: 8, RL: 0, SB: 0 }, colonyShips: 5, maxPlanets: 3 });
    ok('a bigger colony batch costs more in colony ships',
        five.final.spent.colonyShips > one.final.spent.colonyShips,
        { one: one.final.spent.colonyShips, five: five.final.spent.colonyShips });
    ok('5 ships per colony costs exactly 5 x 60 PP per colony',
        five.final.spent.colonyShips % (5 * T.CIVIL_SHIP_PP) === 0, five.final.spent.colonyShips);

    console.log('');
    console.log('── Startup Lab is 12 research labs on the home planet ' + '─'.repeat(26));
    const sul = E.simulate({
        days: 0, targets: NO_TARGETS, sciencePlan: [],
        race: { startupLab: true, science: -1 }
    });
    ok('the home planet starts with 12 labs', sul.final.buildings[0].buildings.RL === 12);
    ok('so its science rate starts at 13x the base, not 1x',
        near(sul.final.sciRate, 13 * (1 + -1 * 0.08), 0.001), sul.final.sciRate);

    console.log('');
    console.log('── Race picks must sum to zero, and it says so when they do not ' + '─'.repeat(16));
    const legal = E.simulate({ days: 0, targets: NO_TARGETS, sciencePlan: [], race: { speed: 4, science: 3, culture: 1, attack: -4, defence: -4 } });
    ok('a legal pick raises no sum warning',
        !legal.warnings.some(w => /sum to/.test(w)), legal.warnings);
    const illegal = E.simulate({ days: 0, targets: NO_TARGETS, sciencePlan: [], race: { growth: 4, science: 4 } });
    ok('an illegal pick is flagged rather than silently simulated',
        illegal.warnings.some(w => /sum to 8/.test(w)), illegal.warnings);
    const withToggles = E.simulate({
        days: 0, targets: NO_TARGETS, sciencePlan: [],
        race: { science: 4, growth: -4, culture: -4, speed: -3, startupLab: true, trader: true }
    });
    ok('the toggles count toward the sum: -7 of traits plus SUL 1 plus Trader 6 is legal',
        !withToggles.warnings.some(w => /sum to/.test(w)), withToggles.warnings);

    console.log('');
    console.log('── Spending policy ' + '─'.repeat(61));
    const balanced = E.simulate({
        days: 8, buildMode: 'balanced', targets: { HF: 13, RF: 13, GC: 13, RL: 13, SB: 0 },
        buildOrder: ['RF', 'GC', 'HF', 'RL'], sciencePlan: [], maxPlanets: 1
    });
    const priority = E.simulate({
        days: 8, buildMode: 'priority', targets: { HF: 13, RF: 13, GC: 13, RL: 13, SB: 0 },
        buildOrder: ['RF', 'GC', 'HF', 'RL'], sciencePlan: [], maxPlanets: 1
    });
    const spread = r => {
        const b = r.final.buildings[0].buildings;
        return Math.max(b.HF, b.RF, b.GC, b.RL) - Math.min(b.HF, b.RF, b.GC, b.RL);
    };
    ok('balanced keeps the four buildings within a level of each other', spread(balanced) <= 1,
        balanced.final.buildings[0].buildings);
    ok('priority finishes the first type in the order well ahead of the last',
        spread(priority) > spread(balanced),
        { priority: priority.final.buildings[0].buildings, balanced: balanced.final.buildings[0].buildings });
    ok('priority builds the first entry in buildOrder first',
        priority.final.buildings[0].buildings.RF >= priority.final.buildings[0].buildings.RL,
        priority.final.buildings[0].buildings);

    console.log('');
    console.log('── Science after the plan is not silently lost ' + '─'.repeat(33));
    const wasted = E.simulate({
        days: 30, targets: { HF: 8, RF: 8, GC: 8, RL: 8, SB: 0 },
        sciencePlan: [{ field: 'social', level: 6 }]
    });
    ok('with no overflow field, leftover science is reported as wasted',
        wasted.final.scienceWasted > 0, wasted.final.scienceWasted);
    const overflowed = E.simulate({
        days: 30, targets: { HF: 8, RF: 8, GC: 8, RL: 8, SB: 0 },
        sciencePlan: [{ field: 'social', level: 6 }], scienceOverflow: 'economy'
    });
    ok('with an overflow field it goes into that field instead',
        overflowed.final.scienceWasted === 0 && overflowed.final.science.economy > 0,
        overflowed.final.science);
    ok('and a cheaper economy then buys more ships with the same leftover PP',
        overflowed.final.fleetIfSpent.economy > 0 &&
        T.destroyerCost(overflowed.final.fleetIfSpent.economy) < T.destroyerCost(0));

    console.log('');
    console.log('── The unverified culture rate is declared, and it matters ' + '─'.repeat(21));
    const assumed = E.simulate({ days: 30, targets: { HF: 6, RF: 6, GC: 6, RL: 0, SB: 0 } });
    ok('a run says out loud that the culture rate is assumed',
        assumed.warnings.some(w => /ASSUMED/.test(w)), assumed.warnings);
    const noCybernet = E.simulate({
        days: 30, targets: { HF: 6, RF: 6, GC: 0, RL: 0, SB: 0 }, cultureFormula: 'gc'
    });
    ok('under the assumed formula, no cybernets means no culture and no second planet',
        noCybernet.final.cultureLevel === 1 && noCybernet.final.planets === 1,
        { culture: noCybernet.final.cultureLevel, planets: noCybernet.final.planets });
    const withBase = E.simulate({
        days: 30, targets: { HF: 6, RF: 6, GC: 0, RL: 0, SB: 0 }, cultureFormula: 'gc+1'
    });
    ok('the gc+1 variant expands without cybernets — which is why the formula must be verified',
        withBase.final.planets > noCybernet.final.planets,
        { gc: noCybernet.final.planets, 'gc+1': withBase.final.planets });

    console.log('');
    console.log('── A run is reproducible ' + '─'.repeat(55));
    const cfg = {
        days: 45, race: { speed: 4, science: 3, culture: 1, attack: -4, defence: -4 },
        targets: { HF: 12, RF: 13, GC: 13, RL: 13, SB: 0 },
        sciencePlan: [{ field: 'social', level: 12 }, { field: 'energy', level: 30 }],
        colonyShips: 3
    };
    const a = E.simulate(cfg), b = E.simulate(cfg);
    ok('the same config twice gives byte-identical output',
        JSON.stringify(a) === JSON.stringify(b));
    ok('and the caller\'s config object was not mutated',
        cfg.days === 45 && cfg.targets.HF === 12 && !('cultureFormula' in cfg));

    console.log('');
    console.log('── Tick size changes resolution, not the answer ' + '─'.repeat(32));
    const hourly = E.simulate(Object.assign({}, cfg, { tickMinutes: 60 }));
    const fiveMin = E.simulate(Object.assign({}, cfg, { tickMinutes: 5 }));
    ok('hourly and 5-minute ticks agree on planet count within one planet',
        Math.abs(hourly.final.planets - fiveMin.final.planets) <= 1,
        { hourly: hourly.final.planets, fiveMin: fiveMin.final.planets });
    ok('and on total population within 5%',
        near(hourly.final.totalPop, fiveMin.final.totalPop, fiveMin.final.totalPop * 0.05),
        { hourly: hourly.final.totalPop, fiveMin: fiveMin.final.totalPop });

    console.log('');
    console.log(`${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
