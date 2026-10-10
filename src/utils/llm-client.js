// Only this boundary knows the provider or its credential. Tests inject a transport.
const Anthropic = require('@anthropic-ai/sdk');
const { ANSWER_SCHEMA, systemPrompt } = require('./race-llm-prompt');
const MAX_INPUT_TOKENS = 32768;
const MAX_OUTPUT_TOKENS = 8000;
// First-party standard pricing, verified 2026-10-10. Unknown models fail closed.
// https://platform.claude.com/docs/en/about-claude/pricing
const PRICES = Object.freeze({
    'claude-opus-5-5': { input: 4, output: 20, write: 5, read: 0.20 },
    'claude-sonnet-5': { input: 2, output: 10, write: 2.5, read: 0.20 },
    'claude-haiku-4-5': { input: 1, output: 5, write: 1.25, read: 0.10 },
});
class CheckError extends Error {
    constructor(code, usage = null) { super(code); this.code = code; this.usage = usage; }
}
function configuration() {
    return { enabled: process.env.RACE_LLM === '1', model: process.env.RACE_LLM_MODEL || 'claude-opus-5-5',
        effort: process.env.RACE_LLM_EFFORT || 'low', budget: Number(process.env.RACE_LLM_DAILY_BUDGET_USD || 2),
        lang: process.env.RACE_LLM_LANG || 'en' };
}
function assertConfig(config) {
    if (!config.enabled) throw new CheckError('disabled');
    if (!PRICES[config.model]) throw new CheckError('unpriced_model');
    if (!Number.isFinite(config.budget) || config.budget <= 0) throw new CheckError('budget_exhausted');
    if (!['low', 'medium', 'high'].includes(config.effort)) throw new CheckError('invalid_effort');
    if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(config.lang)) throw new CheckError('invalid_language');
}
function reservationCost(model) {
    const p = PRICES[model];
    if (!p) throw new CheckError('unpriced_model');
    // Reserve the complete output ceiling (including thinking) and a full cold cache.
    return (MAX_INPUT_TOKENS * Math.max(p.input, p.write) + MAX_OUTPUT_TOKENS * p.output) / 1e6;
}
function normalizedUsage(usage) {
    if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
    const result = { input: usage.input_tokens, output: usage.output_tokens,
        read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0 };
    if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0)
        || result.output > MAX_OUTPUT_TOKENS || result.input + result.read + result.write > MAX_INPUT_TOKENS) return null;
    return result;
}
function actualCost(model, usage) {
    const p = PRICES[model];
    return usage ? (usage.input * p.input + usage.output * p.output + usage.read * p.read + usage.write * p.write) / 1e6 : null;
}
const number = value => Number.isFinite(value) ? value : null;
const numericArray = value => Array.isArray(value) && value.length <= 128 ? value.map(number) : null;
const numericRanges = value => Array.isArray(value) ? value.slice(0, 3).map(numericArray) : null;
function pseudonymize(estimate, observations) {
    if (!observations.length || observations.length > 128) throw new CheckError('evidence_limit');
    const trait = row => row ? { most_likely: number(row.most_likely),
        set90: [number(row.set90_low), number(row.set90_high)], distribution: numericArray(row.dist),
        hard_candidates: numericArray(row.hard_candidates), prior: numericArray(row.prior),
        evidence_count: number(row.evidence_count) } : null;
    // An allowlist, not object spreading or deletion. Identifiers and free text never
    // have a route through this function, even when the database grows new columns.
    return { subject: 'S', estimate: { attack: trait(estimate.attack), defence: trait(estimate.defence) },
        reports: observations.map((observation, index) => ({ ref: `R${index + 1}`,
            side: observation.side === 'att' ? 'att' : 'def',
            atk_fleet: numericArray(observation.atkFleet), def_fleet: numericArray(observation.defFleet),
            starbase: number(observation.sbLevel),
            known: ['ra', 'rd', 'phys', 'math', 'lvl'].map(key => number(observation.known?.[key])),
            science_range: [0, number(observation.scienceCeiling)], level_range: [0, number(observation.levelCeiling)],
            intel_age_hours: number(observation.intelAgeHours), observed_win: number(observation.observedWin),
            losses: numericArray(observation.losses), survivors: numericArray(observation.survivors),
            subject_won: observation.subjectWon === true || observation.subjectWon === 1,
            attack_included: observation.attack_included === true,
            defence_included: observation.defence_included === true,
            attack_candidates: numericArray(observation.attack_candidates),
            defence_candidates: numericArray(observation.defense_candidates),
            model_at_estimate: { win: numericArray(observation.model_at_estimate?.win),
                losses: numericRanges(observation.model_at_estimate?.losses) },
        })) };
}
function requestParameters(evidence, modelVersion, config) {
    const params = { model: config.model, max_tokens: MAX_OUTPUT_TOKENS, thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: systemPrompt(modelVersion), cache_control: { type: 'ephemeral' } }],
        output_config: { effort: config.effort, format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
        messages: [{ role: 'user', content: `Explanation language: ${config.lang}.\n${JSON.stringify(evidence)}` }] };
    // This legacy optional model has no adaptive thinking/effort support. Its
    // documented manual budget is still inside the same total output ceiling.
    if (config.model === 'claude-haiku-4-5') {
        params.thinking = { type: 'enabled', budget_tokens: { low: 1024, medium: 2048, high: 4096 }[config.effort] };
        delete params.output_config.effort;
    }
    // Text BPE tokens cannot outnumber UTF-8 bytes. Leave a fixed framing/schema
    // margin, then reject oversized packages before reserving or contacting anyone.
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') + 4096 > MAX_INPUT_TOKENS) throw new CheckError('input_too_large');
    return params;
}
function providerError(error) {
    if (error instanceof CheckError) return error;
    if (error instanceof Anthropic.RateLimitError) return new CheckError('provider_rate_limit');
    if (error instanceof Anthropic.AuthenticationError) return new CheckError('provider_authentication');
    if (error instanceof Anthropic.APIConnectionTimeoutError) return new CheckError('provider_timeout');
    if (error instanceof Anthropic.APIConnectionError) return new CheckError('provider_connection');
    if (error instanceof Anthropic.APIError) return new CheckError('provider_api_error');
    return new CheckError('provider_error');
}
function createClient({ transport, config = configuration } = {}) {
    let sdk;
    const send = transport || (params => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new CheckError('missing_key');
        // Retries may spend the same reservation twice after an ambiguous timeout.
        sdk ||= new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 60000 });
        return sdk.messages.create(params);
    });
    return { configuration: config, prepare(evidence, modelVersion) {
        const current = config(); assertConfig(current);
        if (!transport && !process.env.ANTHROPIC_API_KEY) throw new CheckError('missing_key');
        return { config: current, params: requestParameters(evidence, modelVersion, current),
            reservation: reservationCost(current.model) };
    }, async call(prepared) {
        // Check again after a queued approval. No automatic or background dispatch.
        const current = config(); assertConfig(current);
        if (current.model !== prepared.config.model || current.effort !== prepared.config.effort
            || current.lang !== prepared.config.lang || current.budget !== prepared.config.budget) throw new CheckError('configuration_changed');
        let response;
        try { response = await send(prepared.params); } catch (error) { throw providerError(error); }
        const usage = normalizedUsage(response?.usage);
        if (!usage) throw new CheckError('invalid_usage');
        if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
            throw new CheckError(response.stop_reason, usage);
        }
        if (response.stop_reason !== 'end_turn') throw new CheckError('incomplete_response', usage);
        try {
            const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
            return { answer: JSON.parse(text), usage, cost: actualCost(prepared.config.model, usage) };
        } catch (_) { throw new CheckError('invalid_json', usage); }
    } };
}
module.exports = { createClient, CheckError, configuration, assertConfig, pseudonymize,
    reservationCost, actualCost, normalizedUsage, requestParameters, PRICES };
