const crypto = require('crypto');
const battleModel = require('../../public/js/utils/battle-model');
const clientModule = require('./llm-client');
const { PROMPT_VERSION, validateAnswer, inputHash, displayedBand } = require('./race-llm-prompt');

function modelRanges(observation, estimate, tolerances) {
    const lossTolerance = tolerances?.loss ?? require('./battle-race-inference').LOSS_TOLERANCE_SHIPS;
    const winTolerance = tolerances?.win ?? require('../../public/js/utils/race-inference').winSigma(observation);
    if (!Number.isFinite(lossTolerance) || !Number.isFinite(winTolerance)) throw new clientModule.CheckError('invalid_model');
    const ra = estimate.attack?.most_likely, rd = estimate.defence?.most_likely;
    if (!Number.isInteger(ra) || !Number.isInteger(rd)) return { win: null, losses: null };
    const science = Math.min(100, Math.max(0, Math.trunc(observation.scienceCeiling)));
    const levels = [...new Set([0, Math.max(0, Math.trunc(observation.levelCeiling))])];
    const win = [Infinity, -Infinity], losses = Array.from({ length: 3 }, () => [Infinity, -Infinity]);
    // Historical level effects are monotonic on either side of the known level, so
    // its endpoints bound the interval. Enumerate every unknown Physics/Math pair:
    // annihilation links Physics to losses even though toughness itself does not.
    for (const lvl of levels) for (let phys = 0; phys <= science; phys++) for (let math = 0; math <= science; math++) {
        const subject = { ra, rd, phys, math, lvl };
        const result = battleModel.simulate({ atkFleet: observation.atkFleet, defFleet: observation.defFleet,
            sbLevel: observation.sbLevel,
            atk: observation.side === 'att' ? subject : observation.known,
            def: observation.side === 'def' ? subject : observation.known });
        const chance = result.winA * 100;
        win[0] = Math.min(win[0], chance); win[1] = Math.max(win[1], chance);
        const fleet = observation.side === 'att' ? observation.atkFleet : observation.defFleet;
        const survivors = observation.side === 'att' ? result.survAtk : result.survDef;
        survivors.forEach((alive, index) => {
            const loss = fleet[index] - alive;
            losses[index][0] = Math.max(0, Math.min(losses[index][0], loss - lossTolerance));
            losses[index][1] = Math.min(fleet[index], Math.max(losses[index][1], loss + lossTolerance));
        });
    }
    // The game displays rounded win percentages; don't turn display rounding into
    // a purported contradiction. This is observation precision, not a new formula.
    return { win: [Math.max(0, win[0] - winTolerance), Math.min(100, win[1] + winTolerance)], losses };
}
function createService({ repository = require('../repositories/raceChecks'),
    client = clientModule.createClient(), estimates, readInputs, buildEvidence, modelVersion,
    rangeBuilder = modelRanges, now = () => Date.now() } = {}) {
    const estimatesRepo = () => estimates || require('../repositories/raceEstimates');
    const inputsFor = playerId => readInputs ? readInputs(playerId)
        : require('./battle-race-inputs').readBattleRaceInputs(require('../database'), playerId);
    const universe = () => new URL(process.env.TARGET_URL || 'https://astrowars.games').hostname.startsWith('redzone.') ? 'redzone' : 'standard';
    const evidenceFor = (playerId, inputs) => buildEvidence ? buildEvidence(playerId, inputs, { universe: universe() })
        : require('./race-evidence').buildEvidence(playerId, inputs, { universe: universe() });
    const version = () => modelVersion ? modelVersion() : require('./race-evidence').modelVersion();
    const packageCache = new Map();
    function packageFor(playerId, suppliedEstimate, fingerprintOnly = false) {
        const estimate = suppliedEstimate || estimatesRepo().getEstimate(playerId);
        const inputs = inputsFor(playerId);
        if (!inputs || !estimate) return null;
        const model = version();
        const evidenceRows = estimatesRepo().evidenceForPlayer?.(playerId) || [];
        const estimateValues = Object.fromEntries(['attack', 'defence'].map(trait => {
            const row = estimate[trait];
            return [trait, row ? Object.fromEntries(['dist', 'most_likely', 'set90_low', 'set90_high', 'band',
                'evidence_count', 'evidence_report_ids', 'evidence_hash', 'hard_candidates', 'prior',
                'withheld_reason', 'model_version'].map(key => [key, row[key]])) : null];
        }));
        // Full local fingerprint catches even newly skipped/invalid reports before
        // the debounced estimator catches up. Only its digest reaches the ledger.
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ inputs, estimate: estimateValues, model, universe: universe(),
            statuses: evidenceRows.map(row => [row.battle_report_id, row.kind, row.status]) })).digest('hex');
        // Predictions and pseudonyms are deterministic functions of this snapshot.
        // Display needs only this proof, not an expensive science-grid replay.
        const hash = inputHash({ source_fingerprint: fingerprint }, model);
        if (fingerprintOnly) return { estimate, inputHash: hash, modelVersion: model };
        if (packageCache.has(fingerprint)) return packageCache.get(fingerprint);
        const built = evidenceFor(playerId, inputs);
        const observations = built.observations.map(observation => ({ ...observation,
            attack_included: evidenceRows.some(row => row.battle_report_id === observation.report_id && row.kind === 'win' && row.status === 'ok'),
            defence_included: evidenceRows.some(row => row.battle_report_id === observation.report_id && row.kind === 'loss' && row.status === 'ok'),
            model_at_estimate: rangeBuilder(observation, estimate) }));
        if (!observations.length) return { estimate, evidence: null, inputHash: hash, modelVersion: model };
        const evidence = clientModule.pseudonymize(estimate, observations);
        const value = { estimate, evidence, inputHash: hash, modelVersion: model };
        if (packageCache.size >= 128) packageCache.delete(packageCache.keys().next().value);
        packageCache.set(fingerprint, value);
        return value;
    }
    function checkState(playerId, estimate) {
        const check = repository.getCheck(playerId);
        const current = packageFor(playerId, estimate, true);
        const currentHash = current?.inputHash || null;
        const proof = { input_hash: check?.input_hash || null, current_input_hash: currentHash,
            model_version: check?.model_version || null, current_model_version: current?.modelVersion || null };
        if (!check) return { ...proof, state: 'not_checked' };
        const held = check.status === 'ok' && check.verdict === 'disagrees'
            && (!check.resolved_by || check.output?.resolution?.decision === 'keep');
        const isCurrent = check.input_hash === currentHash && check.model_version === current?.modelVersion
            && check.prompt_version === PROMPT_VERSION;
        const checks = check.output?.trait_checks || [];
        return { ...proof, state: held ? 'held' : !isCurrent ? 'outdated'
            : check.status !== 'ok' ? 'not_checked' : check.verdict === 'agrees' ? 'AI-checked' : 'cannot_check',
            outdated: !isCurrent, status: isCurrent ? 'current' : 'outdated',
            attack: { verdict: checks.find(row => row.trait === 'attack')?.verdict || 'cannot_check' },
            defence: { verdict: checks.find(row => row.trait === 'defence')?.verdict || 'cannot_check' },
            explanation: check.output?.explanation || '', output: check.output, resolved_by: check.resolved_by,
            bands: { attack: displayedBand(current?.estimate.attack?.band, { status: isCurrent ? 'current' : 'outdated', output: check.output }, 'attack'),
                defence: displayedBand(current?.estimate.defence?.band, { status: isCurrent ? 'current' : 'outdated', output: check.output }, 'defence') } };
    }
    async function runCheck(playerId, { userId, requestId } = {}) {
        if (repository.userRole(userId) !== 'admin') return { error: 'forbidden' };
        let prepared, current;
        try {
            // Kill/budget/model validation precedes all provider contact and requests.
            clientModule.assertConfig(client.configuration());
            current = packageFor(playerId);
            if (!current) return { error: 'not_found' };
            if (!current.evidence || !current.estimate.attack || !current.estimate.defence) return { error: 'insufficient_evidence' };
            if ([current.estimate.attack, current.estimate.defence].some(row => row.withheld_reason
                || row.model_version !== current.modelVersion)) return { error: 'estimate_unavailable' };
            prepared = client.prepare(current.evidence, current.modelVersion);
        } catch (error) { return { error: error.code || 'invalid_evidence' }; }
        if (!requestId) {
            const created = repository.request(playerId, userId, true);
            if (created.error) return created;
            requestId = created.request.id;
        }
        const request = repository.getRequest(requestId);
        if (!request || request.player_id !== playerId) return { error: 'not_found' };
        const reservation = repository.reserve(requestId, userId, current.inputHash, prepared.config.model,
            prepared.reservation, prepared.config.budget);
        if (reservation.error) return reservation;
        const started = now();
        try {
            const result = await client.call(prepared);
            const validated = validateAnswer(result.answer, current.evidence);
            // Rejected output is stored locally for admin diagnosis, never a model
            // authority, and its refs/HTML are never used as actions or links.
            const finished = repository.finish(reservation.callId, { usage: result.usage, cost: result.cost,
                latency: now() - started, check: { modelVersion: current.modelVersion, promptVersion: PROMPT_VERSION,
                    verdict: validated.verdict, status: validated.status,
                    output: validated.output || { reason: validated.reason, explanation: 'AI response rejected.' } } });
            return finished.error ? finished : { ...finished, state: checkState(playerId), validation: validated.status };
        } catch (error) {
            const code = error.code || 'provider_error';
            const usage = error.usage || null;
            const finished = repository.finish(reservation.callId, { error: code, usage,
                cost: ['disabled', 'missing_key', 'configuration_changed', 'budget_exhausted'].includes(code) ? 0
                    : clientModule.actualCost(prepared.config.model, usage), latency: now() - started });
            return { ...finished, error: code };
        }
    }
    return { runCheck, checkState, packageFor,
        requestCheck: (playerId, userId) => repository.request(playerId, userId),
        async approveRequest(id, adminId) {
            const previous = repository.getRequest(id);
            if (previous?.status === 'approved' && repository.userRole(adminId) === 'admin') {
                return runCheck(previous.player_id, { userId: adminId, requestId: id });
            }
            const decision = repository.decide(id, adminId, 'approved');
            return decision.error ? decision : runCheck(decision.request.player_id, { userId: adminId, requestId: id });
        },
        rejectRequest: (id, adminId) => repository.decide(id, adminId, 'rejected'),
        resolveCheck: (playerId, adminId, decision = 'release') => repository.resolve(playerId, adminId, decision),
        queue: () => repository.queue(),
        usage: () => ({ ...repository.usage(), enabled: client.configuration().enabled,
            daily_budget_usd: client.configuration().budget, model: client.configuration().model }) };
}
let service;
const defaultService = () => service ||= createService();
module.exports = { createService, modelRanges };
for (const method of ['runCheck', 'requestCheck', 'approveRequest', 'rejectRequest', 'checkState', 'queue', 'usage', 'resolveCheck']) {
    module.exports[method] = (...args) => defaultService()[method](...args);
}
