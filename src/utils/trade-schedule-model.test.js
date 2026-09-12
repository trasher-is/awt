const model = require('../../public/js/utils/trade-schedule-model');
const road = require('../../public/js/utils/road-to-ta-model');
const fs = require('fs');
const vm = require('vm');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) < epsilon;
const player = (name, extra = {}) => ({ name, production_rate: 100, astro_dollars: 0, production_points: 0, trade_partners: [], ...extra });
const plan = (players, price = 1, pairs = [['A', 'B']], traders = []) => model.plan(players, price, {pairs, traders, cost:20000});
console.log('trade-schedule-model.test.js');
ok('both planning models use the same ordinary A$ fee', model.constants.AGREEMENT_FEE === road.constants.FEE);
for (const price of [0.125, 0.5, 1, 2]) {
    const result = plan([player('A', {astro_dollars:5000, production_points:2000, production_rate:25.5}), player('B', {astro_dollars:20000})], price);
    const expected = (20000 - 5000 - 2000 * price) / (25.5 * price);
    ok(`${price} A$/PP: both current PP and future PP income use the same conversion`, near(result.schedule[0]?.time, expected), result);
    for (const balance of result.balances) {
        ok(`${price} A$/PP: ${balance.name} conserves A$ value across funding`, near(balance.initialCash + balance.initialPP * price + balance.earnedCash, balance.spentCash + balance.remainingValue));
    }
}
const sequential = plan([player('A'), player('B'), player('C')], 0.5, [['A','B'],['A','C']]);
ok('a player pays for each successive ordinary agreement', sequential.schedule.length === 2 && near(sequential.schedule[0].time,400) && near(sequential.schedule[1].time,800));
ok('finished participants stop accumulating unneeded simulated income', sequential.balances.find(b=>b.name==='B').earnedCash === 20000);
ok('all ordinary participants pay 20,000 A$ per scheduled agreement', sequential.schedule.every(s=>s.cost1===20000&&s.cost2===20000));
const cashOnly = plan([player('A',{astro_dollars:20000,production_points:null,production_rate:null}), player('B',{astro_dollars:20000,production_points:null,production_rate:null})], null);
ok('known cash can fund immediately without unrelated market or PP observations', cashOnly.schedule[0]?.time === 0 && !cashOnly.unresolved.length);
ok('unknown total wealth stays null even when cash alone funds the fee', cashOnly.balances.every(b=>b.remainingValue===null));
const freeTrader = plan([player('A',{astro_dollars:20000}), player('T',{astro_dollars:null,production_points:null,production_rate:null})], null, [['T','A']], ['t']);
ok('Trader acceptance is free and explicitly reverses a Trader-first board pair', freeTrader.schedule[0]?.p1==='A' && freeTrader.schedule[0]?.p2==='T' && freeTrader.schedule[0]?.cost2===0);
ok('Trader direction and funding-only limits are disclosed', freeTrader.assumptions.some(a=>a.includes('assumed to initiate')) && freeTrader.assumptions.some(a=>a.includes('Funding estimate only')));
const twoTraders=plan([player('A'),player('B')],1,[['A','B']],['A','B']);
ok('unsupported Trader–Trader pairs remain unresolved', !twoTraders.schedule.length && twoTraders.unresolved[0].reason.includes('Trader–Trader'));
const prioritize=plan([player('A'),player('B'),player('T')],1,[['A','B'],['A','T']],['T']);
ok('pending Trader link has priority for a shared payer', prioritize.schedule[0]?.p2==='T' && prioritize.schedule[1]?.time===400);
const unblocked=plan([player('A'),player('B'),player('U',{astro_dollars:null}),player('T')],1,[['U','T'],['A','B']],['T']);
ok('an unresolved Trader pair cannot prevent independent ordinary funding', unblocked.schedule.length===1 && unblocked.schedule[0].p1==='A' && unblocked.unresolved.length===1);

