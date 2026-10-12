// Node-only policy boundary. The expected model version comes from current code,
// never from a stored estimate, submitted form or a caller's claimed version.
const Model = require('../../public/js/utils/battle-model');
const Inference = require('../../public/js/utils/race-inference');

function resolveRaceStats(player, { estimate = null, gate = null, check = null } = {}, { minBand } = {}) {
    return Model.resolveStats(player, {
        estimate, gate, check,
        model_version: Inference.modelVersion(),
        min_band: minBand || process.env.RACE_RESOLVE_MIN_BAND || 'medium',
    });
}

function calculationAllowed(player, envelope, options) {
    return resolveRaceStats(player, envelope, options).source === 'estimate';
}

module.exports = { resolveRaceStats, resolvePlayerStats: resolveRaceStats, calculationAllowed };
