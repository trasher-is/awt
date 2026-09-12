// Synthetic economic oracles: cash is A$, buildings spend only their planet's PP,
// and a partner's new bonus cannot accelerate funding before its activation window.
const model = require('../../public/js/utils/road-to-ta-model');
const T = require('../../public/js/utils/game-tables');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const near = (actual, expected, epsilon = 1e-6) => Math.abs(actual - expected) <= epsilon;
const planet = (id, extra = {}) => ({ id, name: `Synthetic ${id}`, population: 10, HF: 20, RF: 20, RL: 20, GC: 20, pp: 0, ...extra });
const base = extra => ({ now: '2026-09-12T12:00:00Z', mode: 'rush', planets: [planet(1), planet(2)],
    social: 10, playerLevel: 1, scienceRate: 60, productionMultiplier: 1, growthMultiplier: 1,
    scienceMultiplier: 1, cash: 0, ppPrice: 1, completedTas: 4, currentTradeBonusPct: 0,
    horizonDays: 60, ...extra });
const first = result => result.agreements[0];
function conservation(name, input, result) {
    const ppStart = input.planets.reduce((n, p) => n + p.pp, 0);
    ok(`${name}: PP conservation includes local buildings, sold PP and final balances`,
        near(ppStart + result.totals.earnedPP, result.totals.buildingPP + result.totals.soldPP + result.totals.pp, 1e-5), result.totals);
    ok(`${name}: A$ conservation counts actual sale proceeds and agreement fees`,
        near(input.cash + result.totals.saleProceeds, result.totals.spentCash + result.totals.cash, 1e-5), result.totals);
}

console.log('road-to-ta-model.test.js');
for (const price of [0.5, 1, 2]) {
    const input = base({ cash: 5000, ppPrice: price });
    const result = model.plan(input);
    ok(`price ${price}: funding uses 15000 A$ divided by actual A$/PP income`, near(first(result).fundedHours, 15000 / (60 * price)), first(result));
    ok(`price ${price}: PP sold is the cash deficit divided by price`, near(result.totals.soldPP, 15000 / price));
    ok(`price ${price}: published cost is always 20000 A$`, first(result).cost === 20000 && result.totals.spentCash === 20000);
    conservation(`price ${price}`, input, result);
}
const cashOnly = model.plan(base({ cash: 20000, playerLevel: 0 }));
ok('existing A$ funds immediately without PP selling eligibility', first(cashOnly).fundedHours === 0 && cashOnly.totals.soldPP === 0);
const trader = model.plan(base({ traderAccept: true, playerLevel: 0, completedTas: 0 }));
ok('confirmed Trader acceptance funds all remaining fees for zero A$', trader.agreements.length === 5 && trader.agreements.every(a => a.cost === 0 && a.fundedHours === 0));
const ordinary = model.plan(base({ traderAccept: false, cash: 0 }));
ok('initiating an agreement still costs the ordinary fee', first(ordinary).cost === 20000 && first(ordinary).fundedHours > 0);
const saleGate = model.plan(base({ cash: 19999 }));
ok('sale waits for 150 combined PP even when only one A$ is missing', near(first(saleGate).fundedHours, 150 / 60), first(saleGate));
ok('Spend All sells all 150 PP and retains the 149 A$ surplus', near(saleGate.totals.soldPP,150) && near(saleGate.totals.cash,149) && near(saleGate.totals.pp,0));
const noPlayerLevel = model.plan(base({ playerLevel: 0 }));
ok('unknown future Player Level growth never silently unlocks PP sales', first(noPlayerLevel).fundedHours === null && noPlayerLevel.warnings.some(w => w.includes('Player Level 1')));

