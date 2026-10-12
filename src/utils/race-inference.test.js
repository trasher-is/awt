// Invented observations; the existing calculator fixtures are read, never edited.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const model = require('../../public/js/utils/battle-model');
const inference = require('../../public/js/utils/race-inference');
const { buildRaceObservations, inferBattleRace } = require('./battle-race-inference');
let failed = 0, passed = 0;
function ok(name, condition, detail) { if (condition) { passed++; console.log(`  ok - ${name}`); } else { failed++; console.error(`  NOT OK - ${name}`, detail || ''); } }
const known = { ra: 0, rd: 0, phys: 12, math: 12, lvl: 20 };
function observation({ id = 1, role = 'att', atkFleet = [0, 300, 0], defFleet = [2600, 0, 0],
    stats = { ra: 2, rd: 1, phys: 12, math: 11, lvl: 20 }, ally = known, scienceCeiling = 14, levelCeiling = 0,
    noise = 0, when = Date.parse('2026-10-01T12:00:00Z'), sbLevel = 0 } = {}) {
    const result = model.simulate({ atkFleet, defFleet, sbLevel, atk: role === 'att' ? stats : ally, def: role === 'att' ? ally : stats });
    const survivors = (role === 'att' ? result.survAtk : result.survDef).map(Math.round);
    const fleet = role === 'att' ? atkFleet : defFleet;
    return { report_id: id, side: role, when, atkFleet, defFleet, sbLevel, known: ally, scienceCeiling, levelCeiling,
        survivors, losses: fleet.map((n, i) => n - survivors[i]), defense_candidates: inference.PICKS,
        attack_candidates: inference.PICKS, observedWin: Math.max(0, Math.min(100, result.winA * 100 + noise)),
        dice: null, subjectWon: true, attackerWon: role === 'att' };
}
const hasTruth = (row, truth) => row.set90_low <= truth && truth <= row.set90_high;
console.log('race-inference.test.js');
const basic = inference.estimate([observation()]);
ok('distributions are normalized and keep a reported prior', Math.abs(basic.attack.dist.reduce((a,b)=>a+b,0)-1)<1e-10 && basic.prior.name === 'uniform');
ok('a known-input synthetic fight retains the Attack and Defence truth', hasTruth(basic.attack,2) && hasTruth(basic.defence,1), basic);
const empty = inference.estimate([]);
ok('no outcome-only evidence invents a race', empty.attack.band === 'none' && empty.attack.most_likely === null);
const outcomeOnly = observation(); outcomeOnly.observedWin = null; outcomeOnly.dice = null;
ok('winner alone never becomes Attack evidence', inference.estimate([outcomeOnly]).attack.evidence_count === 0);
const dice = { ...outcomeOnly, dice: 40, attackerWon: true };
const diceResult = inference.estimate([dice]);
ok('dice fallback stays weak and flagged', diceResult.attack.band !== 'high' && diceResult.attack.evidence[0].flags.includes('dice_fallback'));
const cap = { ...observation(), observedWin: 100 };
const capMatrix = inference.evidenceMatrix(cap, 'attack');
ok('certainty uses step support rather than a Gaussian point', capMatrix.matrix.flat().every(value => value === 0 || value === -Infinity));
const floor = { ...observation(), survivors: [0,1,0] };
ok('the one-survivor floor carries no precise Defence evidence', inference.estimate([floor]).defence.evidence_count === 0);
const hard = inference.estimate([observation()], { hardRanges: { attack: [1,2,3], defence: [0,1,2] } });
ok('every distribution remains inside its shared hard range', hard.attack.dist.every((p,i)=>p===0 || [1,2,3].includes(i-4)) && hard.defence.dist.every((p,i)=>p===0 || [0,1,2].includes(i-4)));
const conflicting = inference.estimate([observation()], { hardRanges: { attack: [] } });
ok('incompatible evidence is held without inventing a nearest value', conflicting.attack.conflict && conflicting.attack.most_likely === null);
const one = observation({ stats: {ra:3,rd:1,phys:13,math:11,lvl:20}, scienceCeiling:14 });
const two = observation({ id:2, stats:{ra:3,rd:1,phys:13,math:11,lvl:20}, ally:{...known,phys:6,math:17},scienceCeiling:14 });
const combined = inference.estimate([one,two]);
ok('different known-side physics separates Attack/science hypotheses', hasTruth(combined.attack,3) && combined.attack.dist[7] >= inference.estimate([one]).attack.dist[7]);
ok('same-window evidence multiplies the shared science likelihood before marginalizing', (() => {
    const rows = [one,two].map(row=>inference.evidenceMatrix(row,'attack'));
    const scores = inference.PICKS.map((_,i)=>rows[0].matrix[i].reduce((sum,value,j)=>sum+Math.exp(value+rows[1].matrix[i][j]),0));
    const total=scores.reduce((a,b)=>a+b,0);
    return combined.attack.dist.every((p,i)=>Math.abs(p-scores[i]/total)<1e-10);
})());
const independent = inference.estimate([one,{...two,when:two.when+49*3600000}]);
ok('different windows marginalize independent historical science values', JSON.stringify(independent.attack.dist)!==JSON.stringify(combined.attack.dist));
const browser = vm.createContext({ AWBattleModel:model });
vm.runInContext(fs.readFileSync(path.join(__dirname,'../../public/js/utils/race-inference.js'),'utf8'),browser);
ok('the browser realm publishes the same estimator API', typeof browser.AWRaceInference.estimate === 'function' && JSON.stringify(browser.AWRaceInference.estimate([one,two]))===JSON.stringify(combined));

