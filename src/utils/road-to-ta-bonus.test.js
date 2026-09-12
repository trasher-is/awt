const M = require('../../public/js/utils/road-to-ta-model');
let passed = 0, failed = 0;
function ok(name, condition, detail) {
    if (condition) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}`, detail ?? ''); }
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
const defaults = M.constants.DEFAULT_PARTNER_BONUS_RANGES;
const input = {
    now: '2026-09-12T12:00:00Z', mode: 'rush', social: 10, playerLevel: 1,
    scienceRate: 360, productionMultiplier: 10, scienceMultiplier: 6, growthMultiplier: 1,
    cultureRate: 180, cultureMultiplier: 4.5, cash: 20000, ppPrice: 0.8,
    completedTas: 0, currentTradeBonusPct: 25, horizonDays: 60,
    planets: [1, 2].map(id => ({ id, population: 10, HF: 20, RF: 20, RL: 20, GC: 20, pp: 0 })),
};
// Independent cash-flow oracle for fixed, fully developed planets. The source rates
// already include the current 25% TA+Eco and all race/artifact multipliers.
function oracle(bonuses) {
    const H = 3600000, start = Date.parse(input.now);
    let hour = 0, cash = input.cash, added = 0, science = 0, culture = 0;
    const funded = [], pending = [];
    while (funded.length < bonuses.length) {
        if (cash >= 20000 - 1e-7) {
            cash -= 20000;
            const ms = start + hour * H;
            const active = (Math.floor((ms + 2 * H) / (6 * H)) + 1) * 6 * H - 2 * H + 5 * 60000;
            pending.push({ at: (active - start) / H, bonus: bonuses[funded.length] });
            funded.push(hour);
            continue;
        }
        const factor = (125 + added) / 125;
        const nextFunds = hour + (20000 - cash) / (600 * 0.8 * factor);
        const nextActivation = Math.min(...pending.map(item => item.at));
        const next = Math.min(nextFunds, nextActivation), elapsed = next - hour;
        cash += 600 * 0.8 * factor * elapsed;
        science += 360 * factor * elapsed;
        culture += 180 * factor * elapsed;
        hour = next;
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= hour + 1e-8) {
            added += pending[i].bonus; pending.splice(i, 1);
        }
    }
    return { funded, science, culture, factor: (125 + added) / 125 };
}
const plans = M.planBonusScenarios(input, defaults);
for (const [name, endpoint] of [['lower', 0], ['upper', 1]]) {
    const actual = plans[name], expected = oracle(defaults.map(range => range[endpoint]));
    ok(`${name}: all five funding times match independent additive-TA cash flow at 0.8 A$/PP`, actual.ok && actual.agreements.every((a, i) => near(a.fundedHours, expected.funded[i])), actual.agreements);
    ok(`${name}: measured science includes old bonuses exactly once and new bonuses only after activation`, near(actual.totals.sciencePoints, expected.science));
    ok(`${name}: culture follows the same additive TA factor`, near(actual.totals.culturePoints, expected.culture));
    ok(`${name}: final production keeps race/artifact in the observed baseline`, near(actual.rates.production, 600 * expected.factor));
    ok(`${name}: all cash is accounted for without converting a fee into PP one-to-one`, near(actual.totals.spentCash, 100000) && near(actual.totals.saleProceeds, 80000));
}
ok('five future bonuses total 32–36 percentage points, not chained multipliers', defaults.reduce((sum, range) => sum + range[0], 0) === 32 && defaults.reduce((sum, range) => sum + range[1], 0) === 36);
ok('future partner bonus cannot change the first funding date', plans.lower.agreements[0].fundedAt === plans.upper.agreements[0].fundedAt);
ok('higher future bonuses accelerate later TA funding', plans.upper.agreements[4].fundedHours < plans.lower.agreements[4].fundedHours);
const remaining = M.planBonusScenarios({ ...input, completedTas: 2 }, defaults.slice(2));
ok('two completed TAs start at absolute TA 3 with +6/+7 assumptions', remaining.lower.agreements[0].number === 3 && remaining.lower.agreements[0].partnerQualifiedPlanets === 6 && remaining.upper.agreements[0].partnerQualifiedPlanets === 7);
const fixed = M.planBonusScenarios({ ...input, completedTas: 4 }, [[8, 8]]);
ok('an observed or manually fixed partner count produces identical scenarios', JSON.stringify(fixed.lower) === JSON.stringify(fixed.upper));
for (const ranges of [null, [], [[3, 2]], [[-1, 2]], [[0, 101]], [[1.5, 2]], [[null, 2]]]) {
    const result = M.planBonusScenarios({ ...input, completedTas: 4 }, ranges);
    ok('invalid or incomplete ranges fail closed', !result.lower.ok && !result.upper.ok);
}
const missing = M.planBonusScenarios({ ...input, currentTradeBonusPct: null }, defaults);
ok('unknown current TA bonus never becomes neutral', !missing.lower.ok && !missing.upper.ok);
const finished = M.planBonusScenarios({ ...input, completedTas: 5 }, []);
ok('all completed slots produce empty scenarios without development', finished.lower.ok && finished.upper.ok && finished.lower.agreements.length === 0 && finished.lower.totals.buildingPP === 0);
const noCulture = M.plan({ ...input, cultureRate: undefined, cultureMultiplier: undefined });
ok('missing optional culture remains unknown and does not block TA', noCulture.ok && noCulture.totals.culturePoints === null && noCulture.rates.culture === null);
ok('negative optional culture is invalid', !M.plan({ ...input, cultureRate: -1 }).ok);
const growthOnly = M.plan({ ...input, completedTas:4, cash:0, social:20, growthMultiplier:100, productionMultiplier:0.01, horizonDays:1, partnerQualifiedPlanets:[0] });
ok('population growth never creates culture points', growthOnly.planets.some(p => p.final.population > p.start.population) && near(growthOnly.totals.culturePoints, 180 * growthOnly.totals.simulatedHours));
const gc = M.plan({ ...input, mode:'normal', completedTas:4, cash:0, cultureRate:0, cultureMultiplier:2, horizonDays:1,
    planets: [1,2,3].map(id => ({ id, population:10, HF:20, RF:20, RL:20, GC:0, pp:0 })) });
const gcHours = gc.totals.simulatedHours;
const expectedGC = gc.planets.flatMap(p => p.builds).filter(b => b.building === 'GC').reduce((total, b) => total + 2 * (gcHours - b.hours), 0);
ok('each completed cybernet adds one base culture per hour, scaled by its own measured multiplier', expectedGC > 0 && near(gc.totals.culturePoints, expectedGC), { actual:gc.totals.culturePoints, expectedGC });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
