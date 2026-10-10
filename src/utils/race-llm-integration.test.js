// Real schema/repositories/estimator/prompt pipeline; only provider transport is
// replayed. Synthetic rows stay in an isolated temporary database.
const fs = require('fs'), os = require('os'), path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-race-ai-integration-'));
process.env.AWT_DB_PATH = path.join(temporary, 'synthetic.db');
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'synthetic-test-password';
process.env.RACE_LLM = '1';
delete process.env.DISCORD_TOKEN; delete process.env.BATTLE_DISCORD_TOKEN;
const originalFetch = global.fetch;
global.fetch = () => { throw new Error('Network forbidden in synthetic AI integration'); };
const db = require('../database');
const model = require('../../public/js/utils/battle-model');
const arithmetic = require('../../public/js/utils/race-inference');
const inference = require('./race-inference-service');
const estimates = require('../repositories/raceEstimates');
const { createClient } = require('./llm-client');
const { createService } = require('./race-llm-service');
let failed = 0, captured, calls = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const playerId = 981234567, knownId = 981234568, reportId = 981234569;
db.prepare(`INSERT INTO players(id,name,has_intel,science_level,level,joined)
    VALUES(?,'SECRET_SUBJECT_CANARY',0,14,20,'2026-09-01T00:00:00Z')`).run(playerId);
db.prepare(`INSERT INTO players(id,name,has_intel,race_attack,race_defense,physics,mathematics,level,intel_updated_at)
    VALUES(?,'SECRET_KNOWN_CANARY',1,0,0,12,12,20,'2026-10-01 10:00:00')`).run(knownId);
function insertReport(id) {
    const atkFleet = [0, 300, 0], defFleet = [2600, 0, 0];
    const outcome = model.simulate({ atkFleet, defFleet, atk: { ra: 2, rd: 1, phys: 12, math: 11, lvl: 20 },
        def: { ra: 0, rd: 0, phys: 12, math: 12, lvl: 20 } });
    const row = { id, started_at: '2026-10-01T12:00:00Z', is_public: 1, att_player_id: playerId,
        def_player_id: knownId, att_has_won: 1, def_has_won: 0, att_win_chance: outcome.winA * 100,
        dice_roll: 0, dice_consistent: 1, stats_snapshot_at: '2026-10-01 12:05:00',
        def_race_attack: 0, def_race_defense: 0, def_physics: 12, def_mathematics: 12,
        def_player_level: 20, def_intel_at: '2026-10-01 10:00:00' };
    for (const [side, fleet, alive] of [['att', atkFleet, outcome.survAtk], ['def', defFleet, outcome.survDef]]) {
        model.SHIPS.forEach((ship, i) => {
            row[`${side}_${ship.key}`] = fleet[i]; row[`${side}_${ship.key}_lost`] = fleet[i] - Math.round(alive[i]);
        });
        for (const ship of ['transports', 'colony_ships', 'starbases']) row[`${side}_${ship}`] = row[`${side}_${ship}_lost`] = 0;
        row[`${side}_combat_value`] = model.cvOf(fleet);
        row[`${side}_lost_cv`] = model.cvOf(model.SHIPS.map(ship => row[`${side}_${ship.key}_lost`]));
        row[`${side}_survived_cv`] = row[`${side}_combat_value`] - row[`${side}_lost_cv`];
    }
    db.prepare(`INSERT INTO battle_reports(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(key => '@' + key).join(',')})`).run(row);
}
const reply = { subject: 'S', trait_checks: ['attack', 'defence'].map(trait => ({ trait, verdict: 'agrees',
    problem: 'none', reason: 'Synthetic response replay.', report_refs: ['R1'] })), explanation: 'AI: synthetic replay only.',
    confidence_adjustment: { direction: 'none', traits: [], reason: '' }, contradictions: [], evidence_refs: ['R1'] };
const client = createClient({ config: () => ({ enabled: true, model: 'claude-opus-5-5', effort: 'low', budget: 2, lang: 'en' }),
    transport: async params => {
        calls++; captured = JSON.stringify(params);
        return { stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 1200 },
            content: [{ type: 'text', text: JSON.stringify(reply) }] };
    } });
const checks = createService({ client });
(async () => {
    try {
        insertReport(reportId);
        const calculated = inference.recompute(playerId);
        ok('real estimator persists usable synthetic distributions', calculated.status === 'updated'
            && calculated.estimate.attack.evidence_count === 1 && calculated.estimate.defence.evidence_count === 1);
        const prepared = checks.packageFor(playerId);
        ok('production builder uses current shared model version and authoritative observations',
            prepared.modelVersion === arithmetic.modelVersion() && prepared.evidence.reports.length === 1
            && prepared.evidence.reports[0].attack_included && prepared.evidence.reports[0].defence_included, prepared);
        ok('model-at-estimate exposes both prediction envelopes', prepared.evidence.reports[0].model_at_estimate.win.length === 2
            && prepared.evidence.reports[0].model_at_estimate.losses.length === 3);
        const result = await checks.runCheck(playerId, { userId: 1 });
        ok('production repositories complete a manual synthetic check without live transport', result.state?.state === 'AI-checked'
            && calls === 1 && result.check.model_version === arithmetic.modelVersion(), result);
        ok('real database ids/names/report dates never enter provider body',
            ['SECRET_SUBJECT_CANARY', 'SECRET_KNOWN_CANARY', String(playerId), String(knownId), String(reportId),
                '2026-10-01', '2026-09-01'].every(canary => !captured.includes(canary)), captured);
        db.prepare("UPDATE player_race_estimates SET estimated_at='2099-01-01' WHERE player_id=?").run(playerId);
        ok('an unchanged estimate timestamp cannot invalidate identical evidence', checks.checkState(playerId).state === 'AI-checked');
        const evidence = estimates.evidenceForPlayer(playerId);
        estimates.setEvidenceStatus(evidence[0].id, 'excluded');
        ok('real exclusion invalidates an existing check before recomputation', checks.checkState(playerId).state === 'outdated');
        estimates.setEvidenceStatus(evidence[0].id, 'ok');
        insertReport(reportId + 1);
        db.prepare('UPDATE battle_reports SET is_public=0 WHERE id=?').run(reportId + 1);
        ok('an unusable new report invalidates the proof without recomputing/writing/calling',
            checks.checkState(playerId).state === 'outdated' && calls === 1);
        const count = db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n;
        checks.checkState(playerId); checks.checkState(playerId);
        ok('read-only display checks do not enqueue, save or call AI', calls === 1 && db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === count);
    } finally {
        global.fetch = originalFetch; db.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
    process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
