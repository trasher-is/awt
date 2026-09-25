// Invented players and reports only. Exercises the shared read path that both the
// profile card and the read-only measurement script use.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-battle-race-inputs-'));
process.env.AWT_DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
delete process.env.DISCORD_TOKEN;
const db = require('../database');
const battleModel = require('../../public/js/utils/battle-model');
const { readBattleRaceInputs, notBefore, measureBattleRace } = require('./battle-race-inputs');

let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const insertPlayer = db.prepare(`INSERT INTO players
    (id, name, has_intel, race_attack, race_defense, physics, mathematics, level, science_level,
     intel_updated_at, joined, battle_race_inference)
    VALUES (@id, @name, @has_intel, 0, 0, 10, 12, 20, 15, @intel_updated_at, '2026-08-29T00:00:00Z', @saved)`);
insertPlayer.run({ id: 1, name: 'Synthetic member', has_intel: 1, intel_updated_at: '2026-09-05 10:00:00', saved: null });
insertPlayer.run({ id: 2, name: 'Synthetic subject', has_intel: 0, intel_updated_at: null,
    saved: JSON.stringify({ version: 1, defense: { candidates: [-4, -3] } }) });
insertPlayer.run({ id: 3, name: 'Synthetic stranger', has_intel: 0, intel_updated_at: null, saved: null });

const SHIPS = battleModel.SHIPS.map(ship => ship.key);
function insertReport(id, attId, defId, attFleet, defFleet, subjectRd) {
    const result = battleModel.simulate({ atkFleet: attFleet, defFleet,
        atk: { ra: 0, rd: subjectRd, phys: 0, math: 8, lvl: 20 }, def: { ra: 0, rd: 0, phys: 10, math: 12, lvl: 20 } });
    const row = { id, started_at: '2026-09-05T12:00:00Z', is_public: 1, att_player_id: attId, def_player_id: defId,
        att_has_won: 1, def_has_won: 0 };
    for (const [side, fleet, alive] of [['att', attFleet, result.survAtk], ['def', defFleet, result.survDef]]) {
        SHIPS.forEach((ship, i) => {
            row[`${side}_${ship}`] = fleet[i];
            row[`${side}_${ship}_lost`] = fleet[i] - Math.round(alive[i]);
        });
        for (const ship of ['transports', 'colony_ships', 'starbases']) row[`${side}_${ship}`] = row[`${side}_${ship}_lost`] = 0;
        const lost = SHIPS.map(ship => row[`${side}_${ship}_lost`]);
        row[`${side}_combat_value`] = battleModel.cvOf(fleet);
        row[`${side}_lost_cv`] = battleModel.cvOf(lost);
        row[`${side}_survived_cv`] = row[`${side}_combat_value`] - row[`${side}_lost_cv`];
    }
    db.prepare(`INSERT INTO battle_reports (${Object.keys(row).join(',')})
        VALUES (${Object.keys(row).map(key => '@' + key).join(',')})`).run(row);
}
insertReport(101, 2, 1, [1000, 0, 0], [400, 0, 0], 2); // subject beats our member
insertReport(102, 2, 3, [1000, 0, 0], [400, 0, 0], 2); // subject beats a player without bio

try {
    const inputs = readBattleRaceInputs(db, 2);
    ok('the subject row carries its public ceilings', inputs.subject.science_level === 15 && inputs.subject.level === 20, inputs.subject);
    ok('both reports are read for the subject', inputs.reports.map(report => report.id).sort().join(',') === '101,102');
    ok('each opponent row is read once, by the other side of the report',
        Object.keys(inputs.opponents).sort().join(',') === '1,3' && inputs.opponents[1].has_intel === 1);
    ok('the identity cutoff comes from the Joined date', notBefore(inputs.player) === '2026-08-29T00:00:00.000Z');
    ok('an unknown player has no inputs', readBattleRaceInputs(db, 999) === null);

    const summary = measureBattleRace(db);
    ok('only players without bio are measured', summary.players === 2, summary);
    ok('the summary counts players with a narrowed Defence range', summary.defense_narrowed === 1, summary);
    ok('Attack is never narrowed while the stored win chance is the dice', summary.attack_narrowed === 0, summary);
    ok('skip reasons are summed per player and report', summary.skipped.no_known_side === 1
        && summary.skipped.not_confirmed_winner === 1, summary.skipped);
    ok('results saved before this version are summarised as the baseline',
        summary.saved.by_version['1'] === 1 && summary.saved.defense_narrowed === 1, summary.saved);
    ok('the summary carries no names or ids', !/Synthetic|\b10[12]\b/.test(JSON.stringify(summary)), summary);
    ok('measuring never writes results', db.prepare('SELECT battle_race_inference FROM players WHERE id = 3').get()
        .battle_race_inference === null);
} finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