// Reconstruct real calculator fixtures with the subject race hidden. These are the
// already-reviewed ground truth, not newly harvested player data.
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname,'battle-fixtures.json'),'utf8'));
let fixtureCases=0, fixtureContained=0, fixtureExact=0;
for (const row of fixtures.winChance) {
    if (!row.atk || !row.def || !Number.isFinite(row.observedDefenderWinPct)) continue;
    const stats = s=>({ra:s.raceAttack||0,rd:s.raceDefense||0,phys:s.physics||0,math:s.mathematics||0,lvl:s.level||0});
    const subject=stats(row.atk), ally=stats(row.def);
    const obs=observation({atkFleet:row.atk.fleet,defFleet:row.def.fleet,stats:subject,ally,
        sbLevel:row.def.starbase||0,scienceCeiling:Math.max(1,subject.phys,subject.math),levelCeiling:subject.lvl});
    obs.observedWin=100-row.observedDefenderWinPct;
    const result=inference.estimate([obs],{calibrated:true});fixtureCases++;
    if(hasTruth(result.attack,subject.ra))fixtureContained++;
    if(result.attack.set90_low===subject.ra&&result.attack.set90_high===subject.ra)fixtureExact++;
}
ok(`hidden Attack is contained in all ${fixtureCases} fixed calculator fixtures (${fixtureExact} exact)`,fixtureCases>0&&fixtureContained===fixtureCases,{fixtureCases,fixtureContained,fixtureExact});

// Seeded noise evaluates the real posterior; results are printed, not asserted as
// measured live calibration. The production display gate uses later bio pairs.
let seed=278;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
let count=0, covered=0, high=0, highCorrect=0;
for(let i=0;i<200;i++){
    const ra=Math.floor(random()*9)-4,phys=Math.floor(random()*15);
    const stats={ra,rd:0,phys,math:10,lvl:20};
    const rows=[12,6].map((physKnown,j)=>observation({id:i*2+j+1,stats,ally:{...known,phys:physKnown},scienceCeiling:14,
        noise: Math.sqrt(-2*Math.log(Math.max(1e-8,random())))*Math.cos(2*Math.PI*random())*model.uncertainty.BASE_ERROR_PP}));
    if(rows.some(row=>row.observedWin===0||row.observedWin===100))continue;
    const result=inference.estimate(rows,{calibrated:true}).attack;count++;
    if(hasTruth(result,ra))covered++;
    if(result.band==='high'){high++;if(result.most_likely===ra)highCorrect++;}
}
ok('seeded noisy observations retain at least 88% of Attack truths',count>30&&covered/count>=0.88,{count,covered,coverage:covered/count});
ok('the evaluated high band is at least 90% correct',high>0&&highCorrect/high>=0.9,{high,highCorrect,accuracy:highCorrect/high});
console.log(`  Synthetic Attack calibration: ${covered}/${count} sets cover truth; ${highCorrect}/${high} high-band selections are correct.`);

