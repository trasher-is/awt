// Synthetic SQLite observations exercised through the authenticated HTTP endpoint.
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-trade-analysis-only';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const router = require('../routes/intel');
const model = require('../../public/js/utils/trade-schedule-model');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const app = express();
app.use((req, res, next) => {
    req.session = req.headers['x-test-auth'] === 'none' ? {} : { userId:1, role:'user' };
    next();
});
app.use('/hub-api', router);
db.prepare('INSERT INTO players (id,name,trade_partners) VALUES (1,?,?),(2,?,?),(3,?,?)')
    .run('Synthetic Decimal',JSON.stringify([2,'2','Synthetic Zero']), 'Synthetic Zero','[]', 'Synthetic Unknown',null);
db.prepare(`INSERT INTO alliance_member_stats (player_id,production_rate,astro_dollars,production_points)
    VALUES (1,'12,5 /h','1 234,5','2,000.25'),(2,'0','0','0'),(3,null,'garbage 100','')`).run();

(async () => {
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${server.address().port}/hub-api/intel/trade-analysis`;
    async function get(headers={}) {
        const response=await fetch(url,{headers});
        return {status:response.status,body:await response.json()};
    }
    try {
        const denied=await get({'x-test-auth':'none'});
        ok('alliance economic observations require authentication',denied.status===401);
        let response=await get();
        ok('recorded alliance members are available through the existing endpoint',response.status===200&&response.body.success&&response.body.players.length===3);
        const decimal=response.body.players.find(player=>player.id===1);
        const zero=response.body.players.find(player=>player.id===2);
        const unknown=response.body.players.find(player=>player.id===3);
        ok('localized decimal balances and hourly rates retain fractional precision',decimal.production_rate===12.5&&decimal.astro_dollars===1234.5&&decimal.production_points===2000.25,decimal);
        ok('known zero economic observations remain distinct from missing input',zero.production_rate===0&&zero.astro_dollars===0&&zero.production_points===0);
        ok('missing and malformed economics stay null instead of invented zero balances',unknown.production_rate===null&&unknown.astro_dollars===null&&unknown.production_points===null);
        ok('known empty completed partners remain distinct from unavailable reports',zero.trade_partners.length===0&&unknown.trade_partners===null);
        ok('reported numeric partner IDs and names resolve once to the Board’s canonical partner',JSON.stringify(decimal.trade_partners)==='["synthetic zero"]');
        ok('missing market price and timestamp remain explicitly unknown',response.body.pp_price===null&&response.body.pp_price_updated_at===null);
        db.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('pp_price','0.125','2026-09-12 04:00:00')").run();
        response=await get();
        ok('API-synchronized price is parsed as a machine fraction with its real quote timestamp',response.body.pp_price===0.125&&response.body.pp_price_updated_at==='2026-09-12 04:00:00');
        const completed=model.plan(response.body.players,response.body.pp_price,{pairs:[['Synthetic Decimal','Synthetic Zero']]});
        ok('endpoint IDs let the schedule identify an already completed board pair',completed.schedule.length===0&&completed.unresolved[0].reason.includes('already present'));
        db.prepare("UPDATE players SET trade_partners='[2,null]' WHERE id=1").run();
        response=await get();
        const partial=response.body.players.find(p=>p.id===1);
        const partialPlan=model.plan(response.body.players,response.body.pp_price,{pairs:[['Synthetic Decimal','Synthetic Zero']]});
        ok('partial partner observations preserve known completed pairs without claiming full slot coverage',partial.trade_partners===null&&partial.known_partners.includes('synthetic zero')&&partialPlan.schedule.length===0&&partialPlan.unresolved[0].reason.includes('already present'));
        db.prepare("INSERT INTO players (id,name) VALUES (99,'Synthetic Outside')").run();
        db.prepare('UPDATE players SET trade_partners=? WHERE id=1').run(JSON.stringify([99,'99','Synthetic Outside','v','w','x']));
        response=await get();
        ok('aliases for completed partners outside the member roster count once',response.body.players.find(p=>p.id===1).trade_partners.length===4);
        for (const invalid of ['N/A','0','-1','1.25 junk','1,25','1e999']) {
            db.prepare("UPDATE app_settings SET value=? WHERE key='pp_price'").run(invalid);
            ok(`invalid observed market quote cannot become a conversion rate: ${invalid}`,(await get()).body.pp_price===null);
        }
        for (const invalid of ['{}','[null]','[0]','[{}]','["0"]','invalid']) {
            db.prepare('UPDATE players SET trade_partners=? WHERE id=1').run(invalid);
            ok('an unusable partner report is not an asserted zero completed count',(await get()).body.players.find(p=>p.id===1).trade_partners===null);
        }
        db.prepare("UPDATE app_settings SET value='0.5' WHERE key='pp_price'").run();
        db.prepare("UPDATE players SET trade_partners='[]'").run();
        db.prepare("UPDATE alliance_member_stats SET production_rate='25,5 /h',astro_dollars='5 000',production_points='2 000' WHERE player_id=1").run();
        db.prepare("UPDATE alliance_member_stats SET astro_dollars='20 000' WHERE player_id=2").run();
        response=await get();
        const planned=model.plan(response.body.players,response.body.pp_price,{pairs:[['Synthetic Decimal','Synthetic Zero']]});
        ok('end-to-end funding converts both saved PP and fractional future production to A$',Math.abs(planned.schedule[0].time-14000/12.75)<1e-6,planned);
        const changes=db.prepare('SELECT total_changes() AS n').get().n;
        await get();
        ok('trade-analysis reads do not modify stored observations',db.prepare('SELECT total_changes() AS n').get().n===changes);
    } finally {
        await new Promise(resolve=>server.close(resolve));
        db.close();
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode=fail?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
