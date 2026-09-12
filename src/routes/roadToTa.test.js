// Synthetic DB + actual HTTP route: Road to TA must not invent planning certainty from
// schema defaults, parse missing observations as zero, or count uncompleted proposals.
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-road-to-ta-only';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const repository = require('../repositories/roadToTa');
const router = require('./roadToTa');
let pass = 0, fail = 0;
function ok(name, condition, detail) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}
const app = express();
app.use((req, res, next) => {
    req.session = req.headers['x-test-auth'] === 'none' ? {} : {
        userId: 1, role: req.headers['x-test-role'] || 'user',
        gameName: req.headers['x-test-player'] || 'sYnThEtIc MeMbEr',
    };
    next();
});
app.use('/hub-api', router);

db.prepare(`INSERT INTO players (id,name,level,total_planets,has_intel,astro_dollars,production_points,production_rate,
    science_rate,culture_rate,stats_scraped_at,updated_at,artefact,trade_partners)
    VALUES (1,'Synthetic Member',12,5,0,99999,99999,99999,99999,99999,'2026-09-12 08:00:00','2026-09-12 09:00:00','CD 3',?)`)
    .run(JSON.stringify([4, '4', 'Synthetic Partner', 'synthetic partner', 'Unknown Partner', 'unknown partner', 1, 'Synthetic Member']));
db.prepare(`INSERT INTO players (id,name,level,total_planets,has_intel,social,race_growth,race_production,race_science,
    race_trader,trade_revenue,artefact,intel_updated_at,stats_scraped_at)
    VALUES (2,'Synthetic Bio',9,2,1,6,0,2,-1,1,25,'CD 2','2026-09-11T19:00:00+02:00','2026-09-11 17:00:00')`).run();
db.prepare("INSERT INTO players (id,name) VALUES (3,'Synthetic Outside'),(4,'Synthetic Partner'),(5,'Synthetic Default')").run();
db.prepare(`INSERT INTO alliance_member_stats (player_id,planets_text,level_text,astro_dollars,production_points,
    production_rate,science_rate,culture_rate,artefact,updated_at,sciences_updated_at)
    VALUES (1,'5 (6)','Lvl 12','1 234,5','2,000.25','12,5 /h','0','',null,'2026-09-10 10:00:00','2026-09-10 09:00:00')`).run();
