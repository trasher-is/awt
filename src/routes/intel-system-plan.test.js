// GET/POST/DELETE /hub-api/intel/system-plan/:systemId. The read path is what
// page-injections.js's initSystemPlan() polls; POST/DELETE are the web equivalent of the
// !splan Discord command (2026-09-16e — added so a plan is no longer editable ONLY from
// Discord), sharing systemPlansRepo directly so the two write paths can never format a
// note or enforce the length cap differently.
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
function request(server, method, urlPath, body) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body !== undefined ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1', port, path: urlPath, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
// A second app whose session carries an admin role, for the POST/DELETE tests below —
// the fixed session above (userId 1, no role) is deliberately non-admin, so the two apps
// together prove requireAdmin is actually gating something rather than passing everyone.
function appAs(session) {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.session = session; next(); });
    a.use('/hub-api', intelRouter);
    return a;
}

db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (800, 'Firewatch', 2, 2)`).run();
db.prepare(`INSERT INTO systems (id, name, x, y) VALUES (801, 'Redzone', 3, 3)`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (950, 'AdminThree', 'x', 'admin')`).run();
db.prepare(`INSERT INTO app_users (id, game_name, password_hash, role) VALUES (951, 'AdminFour', 'x', 'admin')`).run();
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

        console.log('\n-- Writing: non-admins are refused ' + '-'.repeat(37));
        {
            const asMember = appAs({ userId: 1, gameName: 'caveman', role: 'user' }).listen(0);
            await new Promise(r => asMember.once('listening', r));
            try {
                const write = await request(asMember, 'POST', '/hub-api/intel/system-plan/801', { note: 'sneaky' });
                ok('a logged-in non-admin cannot create a plan (403)', write.status === 403, write);
                ok('and nothing was written', systemPlansRepo.getSystemPlan(801) === null);

                const del = await request(asMember, 'DELETE', '/hub-api/intel/system-plan/800');
                ok('a logged-in non-admin cannot delete one either (403)', del.status === 403, del);
                ok('and the existing plan is untouched', systemPlansRepo.getSystemPlan(800) !== null);
            } finally { asMember.close(); }
        }

        console.log('\n-- Writing: admins can, sharing the exact repo the bot uses ' + '-'.repeat(9));
        {
            const asAdmin = appAs({ userId: 950, gameName: 'AdminThree', role: 'admin' }).listen(0);
            await new Promise(r => asAdmin.once('listening', r));
            try {
                const write = await request(asAdmin, 'POST', '/hub-api/intel/system-plan/801', { note: 'Hold Redzone — planet sharing per the alliance meeting.' });
                ok('an admin can create one', write.status === 200 && write.body.success, write);
                ok('the response carries the saved plan back, byline included',
                    write.body.plan && write.body.plan.note.includes('Hold Redzone') && write.body.plan.author_name === 'AdminThree',
                    write.body.plan);

                console.log('\n-- Editing it, as a DIFFERENT admin ' + '-'.repeat(37));
                const asOtherAdmin = appAs({ userId: 951, gameName: 'AdminFour', role: 'admin' }).listen(0);
                await new Promise(r => asOtherAdmin.once('listening', r));
                try {
                    const edit = await request(asOtherAdmin, 'POST', '/hub-api/intel/system-plan/801', { note: 'Hold Redzone — UPDATE: reinforced.' });
                    ok('a different admin can edit an existing plan', edit.status === 200 && edit.body.success, edit);
                    ok('the original author is preserved across the edit', edit.body.plan.author_name === 'AdminThree', edit.body.plan);
                    ok('the editor is whoever just wrote it', edit.body.plan.last_edited_by_name === 'AdminFour', edit.body.plan);
                    ok('and was_edited flips true', edit.body.plan.was_edited === true, edit.body.plan);
                } finally { asOtherAdmin.close(); }

                console.log('\n-- Rejected writes ' + '-'.repeat(57));
                const empty = await request(asAdmin, 'POST', '/hub-api/intel/system-plan/801', { note: '   ' });
                ok('whitespace-only note is rejected (400)', empty.status === 400, empty);

                const tooLong = await request(asAdmin, 'POST', '/hub-api/intel/system-plan/801', { note: 'x'.repeat(4001) });
                ok('a note over the shared length cap is rejected (400), matching !splan\'s own limit',
                    tooLong.status === 400 && /4000/.test(tooLong.body.error), tooLong);

                console.log('\n-- Turned off mid-session ' + '-'.repeat(50));
                settingsRepo.setSetting('system_plans_enabled', '');
                const whileOff = await request(asAdmin, 'POST', '/hub-api/intel/system-plan/801', { note: 'should not land' });
                ok('writing while the feature is off is refused (403), even for an admin', whileOff.status === 403, whileOff);
                const delWhileOff = await request(asAdmin, 'DELETE', '/hub-api/intel/system-plan/801');
                ok('so is deleting — off means off for every write', delWhileOff.status === 403, delWhileOff);
                settingsRepo.setSetting('system_plans_enabled', '1');

                console.log('\n-- Deleting ' + '-'.repeat(63));
                const del = await request(asAdmin, 'DELETE', '/hub-api/intel/system-plan/801');
                ok('an admin can delete it', del.status === 200 && del.body.success, del);
                ok('it is really gone', systemPlansRepo.getSystemPlan(801) === null);

                const delAgain = await request(asAdmin, 'DELETE', '/hub-api/intel/system-plan/801');
                ok('deleting a system with nothing on record is a 404, not a silent success',
                    delAgain.status === 404, delAgain);
            } finally { asAdmin.close(); }
        }
    } finally {
        server.close();
    }

    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });

    if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
    console.log('All checks passed');
})().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
