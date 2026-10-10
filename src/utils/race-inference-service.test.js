// Every player/report here is invented, on an isolated scratch database.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'awt-race-service-'));
process.env.AWT_DB_PATH = path.join(temp,'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-password';
delete process.env.DISCORD_TOKEN;delete process.env.BATTLE_DISCORD_TOKEN;
const db = require('../database');
const model = require('../../public/js/utils/battle-model');
const arithmetic = require('../../public/js/utils/race-inference');
const service = require('./race-inference-service');
const repository = require('../repositories/raceEstimates');
const { modelVersion } = require('./race-evidence');
const express = require('express');
const router = require('../routes/race-intel');
let failed=0;
function ok(name,condition,detail){if(condition)console.log(`  ok - ${name}`);else{failed++;console.error(`  NOT OK - ${name}`,detail||'');}}
db.prepare(`INSERT INTO players(id,name,has_intel,science_level,level,joined) VALUES(11,'Synthetic subject',0,14,20,'2026-09-01T00:00:00Z')`).run();
db.prepare(`INSERT INTO players(id,name,has_intel,race_attack,race_defense,physics,mathematics,level,intel_updated_at)
    VALUES(22,'Synthetic member',1,0,0,12,12,20,'2026-10-01 10:00:00')`).run();
function report(id,ra=2,rd=1){
    const atkFleet=[0,300,0],defFleet=[2600,0,0];
    const result=model.simulate({atkFleet,defFleet,atk:{ra,rd,phys:12,math:11,lvl:20},def:{ra:0,rd:0,phys:12,math:12,lvl:20}});
    const row={id,started_at:'2026-10-01T12:00:00Z',is_public:1,att_player_id:11,def_player_id:22,att_has_won:1,def_has_won:0,
        att_win_chance:result.winA*100,dice_roll:0,dice_consistent:1,stats_snapshot_at:'2026-10-01 12:05:00',
        def_race_attack:0,def_race_defense:0,def_physics:12,def_mathematics:12,def_player_level:20,def_intel_at:'2026-10-01 10:00:00'};
    for(const [side,fleet,survivors]of[['att',atkFleet,result.survAtk],['def',defFleet,result.survDef]]){
        model.SHIPS.forEach((ship,i)=>{row[`${side}_${ship.key}`]=fleet[i];row[`${side}_${ship.key}_lost`]=fleet[i]-Math.round(survivors[i]);});
        for(const ship of['transports','colony_ships','starbases'])row[`${side}_${ship}`]=row[`${side}_${ship}_lost`]=0;
        row[`${side}_combat_value`]=model.cvOf(fleet);
        row[`${side}_lost_cv`]=model.cvOf(model.SHIPS.map(ship=>row[`${side}_${ship.key}_lost`]));
        row[`${side}_survived_cv`]=row[`${side}_combat_value`]-row[`${side}_lost_cv`];
    }
    db.prepare(`INSERT INTO battle_reports(${Object.keys(row).join(',')})VALUES(${Object.keys(row).map(k=>'@'+k).join(',')})`).run(row);
}
function request(server,url,role='admin',body){return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method:body?'POST':'GET',headers:{'x-role':role,...(data?{'Content-Type':'application/json'}:{})}},res=>{
        let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});
    req.on('error',reject);if(data)req.write(data);req.end();
});}
(async()=>{
    const app=express();app.use(express.json());app.use((req,res,next)=>{req.session={userId:1,role:req.headers['x-role']};next();});app.use('/hub-api',router);
    const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
    try{
        console.log('race-inference-service.test.js');
        report(901);const first=service.recompute(11);
        ok('stored reports produce both shadow distributions',first.status==='updated'&&first.estimate.attack.evidence_count===1&&first.estimate.defence.evidence_count===1,first);
        ok('server and dual-runtime constants version match',first.estimate.attack.model_version===arithmetic.modelVersion()&&modelVersion()===arithmetic.modelVersion());
        const evidence=repository.evidenceForPlayer(11);
        ok('matrices, priors and current evidence hashes are persisted',evidence.length===2&&evidence.every(row=>Array.isArray(row.loglik)&&row.window_key)&&first.estimate.attack.evidence_hash===first.estimate.defence.evidence_hash);
        const stable=service.recompute(11);
        ok('recomputation leaves an unchanged evidence hash stable',stable.estimate.attack.evidence_hash===first.estimate.attack.evidence_hash);
        ok('evidence ids stay stable so an admin review is not invalidated by background recomputation',
            JSON.stringify(repository.evidenceForPlayer(11).map(row=>row.id))===JSON.stringify(evidence.map(row=>row.id)));
        ok('shadow endpoints reject members', (await request(server,'/hub-api/admin/race','user')).status===403);
        const admin=await request(server,'/hub-api/admin/race');
        ok('admins can inspect shadow distributions and the calibration gate',admin.status===200&&admin.body.estimates.length===1&&admin.body.calibration.passed===false);
        const denied=await request(server,'/hub-api/admin/race/recompute','guest',{player_id:11});
        ok('guests cannot trigger a recompute',denied.status===403);
        const invalid=await request(server,'/hub-api/admin/race/recompute','admin',{player_id:'11'});
        ok('the recompute endpoint validates player ids',invalid.status===400);
        report(902,2,1);
        db.prepare('UPDATE battle_reports SET att_win_chance=99 WHERE id=902').run(); // invented incompatible capture
        service.recompute(11);
        const conflicts=repository.evidenceForPlayer(11).filter(row=>row.status==='conflict');
        ok('an incompatible new observation is held for admin review',conflicts.length>0&&repository.getEstimate(11).attack.withheld_reason==='unresolved_conflict',conflicts);
        const target=conflicts[0];
        const exclude=await request(server,`/hub-api/admin/race/evidence/${target.id}`,'admin',{status:'excluded'});
        ok('admins can exclude a conflict and recompute',exclude.status===200&&repository.evidenceForPlayer(11).some(row=>row.battle_report_id===target.battle_report_id&&row.kind===target.kind&&row.status==='excluded'));
        for(const row of repository.evidenceForPlayer(11).filter(row=>row.status==='conflict')){repository.setEvidenceStatus(row.id,'excluded');}
        service.recompute(11);
        ok('resolved conflicts no longer withhold the estimate',!repository.getEstimate(11).attack.withheld_reason);
        const before=db.prepare('SELECT race_attack,race_defense FROM players WHERE id=11').get();
        ok('a changed Joined date cannot calibrate an old incarnation',service.recordCalibration(11,{has_intel:1,race_attack:2,race_defense:1,joined:'2026-10-02T00:00:00Z'})===0);
        ok('bio calibration pairs capture the estimate before intel arrives',service.recordCalibration(11,{has_intel:1,race_attack:2,race_defense:1})===2);
        ok('a repeated scan does not duplicate calibration pairs',service.recordCalibration(11,{has_intel:1,race_attack:2,race_defense:1})===0);
        ok('one scouted player does not unlock production estimates',service.getCalibrationSummary().players===1&&!service.getCalibrationSummary().passed);
        ok('the raw posterior set is stored separately from the conservative display bounds',
            repository.calibrationRows(modelVersion()).every(row=>Array.isArray(row.raw_credible_values)&&row.raw_credible_values.length>0));
        const after=db.prepare('SELECT race_attack,race_defense FROM players WHERE id=11').get();
        ok('nothing writes inferred values to players race intel',JSON.stringify(before)===JSON.stringify(after));
        db.prepare('UPDATE players SET has_intel=1 WHERE id=11').run();
        ok('bio locks and clears shadow estimates',service.recompute(11).status==='bio_locked'&&!repository.getEstimate(11).attack);
        ok('bio truth is never overwritten on subsequent scans',service.recordCalibration(11,{has_intel:1,race_attack:-4,race_defense:-4})===0);
        ok('unknown players do not create empty persistent guesses',service.recompute(999).status==='not_found');

        // Invented later-bio pairs test the gate itself, not live model quality.
        db.prepare('DELETE FROM race_estimate_calibrations').run();
        const probabilities=[0,0,0,0,0,0,0.9,0.1,0];
        const pair=db.prepare(`INSERT INTO race_estimate_calibrations(player_id,trait,dist,band,truth,model_version,raw_credible_values)
            VALUES(?,'attack',?,'high',?,?,'[2]')`);
        for(let i=0;i<30;i++)pair.run(1000+i,JSON.stringify(probabilities),i<27?2:3,modelVersion());
        const certified=service.getCalibrationSummary();
        ok('30 unique bio pairs with90% posterior coverage and calibrated high picks pass',
            certified.passed&&certified.players===30&&certified.coverage_pairs===30&&certified.credible_coverage===0.9,certified);
        db.prepare("UPDATE race_estimate_calibrations SET dist='[0,0,0,0,0,0,1,0,0]',truth=2").run();
        const conservative=service.getCalibrationSummary();
        ok('100% conservative coverage does not certify the requested88–92% posterior calibration',
            !conservative.passed&&conservative.high_accuracy===1&&conservative.calibration_error_pp===0&&conservative.credible_coverage===1,conservative);
        db.prepare('UPDATE race_estimate_calibrations SET raw_credible_values=NULL WHERE player_id=1000').run();
        ok('legacy pairs without a recorded raw set keep the coverage gate closed',
            !service.getCalibrationSummary().passed&&service.getCalibrationSummary().coverage_pairs===29);
    }finally{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(temp,{recursive:true,force:true});}
    process.exitCode=failed?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
