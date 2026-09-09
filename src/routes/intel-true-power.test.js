// Regression coverage for #161: exercise stored observations through the real HTTP route.
const http = require('http');
process.env.AWT_DB_PATH = ':memory:';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-review-only';
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const alliances = require('../repositories/alliances');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) console.log(`  ok - ${desc}`);
    else { failed++; console.error(`  NOT OK - ${desc}: ${JSON.stringify(detail)}`); }
}

const app = express();
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', intelRouter);

function getStats(server) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/hub-api/intel/alliance-stats' }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(raw);
                    if (res.statusCode !== 200 || !result.success) throw new Error(raw);
                    resolve(result);
                } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

function syncSheet(playerId, physics) {
    alliances.upsertAllianceMemberStats(playerId, '1 / 1', null, '10', '10', '10', '100', '100', 'None', '10', '100', 10, 10, 10, physics, 10);
}

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        console.log('intel-true-power.test.js');
        db.prepare(`INSERT INTO players (id, name, has_intel, race_attack, physics, mathematics, science_level, level, intel_updated_at)
                    VALUES (1, 'Synthetic Member', 1, 4, 10, 10, 30, 10, datetime('now'))`).run();
        // A legacy/partial sheet row supplies the member identity, but no science observation.
        db.prepare('INSERT INTO alliance_member_stats (player_id) VALUES (1)').run();
        const before = await getStats(server);
        db.prepare(`UPDATE players SET intel_updated_at = datetime('now', '-25 hours') WHERE id = 1`).run();
        const after = await getStats(server);
        ok('aging intel alone keeps the +4 member at the recorded ceiling at TPx 50%, never 100%',
            before.stats[0].pl_tpx === 50 && after.stats[0].pl_tpx === 50,
            { before: before.stats[0].pl_tpx, after: after.stats[0].pl_tpx });

        db.prepare(`UPDATE players SET physics = 6, science_level = 12, intel_updated_at = datetime('now', '-2 hours') WHERE id = 1`).run();
        db.prepare(`INSERT INTO players (id, name, has_intel, race_attack, physics, mathematics, science_level, level, intel_updated_at)
                    VALUES (2, 'Synthetic Opponent', 1, 4, 12, 10, 12, 10, datetime('now'))`).run();
        syncSheet(1, 12);
        let result = await getStats(server);
        ok('newer member-sheet Phy 12 replaces old intel Phy 6: TPx is 50%, not 5.5%',
            result.stats[0].physics === 12 && result.stats[0].pl_tpx === 50,
            { physics: result.stats[0].physics, tpx: result.stats[0].pl_tpx });

        syncSheet(1, 18);
        result = await getStats(server);
        ok('the same newer sheet observation also raises the global reference, keeping TPx at 50%',
            result.ceilings.max_physics === 18 && result.stats[0].pl_tpx === 50,
            { ceilings: result.ceilings, tpx: result.stats[0].pl_tpx });

        db.prepare(`UPDATE players SET intel_updated_at = '2026-09-08T12:00:00Z' WHERE id = 1`).run();
        db.prepare(`UPDATE alliance_member_stats SET physics = 30, sciences_updated_at = '2026-09-08 11:00:00' WHERE player_id = 1`).run();
        result = await getStats(server);
        ok('an older sheet cannot replace newer intel or inflate the reference',
            result.stats[0].pl_tpx === 5.5 && result.ceilings.max_physics === 12, result);

        alliances.upsertHoardedAu(1, 25000);
        result = await getStats(server);
        ok('a subsequent AU refresh cannot promote old sheet physics over newer intel',
            result.stats[0].pl_tpx === 5.5 && result.ceilings.max_physics === 12, result);

        for (const stamp of [null, 'not-a-timestamp']) {
            db.prepare('UPDATE alliance_member_stats SET sciences_updated_at = ? WHERE player_id = 1').run(stamp);
            result = await getStats(server);
            ok(`a legacy/invalid science timestamp (${stamp}) cannot override recorded physics`,
                result.stats[0].pl_tpx === 5.5 && result.ceilings.max_physics === 12, result);
        }

        db.prepare(`UPDATE players SET intel_updated_at = '2026-09-08T14:00:00+02:00' WHERE id = 1`).run();
        db.prepare(`UPDATE alliance_member_stats SET physics = 12, sciences_updated_at = '2026-09-08 12:30:00' WHERE player_id = 1`).run();
        result = await getStats(server);
        ok('SQLite UTC and offset ISO timestamps compare by instant, independent of server timezone',
            result.stats[0].pl_tpx === 50, result);

        for (const physics of [null, -1, 'broken']) {
            db.prepare('UPDATE alliance_member_stats SET physics = ? WHERE player_id = 1').run(physics);
            result = await getStats(server);
            ok(`invalid sheet physics (${physics}) cannot win solely by timestamp`,
                result.stats[0].pl_tpx === 5.5 && result.ceilings.max_physics === 12, result);
        }

        alliances.upsertAllianceMemberStats(1, '1 / 1', null, '10', '10', '10', '100', '100', 'None', '10', '100', 10, 10, null, 12, 10);
        result = await getStats(server);
        ok('a partial sheet with valid physics and no maths still supplies the TPx observation',
            result.stats[0].pl_tpx === 50, result);

        db.prepare(`INSERT INTO players (id, name, has_intel, physics) VALUES (3, 'Synthetic Unscouted Race', 0, 99)`).run();
        syncSheet(3, 24);
        result = await getStats(server);
        ok('another member\'s observed sheet raises the reference even when their race is unknown',
            result.ceilings.max_physics === 24 && result.stats.find(r => r.player_id === 1).pl_tpx < 50, result);
        ok('an observed science alone does not invent a race rating',
            result.stats.find(r => r.player_id === 3).pl_tpx === null, result);
    } catch (err) {
        failed++;
        console.error(err);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
    console.log(`intel-true-power.test.js: ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();
