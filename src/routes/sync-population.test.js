// Synthetic regression coverage for #161: population history and Discord attribution
// through the real /sync/system transaction. No game or Discord requests are made.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-sync-population-'));
process.env.AWT_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
const announcements = [];
const botPath = require.resolve('../discord_bot');
require.cache[botPath] = { id: botPath, filename: botPath, loaded: true, exports: {
    announceSystemChanges: async (system, events) => announcements.push({ system, events }),
    announceSystemMilestones: async () => {},
} };
const express = require('express');
const db = require('../database');
const battleReports = require('../repositories/battleReports');
const { buildSystemChangeLines } = require('../utils/system-change-lines');
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
app.use('/hub-api', require('./sync'));
let failed = 0;
function ok(name, condition, detail) {
    console.log(`  ${condition ? 'ok' : 'NOT OK'} - ${name}${!condition && detail ? ': ' + JSON.stringify(detail) : ''}`);
    if (!condition) failed++;
}
const minutesAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const holder = { id: 4101, name: 'Holder' };
const insertReport = db.prepare(`INSERT INTO battle_reports
    (id, started_at, system_id, planet_index, att_player_id, att_player_name,
     def_player_id, killed_population, winner, att_has_won, def_has_won)
    VALUES (@id, @started_at, @system_id, @planet_index, @att_player_id,
            @att_player_name, @def_player_id, @killed_population, @winner, @att_has_won, @def_has_won)`);

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const sync = async (systemId, planet) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/hub-api/sync/system`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: systemId, planets: [{ planet_index: 1, starbase: 0, ...planet }] }),
        });
        if (!response.ok) throw new Error(`Sync failed: ${response.status} ${await response.text()}`);
        return response.json();
    };
    try {
        console.log('sync-population.test.js');
        await sync(4100, { owner: holder, population: 4 });
        await sync(4100, { owner: null, is_unknown: true, population: 4 });
        const resignationEvents = announcements.at(-1).events;
        ok('resigning leaves the four inhabitants alive and records only ownership history',
            db.prepare('SELECT population FROM planets WHERE system_id=4100').get().population === 4
            && db.prepare('SELECT COUNT(*) AS n FROM planet_events WHERE system_id=4100 AND event_type_id=2').get().n === 0);
        ok('resigning sends no population-kill announcement',
            buildSystemChangeLines(resignationEvents).popLines.length === 0, resignationEvents);
        ok('resigning creates no phantom battle in the merged feed',
            !battleReports.getBattleReportsFeed().some(row => row.system_id === 4100));

        for (const [systemId, population, isUnknown] of [[4102, 3, true], [4103, 0, false]]) {
            await sync(systemId, { owner: holder, population: 4 });
            await sync(systemId, { owner: null, is_unknown: isUnknown, population });
            const drop = db.prepare('SELECT old_value,new_value FROM planet_events WHERE system_id=? AND event_type_id=2').get(systemId);
            const event = announcements.at(-1).events.find(e => e.type === 'POP_DROP');
            const line = buildSystemChangeLines([event]).popLines[0];
            ok(`a real loss to ${isUnknown ? 'Unknown' : 'Empty'} records only the observed population loss`,
                drop && drop.old_value === 4 && drop.new_value === population, drop);
            ok('clearing ownership does not invent a conqueror or conquest',
                event && !event.by && !event.attacker && !line.includes('conquest') && line.includes(`lost ${4 - population} population`), line);
        }

        // Every report below is synthetic. Defaults are a confirmed two-population
        // bombardment of Holder, ten minutes after the previous scan.
        const cases = [
            { name: 'later failed attack cannot steal population credit', reports: [{}, { minutes: 5, attacker: 4202, name: 'Failed', killed: 0, winner: 'Defender' }], expected: 'Bomber' },
            { name: 'successful zero-kill combat cannot steal population credit', reports: [{}, { minutes: 5, attacker: 4202, name: 'ZeroKill', killed: 0 }], expected: 'Bomber' },
            { name: 'a different defender does not match this victim', reports: [{ defender: 4999 }], expected: null },
            { name: 'a report before the previous scan cannot explain a new drop', reports: [{ minutes: 25 }], expected: null },
            { name: 'a future report cannot explain this scan', reports: [{ minutes: -5 }], expected: null },
            { name: 'the report window stays capped at three hours after a long scan gap', scanMinutes: 300, reports: [{ minutes: 240 }], expected: null },
            { name: 'reports at another planet cannot explain this drop', reports: [{ planet: 2 }], expected: null },
            { name: 'missing population counts do not prove a bombardment', reports: [{ killed: null }], expected: null },
            { name: 'an incomplete possible second bombardment keeps attribution unknown', reports: [{}, { minutes: 5, attacker: 4202, killed: null }], expected: null },
            { name: 'an unknown defender cannot be assumed to be the planet owner', reports: [{ defender: null }], expected: null },
            { name: 'two possible attackers keep the aggregate drop unattributed', reports: [{}, { minutes: 5, attacker: 4202, name: 'OtherBomber' }], expected: null },
            { name: 'equal attacker names do not collapse distinct player IDs', reports: [{}, { minutes: 5, attacker: 4202 }], expected: null },
            { name: 'multiple same-attacker reports account together for the observed drop', reports: [{}, { minutes: 5 }], population: 5, expected: 'Bomber' },
            { name: 'a report killing two cannot attribute seven observed deaths', reports: [{}], population: 2, expected: null },
            { name: 'growth can make the observed drop smaller than confirmed kills', reports: [{ killed: 4 }], expected: 'Bomber' },
            { name: 'an attacker name without an ID cannot establish one identity', reports: [{ attacker: null }], expected: null },
            { name: 'an explicit attacker failure is not a bombardment candidate', reports: [{ attWon: 0 }], expected: null },
            { name: 'an explicit defender victory is not a bombardment candidate', reports: [{ defWon: 1 }], expected: null },
            { name: 'an offset-stamped report uses the real instant', reports: [{ offset: true }], expected: 'Bomber' },
            { name: 'a report at the previous scan timestamp is not confidently later', reports: [{ atPreviousScan: true }], expected: null },
            { name: 'a later fraction of the previous scan second has uncertain ordering', reports: [{ sameScanSecond: true }], expected: null },
            { name: 'no report leaves the attacker unknown', reports: [], expected: null },
        ];
        let reportId = 5000;
        for (const [index, test] of cases.entries()) {
            const systemId = 4300 + index;
            await sync(systemId, { owner: holder, population: 9 });
            const scannedAt = minutesAgo(test.scanMinutes || 20).replace(/\.\d{3}Z$/, '.000Z');
            db.prepare('UPDATE planets SET updated_at=? WHERE system_id=?').run(scannedAt, systemId);
            for (const report of test.reports) {
                let startedAt = report.atPreviousScan ? scannedAt : minutesAgo(report.minutes ?? 10);
                if (report.sameScanSecond) startedAt = new Date(Date.parse(scannedAt) + 500).toISOString();
                if (report.offset) startedAt = new Date(Date.parse(startedAt) + 7200000).toISOString().replace('Z', '+02:00');
                insertReport.run({
                    id: ++reportId, started_at: startedAt, system_id: systemId, planet_index: report.planet || 1,
                    att_player_id: report.attacker === undefined ? 4201 : report.attacker,
                    att_player_name: report.name || 'Bomber',
                    def_player_id: report.defender === undefined ? holder.id : report.defender,
                    killed_population: report.killed === undefined ? 2 : report.killed,
                    winner: report.winner || 'Attacker', att_has_won: report.attWon ?? null, def_has_won: report.defWon ?? null,
                });
            }
            const population = test.population ?? 7;
            await sync(systemId, { owner: holder, population });
            const event = announcements.at(-1).events.find(e => e.type === 'POP_DROP');
            ok(test.name, event && event.attacker === test.expected && event.old_pop === 9 && event.new_pop === population, event);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failed) { console.error(`${failed} check(s) failed`); process.exitCode = 1; }
    else console.log('All checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
