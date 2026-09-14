// Route-level coverage for GET /hub-api/intel/target-dossier — the fleet-launch-form
// injection's data source (public/js/core/page-injections.js's
// initFleetLaunchTargetDossier). Everything the hub knows about ONE destination planet:
// owner/pop/starbase/siege/best-guarded, who has a fleet there right now (ours flagged
// separately), and any recent battle at that planet.
//
// Run with: node src/routes/intel-target-dossier.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-target-dossier-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-target-dossier.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', intelRouter);

function getJson(server, urlPath) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        }).on('error', reject);
    });
}

(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        console.log('\n── missing/invalid query params ' + '─'.repeat(43));
        let r = await getJson(server, '/hub-api/intel/target-dossier');
        ok('no params -> 400', r.status === 400, r);
        r = await getJson(server, '/hub-api/intel/target-dossier?systemId=41&planetIndex=13');
        ok('planetIndex out of 1-12 range -> 400', r.status === 400, r);
        r = await getJson(server, '/hub-api/intel/target-dossier?systemId=abc&planetIndex=7');
        ok('non-numeric systemId -> 400', r.status === 400, r);

        console.log('\n── a system never indexed at all ' + '─'.repeat(42));
        r = await getJson(server, '/hub-api/intel/target-dossier?systemId=999999&planetIndex=1');
        ok('request still succeeds', r.status === 200, r);
        ok('system is null, not an error', r.body.system === null, r.body);
        ok('planet is null too', r.body.planet === null, r.body);
        ok('fleets is an empty array', Array.isArray(r.body.fleets) && r.body.fleets.length === 0, r.body);
        ok('recentBattles is an empty array', Array.isArray(r.body.recentBattles) && r.body.recentBattles.length === 0, r.body);

        console.log('\n── a real target: enemy-held, sieged, guarded, with a RAID fleet inbound ' + '─'.repeat(5));
        db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (1, 'RAID Alliance', 'RAID')`).run();
        db.prepare(`INSERT INTO alliances (id, name, tag) VALUES (2, 'Enemy Alliance', 'ENEMY')`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (10, 'caveman', 1)`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (11, 'Moardin25', 1)`).run();
        db.prepare(`INSERT INTO players (id, name, alliance_id) VALUES (12, 'EnemyGuy', 2)`).run();
        // Marks RAID as "our own alliance" for ownAllianceTags().
        db.prepare(`INSERT INTO alliance_member_stats (player_id) VALUES (10)`).run();

        db.prepare(`INSERT INTO systems (id, name, full_name, x, y, observed_at) VALUES (41, 'Phact', NULL, -3, 9, '2026-09-14 20:00:00')`).run();
        db.prepare(`
            INSERT INTO planets (game_planet_id, system_id, planet_index, owner_id, population, starbase, is_sieged, siege_is_friendly)
            VALUES (999, 41, 7, 12, 8, 3, 1, 0)
        `).run();
        db.prepare(`INSERT INTO best_guarded (game_planet_id, cv, updated_at) VALUES (999, 5000, '2026-09-14')`).run();

        db.prepare(`
            INSERT INTO fleets (owner_id, system_id, planet_index, destroyers, arrival_at, arrival_time)
            VALUES (11, 41, 7, 60, '2026-09-14T22:00:00Z', '2h 00m')
        `).run();
        // A decoy fleet at a DIFFERENT planet in the same system — must not leak in.
        db.prepare(`
            INSERT INTO fleets (owner_id, system_id, planet_index, destroyers)
            VALUES (12, 41, 3, 20)
        `).run();

        db.prepare(`
            INSERT INTO battle_reports (started_at, system_id, planet_index, winner, killed_population,
                att_player_name, att_alliance_tag, def_player_name, def_alliance_tag)
            VALUES (datetime('now', '-1 hour'), 41, 7, 'Attacker', 5, 'Moardin25', 'RAID', 'EnemyGuy', 'ENEMY')
        `).run();
        // A battle too old to count (outside the 3-day window) — must not leak in.
        db.prepare(`
            INSERT INTO battle_reports (started_at, system_id, planet_index, winner, att_player_name, def_player_name)
            VALUES (datetime('now', '-10 days'), 41, 7, 'Attacker', 'Someone', 'EnemyGuy')
        `).run();

        r = await getJson(server, '/hub-api/intel/target-dossier?systemId=41&planetIndex=7');
        ok('200', r.status === 200, r);
        ok('system name resolved', r.body.system.name === 'Phact', r.body.system);

        const p = r.body.planet;
        ok('planet found', !!p, r.body);
        ok('owner + alliance resolved', p.owner_name === 'EnemyGuy' && p.alliance_tag === 'ENEMY', p);
        ok('population/starbase carried through', p.population === 8 && p.starbase === 3, p);
        ok('siege flagged as hostile', p.is_sieged === 1 && p.siege_is_friendly === 0, p);
        // best_guarded.cv is stored TEXT (see systems.js's insertBestGuarded) — not this
        // route's concern to coerce, same as every other reader of the column.
        ok('best-guarded CV joined in', p.guard_cv === '5000', p);

        ok('exactly one fleet — the decoy at #3 is excluded', r.body.fleets.length === 1, r.body.fleets);
        const f = r.body.fleets[0];
        ok('the RAID fleet is flagged as our own alliance', f.owner_name === 'Moardin25' && f.is_own_alliance === true, f);

        ok('exactly one recent battle — the 10-day-old one is excluded', r.body.recentBattles.length === 1, r.body.recentBattles);
        ok('recent battle carries the right names', r.body.recentBattles[0].att_player_name === 'Moardin25'
            && r.body.recentBattles[0].def_player_name === 'EnemyGuy', r.body.recentBattles[0]);

        console.log('\n── an enemy fleet is NOT flagged as our own ' + '─'.repeat(33));
        db.prepare(`DELETE FROM fleets`).run();
        db.prepare(`INSERT INTO fleets (owner_id, system_id, planet_index, destroyers) VALUES (12, 41, 7, 20)`).run();
        r = await getJson(server, '/hub-api/intel/target-dossier?systemId=41&planetIndex=7');
        ok('enemy fleet present but not marked as ours', r.body.fleets.length === 1 && r.body.fleets[0].is_own_alliance === false, r.body.fleets);

        console.log('\n── a battle elsewhere in the same system is still context, but ranked behind the exact planet ' + '─'.repeat(1));
        db.prepare(`
            INSERT INTO battle_reports (started_at, system_id, planet_index, winner, att_player_name, def_player_name)
            VALUES (datetime('now', '-30 minutes'), 41, 3, 'Attacker', 'SomeoneElse', 'EnemyGuy')
        `).run();
        r = await getJson(server, '/hub-api/intel/target-dossier?systemId=41&planetIndex=7');
        ok('both the exact-planet and same-system battles come back', r.body.recentBattles.length === 2, r.body.recentBattles);
        ok('the exact-planet battle (#7) is ranked first even though the #3 one is more recent',
            r.body.recentBattles[0].planet_index === 7 && r.body.recentBattles[1].planet_index === 3, r.body.recentBattles);
    } finally {
        server.close();
    }

    db.close();
    try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch (err) { /* best effort */ }

    console.log('\n' + '─'.repeat(75));
    if (failed > 0) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
    console.log('All checks passed');
})().catch(e => { console.error('THREW:', e); process.exit(1); });