let harvestCases=0,harvestContained=0,harvestExact=0,harvestCompatible=0,harvestEligible=0,unambiguous=0,unambiguousCorrect=0,shadowContained=0,unsafeHigh=0;
const hardFailures=[], posteriorFailures=[];
for(const filename of fs.readdirSync(path.join(__dirname,'../../scripts/battle-harvest')).filter(name=>name.endsWith('.jsonl'))){
    for(const line of fs.readFileSync(path.join(__dirname,'../../scripts/battle-harvest',filename),'utf8').trim().split('\n')){
        const row=JSON.parse(line),input=row.in,output=row.out;
        if(!input||!output||input.allied)continue;
        const num=value=>Number(String(value).replace(/,/g,''));
        const value=num(output.a_win);if(!Number.isFinite(value))continue;
        const stats={ra:input.a_ra,rd:input.a_rd,phys:input.a_ph,math:input.a_ma,lvl:input.a_pl};
        const ally={ra:input.d_ra,rd:input.d_rd,phys:input.d_ph,math:input.d_ma,lvl:input.d_pl};
        const atkFleet=[input.a_de,input.a_cr,input.a_bs],defFleet=[input.d_de,input.d_cr,input.d_bs];
        if(!model.simulate({atkFleet,defFleet,sbLevel:input.d_sb,atk:stats,def:ally}))continue;
        const obs=observation({atkFleet,defFleet,stats,ally,sbLevel:input.d_sb,scienceCeiling:Math.max(1,stats.phys,stats.math),
            levelCeiling:atkFleet.every(n=>n>0)||defFleet.every(n=>n>0)?stats.lvl:0});
        obs.observedWin=value;obs.defense_candidates=null;obs.survivors=null;
        const report={id:100000+harvestCases,is_public:1,started_at:'2026-10-01T12:00:00Z',att_player_id:11,def_player_id:22,
            att_has_won:1,def_has_won:0,att_win_chance:value,stats_snapshot_at:'2026-10-01 12:05:00',
            def_race_attack:ally.ra,def_race_defense:ally.rd,def_physics:ally.phys,def_mathematics:ally.math,
            def_player_level:ally.lvl,def_intel_at:'2026-10-01 12:00:00'};
        for(const [side,fleet]of[['att',atkFleet],['def',defFleet]]){
            model.SHIPS.forEach((ship,i)=>report[`${side}_${ship.key}`]=fleet[i]);
            for(const ship of['transports','colony_ships','starbases'])report[`${side}_${ship}`]=side==='def'&&ship==='starbases'&&input.d_sb>0?1:0;
            report[`${side}_combat_value`]=model.cvOf(fleet)+(side==='def'?model.sbCV(input.d_sb):0);
        }
        const built=buildRaceObservations(11,[report],{subject:{science_level:obs.scienceCeiling,level:stats.lvl}});
        const candidates=built.observations[0]?.attack_candidates;
        if(candidates){harvestEligible++;if(candidates.includes(stats.ra))harvestCompatible++;else hardFailures.push({file:filename,index:row.i,block:row.block,observedWin:value,
            trueModelWin:model.simulate({atkFleet,defFleet,sbLevel:input.d_sb,atk:stats,def:ally}).winA*100,stats,ally,candidates});}
        const shadow=inference.estimate([obs],{hardRanges:{attack:candidates||inference.PICKS}}).attack;
        const result={...shadow,set90_low:shadow.credible_low,set90_high:shadow.credible_high};harvestCases++;
        if(shadow.set90_values.includes(stats.ra))shadowContained++;
        if(shadow.band==='high'&&shadow.hard_candidates.length>2)unsafeHigh++;
        if(candidates?.length===1){unambiguous++;if(result.most_likely===stats.ra&&result.set90_low===stats.ra&&result.set90_high===stats.ra)unambiguousCorrect++;}
        if(hasTruth(result,stats.ra))harvestContained++;
        else if(posteriorFailures.length<8)posteriorFailures.push({file:filename,index:row.i,block:row.block,truth:stats.ra,ceiling:obs.scienceCeiling,candidates,
            posterior:result.dist,interval:[result.set90_low,result.set90_high]});
        if(result.set90_low===stats.ra&&result.set90_high===stats.ra)harvestExact++;
    }
}
ok(`hard Attack compatibility preserves truth in all ${harvestEligible} eligible stored calculator samples`,harvestEligible>3000&&harvestCompatible===harvestEligible,{harvestEligible,harvestCompatible});
ok(`all ${unambiguous} unambiguous stored samples recover the hidden Attack exactly`,unambiguous>0&&unambiguousCorrect===unambiguous,{unambiguous,unambiguousCorrect});
ok(`the conservative uncalibrated set preserves every one of ${harvestCases} stored truths`,shadowContained===harvestCases,{shadowContained,harvestCases});
ok('nuisance-prior degeneracy never produces a high band with more than two compatible values',unsafeHigh===0,{unsafeHigh});
ok(`at least90% of ${harvestCases} stored calculator samples retain truth in the probability interval`,harvestCases>3000&&harvestContained/harvestCases>=0.9,{harvestCases,harvestContained,harvestExact});
console.log(`  Stored-sample Attack evaluation: ${harvestContained}/${harvestCases} intervals contain truth; ${harvestExact} exact intervals. This fixed sample population is not a live calibration.`);
console.log('  Hard compatibility discrepancies:',JSON.stringify(hardFailures));
console.log('  First posterior exclusions:',JSON.stringify(posteriorFailures));

// The shared observation gate must reject contradictions before either estimator.
const report={id:900,is_public:1,started_at:'2026-10-01T12:00:00Z',att_player_id:11,def_player_id:22,
    att_has_won:1,def_has_won:0,dice_consistent:0};
const rejected=buildRaceObservations(11,[report],{subject:{science_level:14,level:20}});
ok('inconsistent dice are excluded globally',rejected.observations.length===0&&rejected.skipped.dice_inconsistent===1);
const before=buildRaceObservations(11,[{...report,dice_consistent:null}],{notBefore:'2026-10-02T00:00:00Z'});
ok('the estimator shares the resign evidence cutoff',before.observations.length===0&&before.skipped.before_current_player===1);
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