for (const [name, members, price] of [
    ['missing cash', [player('A',{astro_dollars:null}),player('B')], 1],
    ['missing PP', [player('A',{production_points:null}),player('B')], 1],
    ['missing rate', [player('A',{production_rate:null}),player('B')], 1],
    ['zero rate', [player('A',{production_rate:0}),player('B')], 1],
    ['zero price', [player('A'),player('B')], 0],
    ['negative price', [player('A'),player('B')], -1],
    ['absent price', [player('A'),player('B')], null],
    ['tiny income outside horizon', [player('A',{production_rate:1e-100}),player('B')], 1],
    ['missing player', [player('A')], 1],
    ['duplicate player name', [player('A'),player('a'),player('B')], 1],
]) {
    const result = plan(members,price);
    ok(`${name} is unresolved with a reason, never a fabricated zero or enormous ETA`, result.schedule.length===0 && result.unresolved.length===1 && result.unresolved[0].reason && result.totalHours===null && result.lastScheduledHours===0);
}
const already=plan([player('A',{id:1,trade_partners:[2,'2','b']}),player('B',{id:2})]);
ok('reported completion from either side prevents charging a confirmed pair again', !already.schedule.length && already.unresolved[0].reason.includes('already present'));
const partial=plan([player('A',{id:1,trade_partners:[2,null]}),player('B',{id:2})]);
ok('a valid completed edge survives an otherwise partial observation',!partial.schedule.length&&partial.unresolved[0].reason.includes('already present'));
const known=plan([player('A',{trade_partners:null,known_partners:['b']}),player('B')]);
ok('Board canonical known edges prevent repeat charges when the full count is unknown',!known.schedule.length&&known.unresolved[0].reason.includes('already present'));
const aliases=plan([player('A',{id:1,trade_partners:[2,'2','b',3,'c',4,5]}),player('B',{id:2}),player('C',{id:3}),player('D',{id:4}),player('E',{id:5}),player('F',{id:6})],1,[['A','F']]);
ok('reported ID/name aliases count once so the fifth real agreement remains possible', aliases.schedule.length===1 && !aliases.unresolved.length);
const capped=plan([player('A',{trade_partners:['v','w','x','y','z']}),player('B')]);
ok('five reported agreements block a sixth forecast', !capped.schedule.length && capped.unresolved[0].reason.includes('five'));
const reciprocal=plan([player('A',{id:1}),player('B'),...['v','w','x','y','z'].map(name=>player(name,{trade_partners:[1]}))]);
ok('reciprocal completed reports also establish the five-slot limit', !reciprocal.schedule.length && reciprocal.unresolved[0].reason.includes('five'));
const futureCap=plan([player('A',{astro_dollars:200000}),...['B','C','D','E','F','G'].map(name=>player(name,{astro_dollars:20000}))],1,['B','C','D','E','F','G'].map(name=>['A',name]));
ok('new scheduled agreements consume slots before later pairs', futureCap.schedule.length===5 && futureCap.unresolved.length===1);
const unknownPartners=plan([player('A',{trade_partners:null}),player('B')]);
ok('unknown completed partners do not masquerade as a known empty list', unknownPartners.schedule.length===1 && unknownPartners.assumptions.some(a=>a.includes('remaining TA slots cannot be fully verified')));
const duplicate=plan([player('A'),player('B')],1,[['A','B'],['b','a']]);
ok('reversed duplicate confirmed pairs are charged once and reported', duplicate.schedule.length===1 && duplicate.unresolved.length===1);
for (const config of [null, {}, {pairs:null}, {pairs:[['A']]}, {pairs:[['A','A']]}, {pairs:[['A','B']],cost:1000}, {pairs:Array(1001).fill(['A','B'])}]) {
    const result=model.plan([player('A'),player('B')],1,config);
    ok('invalid or excessive input returns a bounded unresolved result', result.unresolved.length>0 && result.schedule.length===0 && result.maxBounded);
}
const empty=plan([player('A')],null,[]);
ok('a genuinely empty confirmed board is distinct from unresolved pairs', empty.schedule.length===0 && empty.unresolved.length===0 && empty.totalHours===0);

for (const price of [0.5,1,2]) {
    const roadResult=road.plan({now:'2026-09-12T12:00:00Z',mode:'rush',
        planets:[1,2].map(id=>({id,population:10,HF:20,RF:20,RL:20,GC:20,pp:500})),
        social:10,playerLevel:1,scienceRate:60,productionMultiplier:1,growthMultiplier:1,scienceMultiplier:1,
        currentTradeBonusPct:0,cash:5000,ppPrice:price,completedTas:4,partnerQualifiedPlanets:[0],horizonDays:60});
    const alliance=plan([player('A',{astro_dollars:5000,production_points:1000,production_rate:60}),player('B',{astro_dollars:20000})],price);
    ok(`mature empire at ${price} A$/PP agrees with Road to TA when additional mechanics are inactive`, near(alliance.schedule[0].time,roadResult.agreements[0].fundedHours));
}
let seed=193;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
let conserved=true;
for(let i=0;i<80;i++) {
    const price=0.25+random()*2;
    const rows=['A','B','C','D'].map(name=>player(name,{astro_dollars:random()*10000,production_points:random()*10000,production_rate:100+random()*100}));
    const result=plan(rows,price,[['A','B'],['A','C'],['B','D'],['C','D']]);
    conserved &&= result.schedule.length===4 && result.balances.every(b=>b.remainingValue>=-1e-6 && near(b.initialCash+b.initialPP*price+b.earnedCash,b.spentCash+b.remainingValue,1e-5));
}
ok('80 deterministic network scenarios conserve every participant’s cash value',conserved);
const realm={};vm.runInNewContext(fs.readFileSync(require.resolve('../../public/js/utils/trade-schedule-model'),'utf8'),realm);
ok('the same model runs in a browser realm without CommonJS or ESM dependencies',typeof realm.AWTradeSchedule?.plan==='function' && realm.AWTradeSchedule.plan([player('A'),player('B')],2,{pairs:[['A','B']]}).schedule[0].time===100);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode=fail?1:0;