for (const [mode, count] of [['rush', 2], ['normal', 3], ['slow', 6]]) {
    const enough = model.plan(base({ mode, cash: 20000, planets: Array.from({length: count}, (_, i) => planet(i + 1)) }));
    ok(`${mode}: its own ${count}-planet threshold accepts population 10`, enough.ok && enough.gate.requiredPlanets === count && first(enough).fundedHours === 0);
    const short = model.plan(base({ mode, planets: Array.from({length: count - 1}, (_, i) => planet(i + 1)) }));
    ok(`${mode}: insufficient current planets blocks the plan rather than inventing colonies`, !short.ok && short.errors.some(e => e.includes('Expand first')));
}
const socialInput = base({ social: 9, scienceRate: 10, cash: 20000, planets: [planet(1, {population:9, HF:30, RF:30, RL:30, GC:30}), planet(2, {population:9, HF:30, RF:30, RL:30, GC:30})] });
const social = model.plan(socialInput);
const socialHours = T.SCIENCE[10] / 10;
const growthHours = T.POP_GROWTH[10] / 31;
ok('Social 10 research finishes before capped planets start growing toward 10', near(social.gate.hours, socialHours + growthHours), social.gate);
ok('the population policy also delays a cash-funded agreement until its population gate', near(first(social).fundedHours, social.gate.hours));
ok('research spends science points, never PP or cash', social.totals.buildingPP === 0 && social.totals.soldPP === 0 && near(social.totals.spentCash, 20000));
ok('missing population progress is disclosed as a conservative assumption', social.assumptions.some(a => a.includes('progress') && a.includes('zero')));
conservation('social gate', socialInput, social);
const progress = model.plan({...socialInput, social:10, planets:socialInput.planets.map(p=>({...p,growthPoints:800}))});
ok('known within-level growth progress narrows the population-gate forecast', near(progress.gate.hours, 13 / 31));

const developmentInput = base({ mode:'normal', completedTas:0,
    planets:[planet(1, {HF:0,RF:0,RL:0,GC:0,pp:1000}), planet(2, {HF:0,RF:0,RL:0,GC:0}), planet(3, {HF:0,RF:0,RL:0,GC:0})] });
const development = model.plan(developmentInput);
ok('a poor planet cannot use another planet\'s 1000 PP for its first building', near(development.planets[1].builds[0].hours, 0.5), development.planets[1].builds[0]);
ok('Normal protects lab and cybernet development before selling that planet\'s PP', development.planets.every(p=>p.target.RL>=10 && p.target.GC>=8));
ok('per-planet ordered builds use published incremental costs', development.planets.every(p=>p.builds.every(b=>b.cost===T.BUILDING[b.to] && b.to===b.from+1)));
ok('per-planet saving times follow the final planned construction', development.planets.every(p=>p.savingHours!==null && p.builds.every(b=>b.hours<=p.savingHours)));
conservation('Normal development', developmentInput, development);
const slow = model.plan({...developmentInput,mode:'slow',planets:Array.from({length:6},(_,i)=>planet(i+1,{HF:0,RF:0,RL:0,GC:0}))});
ok('Slow keeps higher lab/culture floors than Normal', slow.planets.every(p=>p.target.RL>=12 && p.target.GC>=12));

const bonusInput = base({ cash:20000, completedTas:3, currentTradeBonusPct:25, partnerQualifiedPlanets:[10,0] });
const withBonus = model.plan(bonusInput);
const withoutBonus = model.plan({...bonusInput,partnerQualifiedPlanets:[0,0]});
const activationHours = first(withBonus).activeHours;
const bonusFactor = 1.35/1.25;
const expectedSecond = activationHours + (20000 - 60*activationHours)/(60*bonusFactor);
ok('the first funded agreement is unaffected by its own future bonus', first(withBonus).fundedHours === 0 && first(withoutBonus).fundedHours === 0);
ok('new TA bonuses apply only after their activation and normalize the existing trade bonus', near(withBonus.agreements[1].fundedHours, expectedSecond), withBonus.agreements[1]);
ok('known partner planets accelerate subsequent funding', withBonus.agreements[1].fundedHours < withoutBonus.agreements[1].fundedHours);
ok('unknown partner counts default to zero additional trade benefit', model.plan(base()).assumptions.some(a=>a.includes('zero forecast trade bonus')));
conservation('sequential bonuses', bonusInput, withBonus);

const siegeInput = base({ planets:[planet(1,{is_sieged:1}),planet(2,{is_sieged:1})] });
const siege = model.plan(siegeInput);
ok('sieged planet sales realize only 70% at the selected price', near(first(siege).fundedHours, 20000/(60*0.7)) && near(siege.totals.lostSiegePP,siege.totals.soldPP*0.3));
ok('sieges are disclosed and do not get imaginary building orders', siege.warnings.some(w=>w.includes('70%')) && siege.planets.every(p=>p.builds.length===0));
conservation('siege sales', siegeInput, siege);

