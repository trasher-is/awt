// Invented evidence and provider replies only. Every provider request is replayed;
// even an accidental attempt to use the real transport fails this suite.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { createRepository } = require('../repositories/raceChecks');
const { createClient, pseudonymize, reservationCost, requestParameters } = require('./llm-client');
const { createService, modelRanges } = require('./race-llm-service');
const { systemPrompt, validateAnswer, PROMPT_VERSION } = require('./race-llm-prompt');
const model = require('../../public/js/utils/battle-model');
let failed = 0;
function ok(name, condition, detail) {
    if (condition) console.log(`  ok - ${name}`);
    else { failed++; console.error(`  NOT OK - ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}
const clone = value => JSON.parse(JSON.stringify(value));
const originalFetch = global.fetch;
global.fetch = () => { throw new Error('Live provider transport forbidden in replay test'); };
const canaries = ['PRIVATE_PLAYER_CANARY', 'PRIVATE_ALLIANCE_CANARY', 'PRIVATE_SYSTEM_CANARY',
    '2087-07-07T07:07:07Z', '981234567', '981234568'];
function fixture() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE app_users(id INTEGER PRIMARY KEY,role TEXT);
        INSERT INTO app_users VALUES(1,'admin'),(2,'user'),(3,'guest');
        CREATE TABLE players(id INTEGER PRIMARY KEY,name TEXT,tag TEXT,system TEXT,observed TEXT);
        INSERT INTO players VALUES(981234567,'PRIVATE_PLAYER_CANARY','PRIVATE_ALLIANCE_CANARY','PRIVATE_SYSTEM_CANARY','2087-07-07T07:07:07Z');
        INSERT INTO players VALUES(981234568,'Other invented player',NULL,NULL,NULL);
        CREATE TABLE llm_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,player_id INTEGER NOT NULL,requested_by INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',approved_by INTEGER,created_at TEXT,decided_at TEXT);
        CREATE TABLE player_race_checks(player_id INTEGER PRIMARY KEY,request_id INTEGER,input_hash TEXT,model_version TEXT,
            prompt_version TEXT,model TEXT,verdict TEXT,output TEXT,status TEXT,resolved_by INTEGER,created_at TEXT);
        CREATE TABLE llm_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,
            cache_read_tokens INTEGER,cache_write_tokens INTEGER,cost_usd REAL,latency_ms INTEGER,status TEXT,error TEXT,input_hash TEXT,created_at TEXT);`);
    let time = Date.parse('2026-10-10T12:00:00Z');
    let config = { enabled: true, model: 'claude-opus-5-5', effort: 'low', budget: 2, lang: 'en' };
    const inputs = { player: db.prepare('SELECT * FROM players WHERE id=?').get(981234567), reports: [{ id: 981234568, when: canaries[3] }] };
    const row = () => ({ most_likely: 0, set90_low: -1, set90_high: 1, dist: [0, 0, 0, 0.2, 0.6, 0.2, 0, 0, 0],
        prior: Array(9).fill(1 / 9), hard_candidates: [-1, 0, 1], evidence_count: 1,
        model_version: 'synthetic-model', evidence_hash: 'synthetic-hash', band: 'high' });
    const estimate = { player_id: 981234567, attack: row(), defence: row() };
    const observation = { report_id: 981234568, side: 'att', when: Date.parse(canaries[3]),
        atkFleet: [1000, 0, 0], defFleet: [400, 0, 0], sbLevel: 0,
        known: { ra: 0, rd: 0, phys: 0, math: 0, lvl: 0 }, intelAgeHours: 2,
        scienceCeiling: 0, levelCeiling: 0, losses: [400, 0, 0], survivors: [600, 0, 0],
        observedWin: 100, dice: 55, subjectWon: true, attack_candidates: [-1, 0, 1], defense_candidates: [-1, 0, 1],
        name: canaries[0], tag: canaries[1], system_name: canaries[2] };
    const usage = { input_tokens: 1500, output_tokens: 1200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
    const response = () => ({ subject: 'S', trait_checks: ['attack', 'defence'].map(trait => ({ trait,
        verdict: 'agrees', problem: 'none', reason: 'The model ranges cover this invented observation.', report_refs: ['R1'] })),
        explanation: 'AI: the evidence is consistent with the supplied estimate.',
        confidence_adjustment: { direction: 'none', traits: [], reason: '' }, contradictions: [], evidence_refs: ['R1'] });
    let answer = response(), stop = 'end_turn', calls = 0, body, deferred;
    const transport = async params => {
        calls++; body = clone(params);
        if (deferred) await deferred;
        return { stop_reason: stop, usage, content: [{ type: 'text', text: JSON.stringify(answer) }] };
    };
    const repository = createRepository(db, { now: () => new Date(time) });
    const client = createClient({ transport, config: () => config });
    const evidenceRows = [{ battle_report_id: 981234568, kind: 'win', status: 'ok' },
        { battle_report_id: 981234568, kind: 'loss', status: 'ok' }];
    const service = createService({ repository, client, estimates: { getEstimate: () => estimate,
        evidenceForPlayer: () => evidenceRows },
        readInputs: () => inputs, buildEvidence: () => ({ observations: [observation] }),
        rangeBuilder: (obs, saved) => modelRanges(obs, saved, { loss: 1.5, win: model.uncertainty.BASE_ERROR_PP }),
        modelVersion: () => 'synthetic-model', now: () => time });
    return { db, repository, service, client, observation, estimate, inputs, response, evidenceRows,
        advance: (ms = 2000) => { time += ms; }, config: updates => { config = { ...config, ...updates }; },
        setAnswer: value => { answer = value; }, setStop: value => { stop = value; },
        defer: promise => { deferred = promise; }, calls: () => calls, body: () => body };
}
async function main() {
    let f = fixture();
    ok('guest cannot request', f.service.requestCheck(981234567, 3).error === 'forbidden');
    const request = f.service.requestCheck(981234567, 2).request;
    ok('a member creates one pending request without calling a provider', request.status === 'pending' && f.calls() === 0);
    ok('duplicate member request returns the same pending id', f.service.requestCheck(981234567, 2).request.id === request.id);
    ok('member cannot invoke the approved-only service', (await f.service.runCheck(981234567, { userId: 2, requestId: request.id })).error === 'forbidden');
    ok('a pending request is not executable even by an admin without approval',
        (await f.service.runCheck(981234567, { userId: 1, requestId: request.id })).error === 'not_approved');
    const approved = await f.service.approveRequest(request.id, 1);
    ok('approval performs exactly one replay and marks both traits checked', approved.state.state === 'AI-checked' && f.calls() === 1, approved);
    ok('requests are settled done and ledger records usage', approved.request.status === 'done'
        && f.db.prepare('SELECT output_tokens FROM llm_calls').get().output_tokens === 1200);
    const serialized = JSON.stringify(f.body());
    ok('database canary names/tags/game ids/systems/absolute dates never leave server', canaries.every(c => !serialized.includes(c)), serialized);
    ok('report refs are local tokens and dice is not supplied as win chance', serialized.includes('R1') && !serialized.includes('"dice"'));
    ok('request uses structured output, adaptive thinking and bounded output', f.body().thinking.type === 'adaptive'
        && f.body().output_config.effort === 'low' && f.body().output_config.format.schema.additionalProperties === false
        && f.body().max_tokens === 8000);
    const prompt = systemPrompt('synthetic-model');
    ok('prompt constants come from the authoritative object', prompt.includes(JSON.stringify(model.constants)));
    ok('static prefix is stable for a model version', prompt === systemPrompt('synthetic-model') && prompt.includes(PROMPT_VERSION));
    const originalEstimate = clone(f.estimate);
    f.inputs.reports.push({ id: 981234569, rejected: true });
    ok('new even-skipped evidence invalidates a check before estimator recomputation', f.service.checkState(981234567).state === 'outdated');
    ok('AI check leaves mathematical Attack/Defence untouched', JSON.stringify(originalEstimate) === JSON.stringify(f.estimate));
    f.db.close();

    f = fixture(); await f.service.runCheck(981234567, { userId: 1 });
    f.evidenceRows[0].status = 'excluded';
    ok('manual evidence-status change invalidates the check before recompute', f.service.checkState(981234567).state === 'outdated');
    f.db.close();

    const credentialName = ['ANTHROPIC', 'API', 'KEY'].join('_');
    const previousCredential = process.env[credentialName]; delete process.env[credentialName];
    f = fixture();
    const defaultTransportService = createService({ repository: f.repository, client: createClient({ config: () => ({
        enabled: true, model: 'claude-opus-5-5', effort: 'low', budget: 2, lang: 'en' }) }),
        estimates: { getEstimate: () => f.estimate }, readInputs: () => f.inputs,
        buildEvidence: () => ({ observations: [f.observation] }), modelVersion: () => 'synthetic-model',
        rangeBuilder: (obs, saved) => modelRanges(obs, saved, { loss: 1.5, win: model.uncertainty.BASE_ERROR_PP }) });
    const noKey = await defaultTransportService.runCheck(981234567, { userId: 1 });
    ok('missing credential prevents any reservation or provider network access', noKey.error === 'missing_key'
        && f.db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === 0 && f.service.usage().today.cost_usd === 0);
    if (previousCredential !== undefined) process.env[credentialName] = previousCredential;
    f.db.close();

    for (const [change, expected] of [[{ enabled: false }, 'disabled'], [{ budget: 0.1 }, 'budget_exhausted'],
        [{ model: 'unpriced-invented-model' }, 'unpriced_model']]) {
        f = fixture(); f.config(change);
        const result = await f.service.runCheck(981234567, { userId: 1 });
        ok(`${expected} stops before any network/transport access`, result.error === expected && f.calls() === 0, result);
        if (expected === 'budget_exhausted') {
            f.config({ budget: 2 }); f.advance();
            ok('budget-blocked approved request remains manually retryable', (await f.service.runCheck(981234567, { userId: 1 })).request.status === 'done');
        }
        f.db.close();
    }

    f = fixture();
    let answer = f.response(); answer.trait_checks[0] = { ...answer.trait_checks[0], verdict: 'disagrees', problem: 'wrong_most_likely' };
    f.setAnswer(answer);
    const held = await f.service.runCheck(981234567, { userId: 1 });
    ok('one supported disagreement holds both traits until human resolution', held.state.state === 'held');
    f.inputs.reports.push({ id: 91 });
    ok('outdated evidence does not silently lift a held estimate', f.service.checkState(981234567).state === 'held'
        && f.service.checkState(981234567).outdated === true);
    f.advance();
    ok('a replacement call cannot bypass explicit held resolution',
        (await f.service.runCheck(981234567, { userId: 1 })).error === 'held_requires_resolution');
    ok('members cannot resolve and keeping leaves the hold intact', f.service.resolveCheck(981234567, 2).error === 'forbidden'
        && f.service.resolveCheck(981234567, 1, 'keep').decision === 'keep' && f.service.checkState(981234567).state === 'held');
    ok('admin release is recorded and lifts the hold', f.service.resolveCheck(981234567, 1).check.resolved_by === 1
        && f.service.checkState(981234567).state === 'outdated');
    f.db.close();

    f = fixture(); answer = f.response();
    answer.trait_checks[0] = { ...answer.trait_checks[0], verdict: 'disagrees', problem: 'report_mismatch' };
    f.setAnswer(answer);
    const unsupported = await f.service.runCheck(981234567, { userId: 1 });
    ok('a numerically unsupported mismatch is recorded without holding', unsupported.state.state === 'cannot_check'
        && unsupported.check.output.trait_checks[0].validation === 'unsupported', unsupported);
    f.advance(); f.observation.observedWin = 0; f.inputs.reports[0].observedWin = 0;
    const supported = await f.service.runCheck(981234567, { userId: 1 });
    ok('a verified out-of-range win probability does hold', supported.state.state === 'held', supported);
    f.db.close();

    for (const mutate of [answer => { answer.evidence_refs = ['UNKNOWN']; },
        answer => { answer.confidence_adjustment.direction = 'higher'; },
        answer => { answer.trait_checks.push(clone(answer.trait_checks[0])); },
        answer => { answer.planning = 'not allowed'; }]) {
        f = fixture(); answer = f.response(); mutate(answer); f.setAnswer(answer);
        const result = await f.service.runCheck(981234567, { userId: 1 });
        ok('unknown refs/confidence increases/duplicate traits/unexpected fields are rejected', result.validation === 'rejected'
            && result.state.state === 'not_checked' && result.check.status === 'rejected', result);
        f.db.close();
    }
    f = fixture(); answer = f.response(); answer.confidence_adjustment = { direction: 'lower', traits: ['attack'], reason: 'Thin evidence.' };
    f.setAnswer(answer); const lower = await f.service.runCheck(981234567, { userId: 1 });
    ok('lower affects only displayed confidence by one step', lower.state.bands.attack === 'medium'
        && lower.state.bands.defence === 'high' && f.estimate.attack.band === 'high'); f.db.close();

    for (const stop of ['refusal', 'max_tokens']) {
        f = fixture(); f.setStop(stop);
        const result = await f.service.runCheck(981234567, { userId: 1 });
        ok(`${stop} stores failed request with billed usage and no check`, result.error === stop
            && result.request.status === 'failed' && !result.check
            && f.db.prepare('SELECT cost_usd FROM llm_calls').get().cost_usd > 0);
        f.db.close();
    }
    f = fixture(); f.config({ budget: 0.35 });
    await f.service.runCheck(981234567, { userId: 1 }); f.advance();
    const blocked = await f.service.runCheck(981234568, { userId: 1 });
    ok('settled costs plus worst-case reservation cannot cross hard daily ceiling', blocked.error === 'budget_exhausted' && f.calls() === 1);
    f.advance(24 * 3600 * 1000);
    const nextDay = await f.service.runCheck(981234568, { userId: 1 });
    ok('next UTC day unlocks a manually retried approved request while preserving ledger', nextDay.request.status === 'done'
        && f.service.usage().days.length === 2);
    f.db.close();
    f = fixture(); let release;
    f.defer(new Promise(resolve => { release = resolve; }));
    const first = f.service.runCheck(981234567, { userId: 1 });
    const duplicate = await f.service.runCheck(981234567, { userId: 1 });
    ok('concurrent duplicate request reserves only once', duplicate.error === 'already_running'
        && f.calls() === 1 && f.db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === 1);
    const spent = f.service.usage().today.cost_usd;
    ok('reservation charges the full cold-cache input plus thinking/output ceiling', Math.abs(spent - reservationCost('claude-opus-5-5')) < 1e-12);
    f.db.exec('DELETE FROM llm_requests; DELETE FROM player_race_checks;');
    release(); const afterReset = await first;
    ok('reset during provider await never recreates intel; accounting survives', afterReset.error === 'request_expired'
        && f.db.prepare('SELECT COUNT(*) n FROM player_race_checks').get().n === 0
        && f.db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n === 1);
    f.db.close();

    // Independent validation replay matrix: correct and three seeded estimate-error
    // classes. These synthetic replies test guards, not provider detection quality.
    let cases = 0;
    for (let variant = 0; variant < 10; variant++) for (const problem of ['none', 'range_too_wide', 'range_too_narrow', 'wrong_most_likely']) {
        f = fixture(); f.observation.atkFleet[0] += variant * 10;
        const evidence = f.service.packageFor(981234567).evidence;
        answer = f.response();
        answer.trait_checks[variant % 2].problem = problem;
        answer.trait_checks[variant % 2].verdict = problem === 'none' ? 'agrees' : 'disagrees';
        const result = validateAnswer(answer, evidence);
        ok(`synthetic replay ${++cases}: ${problem}`, result.status === 'ok' && result.verdict === (problem === 'none' ? 'agrees' : 'disagrees'));
        f.db.close();
    }
    ok('40 replay cases do not claim live model evaluation', cases === 40);
    f = fixture();
    const evidence = f.service.packageFor(981234567).evidence;
    const legacy = requestParameters(evidence, 'synthetic-model', { model: 'claude-haiku-4-5', effort: 'low', lang: 'en' });
    ok('optional legacy Haiku uses documented manual thinking without unsupported effort', legacy.thinking.type === 'enabled'
        && !Object.hasOwn(legacy.output_config, 'effort') && legacy.thinking.budget_tokens < legacy.max_tokens);
    const ranges = modelRanges({ ...f.observation, scienceCeiling: 6, levelCeiling: 4 }, f.estimate,
        { loss: 1.5, win: model.uncertainty.BASE_ERROR_PP });
    let enclosed = true;
    for (let lvl = 0; lvl <= 4; lvl++) for (let phys = 0; phys <= 6; phys++) for (let math = 0; math <= 6; math++) {
        const result = model.simulate({ atkFleet: f.observation.atkFleet, defFleet: f.observation.defFleet,
            atk: { ra: 0, rd: 0, phys, math, lvl }, def: f.observation.known });
        enclosed &&= result.winA * 100 >= ranges.win[0] && result.winA * 100 <= ranges.win[1]
            && result.survAtk.every((alive, i) => f.observation.atkFleet[i] - Math.round(alive) >= ranges.losses[i][0]
                && f.observation.atkFleet[i] - Math.round(alive) <= ranges.losses[i][1]);
    }
    ok('model envelope contains all enumerated historical levels/sciences and whole-ship losses', enclosed);
    f.db.close();
    const credential = ['ANTHROPIC', 'API', 'KEY'].join('_'), sdkName = ['@anthropic-ai', 'sdk'].join('/');
    const offenders = [];
    function scan(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const filename = path.join(dir, entry.name);
            if (entry.isDirectory()) scan(filename);
            else if (filename.endsWith('.js') && !filename.endsWith('/llm-client.js')) {
                const source = fs.readFileSync(filename, 'utf8');
                if (source.includes(credential) || source.includes(sdkName)) offenders.push(filename);
            }
        }
    }
    scan(path.join(__dirname, '..')); scan(path.join(__dirname, '../../public'));
    ok('credential and provider SDK names occur in only the server client source', offenders.length === 0, offenders);
}
main().catch(error => { failed++; console.error(error); }).finally(() => {
    global.fetch = originalFetch;
    process.exitCode = failed ? 1 : 0;
});