db.prepare('INSERT INTO alliance_member_stats (player_id) VALUES (2),(5)').run();
db.prepare("INSERT INTO systems (id,name) VALUES (900,'Synthetic System')").run();
db.prepare(`INSERT INTO planets (game_planet_id,system_id,planet_index,name,owner_id,population,is_sieged,updated_at)
    VALUES (901,900,1,'Synthetic Planet',1,17,1,'2026-09-09 06:00:00'),
           (902,900,2,'Synthetic Neighbor',3,21,0,'2026-09-12 06:00:00')`).run();

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/hub-api/road-to-ta`;
    async function get(query = '', headers = {}) {
        const response = await fetch(base + query, { headers });
        return { status: response.status, body: await response.json() };
    }
    try {
        let result = await get('', { 'x-test-auth': 'none' });
        ok('unauthenticated requests cannot inspect alliance snapshots', result.status === 401);
        result = await get();
        const { player, planets, market } = result.body;
        ok('default selection matches the linked account case-insensitively', result.status === 200
            && result.body.me.id === 1 && player.id === 1 && result.body.players.length === 3);
        ok('selector contains recorded members, excluding unrelated players',
            result.body.players.map(member => member.id).sort().join(',') === '1,2,5');
        ok('observed economic decimals survive localization and per-hour suffixes',
            player.astro_dollars === 1234.5 && player.production_points === 2000.25 && player.production_rate === 12.5, player);
        ok('recorded zero remains distinct from missing economic input', player.science_rate === 0 && player.culture_rate === null);
        ok('default race/social/trade fields are never asserted without bio',
            ['social', 'race_growth', 'race_production', 'race_science', 'race_trader', 'trade_revenue', 'artefact']
                .every(field => player[field] === null) && player.has_intel === false);
        ok('completed partners are deduplicated across known IDs/names and exclude self',
            JSON.stringify(player.trade_partners) === JSON.stringify([4, 'Unknown Partner']), player.trade_partners);
        ok('only owned planets are exposed with their own observation timestamps',
            planets.length === 1 && planets[0].id === 901 && planets[0].system_name === 'Synthetic System'
            && planets[0].updated_at === '2026-09-09 06:00:00' && planets[0].is_sieged === true);
        ok('unobserved per-planet planning inputs stay explicitly unknown',
            ['farm', 'factory', 'lab', 'cybernetics', 'local_pp', 'growth_progress'].every(field => planets[0][field] === null));
        ok('incomplete planet coverage is explicit rather than a complete empire assumption',
            player.total_planets === 5 && player.known_planet_count === 1 && player.missing_planet_count === 4
            && player.planet_count_matches === false);
        ok('source timestamps stay independent and preserve stored timezone representation',
            player.updated_at === '2026-09-12 09:00:00' && player.stats_scraped_at === '2026-09-12 08:00:00'
            && player.sheet_updated_at === '2026-09-10 10:00:00' && player.sheet_sciences_updated_at === '2026-09-10 09:00:00');
        ok('economic source indicates observed sheet fields only', player.economy_sources.astro_dollars === 'alliance_member_stats'
            && player.economy_sources.culture_rate === null);
        ok('absent market quote remains unknown', market.pp_price === null && market.updated_at === null);

        result = await get('?player_id=2', { 'x-test-role': 'guest' });
        ok('authenticated read-only members may select recorded alliance players', result.status === 200 && result.body.player.id === 2);
        ok('confirmed neutral race, science and artifact remain usable observations',
            result.body.player.race_growth === 0 && result.body.player.social === 6
            && result.body.player.artefact === 'CD 2' && result.body.player.artefact_source === 'bio_intel'
            && result.body.player.intel_updated_at === '2026-09-11T19:00:00+02:00');
        ok('a profile Statistics timestamp does not make unobserved economic defaults real',
            result.body.player.astro_dollars === null && result.body.player.production_points === null
            && result.body.player.production_rate === null && result.body.player.trade_partners === null);
        result = await get('?player_id=5');
        ok('missing level and empire totals are unknown, not initial schema zeroes',
            result.body.player.level === null && result.body.player.total_planets === null
            && result.body.player.missing_planet_count === null);

        result = await get('', { 'x-test-player': 'Unlinked Account' });
        ok('unlinked account still receives the selector without a guessed player',
            result.status === 200 && result.body.me === null && result.body.player === null
            && result.body.players.length === 3 && result.body.planets.length === 0);
        for (const value of ['0', '-1', '1.5', 'abc', '', '9007199254740992', '1&player_id=2', '1%20OR%201=1']) {
            result = await get('?player_id=' + value);
            ok(`invalid player selector is rejected: ${value || '(empty)'}`, result.status === 400);
        }
        for (const id of [3, 999]) {
            result = await get('?player_id=' + id);
            ok('non-member and absent IDs return a clear 404', result.status === 404);
        }

        db.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('pp_price','0.125','2026-09-08 04:00:00')").run();
        ok('machine-serialized market fractions and their actual quote timestamp survive', repository.getMarket().pp_price === 0.125
            && repository.getMarket().updated_at === '2026-09-08 04:00:00');
        for (const bad of ['N/A', '-1', '0', '1.2.3', '1,25']) {
            db.prepare("UPDATE app_settings SET value=? WHERE key='pp_price'").run(bad);
            ok('invalid market prices cannot become a planning conversion rate', repository.getMarket().pp_price === null);
        }
        db.prepare("UPDATE alliance_member_stats SET artefact='CD 1', production_rate='garbage 100', astro_dollars=null WHERE player_id=1").run();
        const changed = repository.getPlayerSnapshot(1).player;
        ok('malformed/missing sheet values never fall back to fake profile wealth',
            changed.production_rate === null && changed.astro_dollars === null);
        ok('observed member-sheet artifact has its own source, independent of bio',
            changed.artefact === 'CD 1' && changed.artefact_source === 'alliance_member_stats' && !changed.has_intel);
        for (const raw of [null, '', '{}', '[4,null]', '[0]', 'invalid']) {
            db.prepare('UPDATE players SET trade_partners=? WHERE id=1').run(raw);
            ok('unusable partner observations do not imply zero completed agreements', repository.getPlayerSnapshot(1).player.trade_partners === null);
        }
        db.prepare("UPDATE players SET trade_partners='[]' WHERE id=1").run();
        ok('an explicitly reported empty partner list is a known zero', repository.getPlayerSnapshot(1).player.trade_partners.length === 0);
        db.prepare(`INSERT INTO trade_agreements (pair_key,player_a,player_b,status,initiator)
            VALUES ('synthetic member|synthetic partner','Synthetic Member','Synthetic Partner','proposed','Synthetic Member')`).run();
        ok('a proposed board agreement is not a completed reported TA', repository.getPlayerSnapshot(1).player.trade_partners.length === 0);
        db.prepare("UPDATE trade_agreements SET status='confirmed'").run();
        ok('a confirmed board intention is not a completed reported TA', repository.getPlayerSnapshot(1).player.trade_partners.length === 0);

        const before = db.prepare('SELECT total_changes() AS count').get().count;
        await get(); await get('?player_id=2');
        ok('snapshot reads never mutate any database state', db.prepare('SELECT total_changes() AS count').get().count === before);
        const post = await fetch(base, { method: 'POST' });
        ok('no write endpoint exists for planning inputs', post.status === 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
    console.log(`${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