for (const [at, expected] of [
    ['2026-03-28T23:00:00Z','2026-03-29T04:05:00.000Z'],
    ['2026-10-24T22:00:00Z','2026-10-25T05:05:00.000Z'],
    ['2026-09-12T15:59:30Z','2026-09-12T16:05:00.000Z'],
    ['2026-09-12T16:00:00Z','2026-09-12T22:05:00.000Z']
]) ok(`Berlin trade acceptance handles boundary/DST: ${at}`, new Date(model.nextTradeActivation(at)).toISOString()===expected);
const originalTZ=process.env.TZ;
try {
    process.env.TZ='America/Los_Angeles';const la=JSON.stringify(model.plan(base()));
    process.env.TZ='Europe/Warsaw';const warsaw=JSON.stringify(model.plan(base()));
    ok('funding and activation instants do not depend on the server/browser timezone',la===warsaw);
    for (const zone of ['UTC', 'America/Los_Angeles', 'Europe/Warsaw']) {
        process.env.TZ = zone;
        const equivalent = ['2026-09-12 12:00:00', '2026-09-12T12:00:00', '2026-09-12T14:00:00+02:00', Date.parse('2026-09-12T12:00:00Z')];
        ok(`${zone}: SQLite UTC, unzoned hub ISO, explicit offset and epoch identify the same forecast`,
            equivalent.every(now => JSON.stringify(model.plan(base({now}))) === warsaw));
        ok(`${zone}: acceptance parsing uses the same UTC convention`,
            equivalent.every(now => model.nextTradeActivation(now) === model.nextTradeActivation('2026-09-12T12:00:00Z')));
    }
} finally { if(originalTZ===undefined) delete process.env.TZ;else process.env.TZ=originalTZ; }
for (const invalid of ['2026-02-30T12:00:00Z', '2026-02-29 12:00:00', '2026-09-12T24:00:00Z', '09/12/2026 12:00']) {
    ok(`a malformed calendar/locale forecast timestamp is rejected: ${invalid}`, !model.plan(base({now:invalid})).ok);
    let rejected = false;
    try { model.nextTradeActivation(invalid); } catch { rejected = true; }
    ok(`a malformed calendar/locale acceptance timestamp is rejected: ${invalid}`, rejected);
}
const horizon = model.plan(base({horizonDays:1/24}));
ok('an exhausted horizon returns unknown milestones rather than false ETAs', first(horizon).fundedAt===null && horizon.warnings.length>0 && near(horizon.totals.simulatedHours,1));
const done = model.plan(base({completedTas:5,social:0,scienceRate:0}));
ok('five completed agreements require no additional funding or research',done.ok && done.agreements.length===0 && done.totals.simulatedHours===0);
const wealthyDone = model.plan(base({mode:'normal',completedTas:5,planets:[planet(1,{HF:0,RF:0,RL:0,GC:0,pp:100000})]}));
ok('a completed five-TA plan never spends a rich planet\'s existing PP',wealthyDone.ok && wealthyDone.totals.buildingPP===0 && wealthyDone.totals.pp===100000 && wealthyDone.planets[0].builds.length===0);
const fundedCash = model.plan({...developmentInput,cash:100000});
ok('enough cash for all remaining agreements avoids unnecessary construction', fundedCash.agreements.every(a=>a.fundedHours===0) && fundedCash.totals.buildingPP===0 && fundedCash.planets.every(p=>p.builds.length===0));
const advanced = model.plan(base({planets:[planet(1,{HF:40,RF:50,RL:60,GC:70}),planet(2,{HF:35,RF:45,RL:55,GC:65})]}));
ok('existing SU-funded levels above the PP table are preserved without invented upgrades', advanced.ok && advanced.planets[0].final.RF===50 && advanced.planets[0].final.GC===70 && advanced.totals.buildingPP===0);
const immutable=base();const before=JSON.stringify(immutable);model.plan(immutable);
ok('planning never mutates the supplied player snapshot',JSON.stringify(immutable)===before);
for(const patch of [{ppPrice:0},{ppPrice:NaN},{cash:-1},{scienceRate:null},{productionMultiplier:null},{currentTradeBonusPct:null},{social:1.2},{playerLevel:null},{completedTas:6},{horizonDays:181},{partnerQualifiedPlanets:[-1]},{now:'not a timestamp'}]) {
    ok(`invalid/missing input is rejected: ${Object.keys(patch)[0]}`, !model.plan(base(patch)).ok);
}
for(const patch of [{HF:null},{pp:null},{population:0},{RL:101},{growthPoints:1000000},{is_sieged:'0'}]) {
    ok(`invalid planet input is rejected: ${Object.keys(patch)[0]}`, !model.plan(base({planets:[planet(1,patch),planet(2)]})).ok);
}
ok('duplicate planet identifiers cannot double count production',!model.plan(base({planets:[planet(1),planet(1)]})).ok);
ok('empty planet list does not invent an empire',!model.plan(base({planets:[]})).ok);
console.log(`\n${pass} passed, ${fail} failed`);
if(fail)process.exit(1);
