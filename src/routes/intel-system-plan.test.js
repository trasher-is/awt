// GET /hub-api/intel/system-plan/:systemId — the read path page-injections.js's
// initSystemPlan() polls. Write happens only through the !splan Discord command (there is
// no web write route, since admin-checking already lives in discord_bot.js), so this file
// covers the read side and the feature toggle.
//
// Run with: node src/routes/intel-system-plan.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awt-intel-system-plan-test-')), 'test.db');
process.env.AWT_DB_PATH = tmpDb;
delete process.env.DISCORD_TOKEN;

const express = require('express');
const db = require('../database');
const settingsRepo = require('../repositories/settings');
const systemPlansRepo = require('../repositories/systemPlans');
const intelRouter = require('./intel');

let failed = 0;
function ok(desc, cond, detail) {
    if (cond) { console.log(`  ok - ${desc}`); }
    else { failed++; console.error(`  NOT OK - ${desc}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

console.log('intel-system-plan.test.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, gameName: 'caveman' }; next(); });
app.use('/hub-api', intelRouter);

function getJson(server, urlPath) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        }).on('error', reject);
    });
}

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (800, 'Firewatch', 2, 2)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (950, 'AdminThree', 'x', 'admin')`).run();
systemPlansRepo.upsertSystemPlan(800, 'Colony ship pipeline through here — do not intercept ours.', 950);

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));

    try {
        console.log('\n-- The feature is OFF by default ' + '-'.repeat(41));
        const off = await getJson(server, '/hub-api/intel/system-plan/800');
        ok('responds 200 even when off', off.status === 200, off);
        ok('enabled: false', off.body && off.body.enabled === false, off.body);
        ok('and the plan is withheld entirely, not merely hidden client-side — a plan\n' +
            '     genuinely exists here, so this proves the gate is server-side',
            off.body && off.body.plan === null, off.body);

        console.log('\n-- Turned on ' + '-'.repeat(62));
        settingsRepo.setSetting('system_plans_enabled', '1');
        const on = await getJson(server, '/hub-api/intel/system-plan/800');
        ok('enabled: true', on.body && on.body.enabled === true, on.body);
        ok('the plan comes back with its note', on.body.plan && on.body.plan.note.includes('do not intercept'), on.body);
        ok('and its attribution', on.body.plan.author_name === 'AdminThree' && on.body.plan.was_edited === false, on.body.plan);

        console.log('\n-- A system with no plan on record ' + '-'.repeat(39));
        const empty = await getJson(server, '/hub-api/intel/system-plan/999');
        ok('still 200', empty.status === 200, empty);
        ok('enabled true, plan null — the honest "nothing written here yet" answer',
            empty.body.enabled === true && empty.body.plan === null, empty.body);

        console.log('\n-- Bad input ' + '-'.repeat(62));
        for (const bad of ['abc', '-1', '0']) {
            const r = await getJson(server, `/hub-api/intel/system-plan/${bad}`);
            ok(`systemId=${bad} is rejected with 400, not a crash`, r.status === 400, r);
        }
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

    if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
    console.log('All checks passed');
})().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
