// The legacy board must share actual currency precision and completed TA capacity
// with Road to TA, without mutating coordination statuses while reading snapshots.
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-trade-compat-only';
delete process.env.DISCORD_TOKEN;
const express = require('express');
const db = require('../database');
const trade = require('../repositories/trade');
const router = require('./trade');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`); }
}
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    req.session = { userId: 1, gameName: req.headers['x-player'] || 'Alpha', role: 'admin' };
    next();
});
app.use('/hub-api', router);
for (const [id, name] of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'].entries()) {
    db.prepare('INSERT INTO players (id,name,trade_partners) VALUES (?,?,?)').run(id + 1, name, '[]');
    db.prepare('INSERT INTO alliance_member_stats (player_id) VALUES (?)').run(id + 1);
}
db.prepare("UPDATE alliance_member_stats SET astro_dollars='19999.6', production_points='0', production_rate='1', hoarded_au=99.6 WHERE player_id=1").run();
db.prepare("UPDATE alliance_member_stats SET astro_dollars=NULL, production_points='1', production_rate='N/A' WHERE player_id=2").run();
db.prepare("UPDATE alliance_member_stats SET astro_dollars='0', production_points='2.5', production_rate='1.5 /h' WHERE player_id=3").run();
db.prepare("UPDATE players SET has_intel=0,race_trader=1 WHERE id=2").run();
db.prepare("UPDATE players SET has_intel=1,race_trader=1 WHERE id=3").run();
db.prepare("INSERT INTO app_settings (key,value) VALUES ('pp_price','0.4')").run();
const setPartners = value => db.prepare('UPDATE players SET trade_partners=? WHERE id=1').run(value);

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/hub-api`;
    async function request(path, body, headers = {}) {
        const response = await fetch(base + path, {
            method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
    }
    try {
        let response = await request('/trade-agreements');
        let alpha = response.body.members.find(p => p.name === 'Alpha');
        const beta = response.body.members.find(p => p.name === 'Beta');
        const gamma = response.body.members.find(p => p.name === 'Gamma');
        ok('19999.6 A$ is not rounded into a funded 20000 A$ fee', alpha.visible_au === 19999.6 && alpha.visible_au < 20000, alpha);
        ok('1 PP/h sold at 0.4 retains 0.4 A$/h income', alpha.au_per_h === 0.4);
        ok('hoard estimates preserve source decimals', alpha.hoarded_au === 99.6);
        ok('missing observations remain null rather than zero', beta.visible_au === null && beta.au_per_h === null, beta);
        ok('PP balances and /h rates retain their decimal precision', gamma.visible_au === 1 && Math.abs(gamma.au_per_h - 0.6) < 1e-12, gamma);
        ok('Trader flags still require bio confirmation', beta.isTrader === false && gamma.isTrader === true);

        setPartners(JSON.stringify([2, '2', ' BeTa ', 'beta', 1, 'ALPHA', 'Outside Partner']));
        response = await request('/trade-agreements');
        alpha = response.body.members.find(p => p.name === 'Alpha');
        ok('reported IDs/names resolve to canonical lowercase names, deduplicate and exclude self', JSON.stringify(alpha.reported_partners) === '["beta","outside partner"]', alpha.reported_partners);
        ok('reading reported completions never creates or changes board statuses', trade.getActiveAgreements().length === 0);
        response = await request('/trade-agreements/propose', { partner: 'Beta' });
        ok('an observed completed pair cannot be proposed again', response.status === 400 && response.body.error.includes('already exists'), response);
        response = await request('/trade-agreements/propose', { partner: 'Alpha' }, { 'x-player': 'Beta' });
        ok('the counterpart observation also prevents a duplicate when proposer reports none', response.status === 400 && response.body.error.includes('already exists'));

        setPartners(JSON.stringify([2,3,4,5,6]));
        response = await request('/trade-agreements/propose', { partner: 'Golf' });
        ok('five reported completed partners block a sixth proposal without a board sync', response.status === 400 && response.body.error.includes('5 agreements'), response);
        response = await request('/admin/trade-agreements', { player_a: 'Alpha', player_b: 'Golf' });
        ok('admin pairing obeys the same observed capacity', response.status === 400);

        setPartners(JSON.stringify([2,3,4,5]));
        trade.forceSetAgreement('alpha|beta', 'Alpha', 'Beta');
        response = await request('/trade-agreements/propose', { partner: 'Golf' });
        ok('a reported partner also present on the board consumes one slot, not two', response.status === 200, response);
        response = await request('/trade-agreements/propose', { partner: 'Hotel' });
        ok('reported completions plus a different active reservation reach the cap', response.status === 400 && response.body.error.includes('5 agreements'));
        ok('compatibility reads leave the original confirmed board state intact', trade.getAgreementStatusByPairKey('alpha|beta').status === 'confirmed');
        trade.deleteAllTradeAgreements();

        setPartners(null);
        db.prepare("UPDATE players SET trade_partners='[\"Alpha\"]' WHERE id BETWEEN 2 AND 6").run();
        response = await request('/trade-agreements');
        alpha = response.body.members.find(p => p.name === 'Alpha');
        ok('reverse observations retain unknown direct completeness while exposing five known partners',
            alpha.reported_partners === null && JSON.stringify(alpha.known_partners) === '["beta","gamma","delta","echo","foxtrot"]', alpha);
        response = await request('/trade-agreements/propose', { partner: 'Golf' });
        ok('five counterpart observations block a sixth partner when own report is missing',
            response.status === 400 && response.body.error.includes('5 agreements'), response);
        setPartners('[2,2,"Beta"]');
        response = await request('/trade-agreements');
        alpha = response.body.members.find(p => p.name === 'Alpha');
        ok('direct and reverse observations of one pair consume the same slot', alpha.known_partners.length === 5);
        ok('reverse observations do not create coordination-board rows', trade.getActiveAgreements().length === 0);
        db.prepare("UPDATE players SET trade_partners='[]' WHERE id BETWEEN 2 AND 6").run();

        setPartners('["Beta",null]');
        response = await request('/trade-agreements');
        alpha = response.body.members.find(p => p.name === 'Alpha');
        ok('partial lists preserve valid known pairs without claiming complete observations',
            alpha.reported_partners === null && JSON.stringify(alpha.known_partners) === '["beta"]', alpha);
        response = await request('/trade-agreements/propose', { partner: 'Beta' });
        ok('a valid pair in an otherwise partial list still blocks duplicates', response.status === 400 && response.body.error.includes('already exists'));
        response = await request('/trade-agreements');
        ok('partial valid pairs also establish a reverse known edge',
            JSON.stringify(response.body.members.find(p => p.name === 'Beta').known_partners) === '["alpha"]');

        for (const raw of [null, '', 'bad json', '{}', '[null]', '[9999]', '[true]']) {
            setPartners(raw);
            response = await request('/trade-agreements');
            ok('missing/malformed/unresolvable observations remain unknown', response.body.members.find(p => p.name === 'Alpha').reported_partners === null, raw);
        }
        response = await request('/trade-agreements/propose', { partner: 'Beta' });
        ok('unknown legacy snapshots keep existing board proposal behavior', response.status === 200);
        setPartners('[]');
        ok('an explicitly observed empty list is known zero', trade.getReportedPartnerNames('Alpha').length === 0);

        db.prepare("UPDATE app_settings SET value='0.125' WHERE key='pp_price'").run();
        response = await request('/trade-agreements');
        ok('machine-formatted three-decimal market prices are fractions, not grouping', response.body.members.find(p => p.name === 'Alpha').au_per_h === 0.125);

        db.prepare("DELETE FROM app_settings WHERE key='pp_price'").run();
        response = await request('/trade-agreements');
        alpha = response.body.members.find(p => p.name === 'Alpha');
        ok('missing price preserves known cash-only liquidity, but not an invented income', alpha.visible_au === 19999.6 && alpha.au_per_h === null, alpha);
        ok('missing price cannot value a nonzero PP balance', response.body.members.find(p => p.name === 'Gamma').visible_au === null);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
