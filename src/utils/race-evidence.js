const crypto = require('crypto');
const battle = require('../../public/js/utils/battle-model');
const arithmetic = require('../../public/js/utils/race-inference');
const { buildRaceObservations } = require('./battle-race-inference');
const { notBefore } = require('./battle-race-inputs');

const modelVersion = () => arithmetic.modelVersion();
function buildEvidence(playerId, inputs, options = {}) {
    return buildRaceObservations(playerId, inputs.reports, { ...options,
        notBefore: notBefore(inputs.player), subject: inputs.subject, opponents: inputs.opponents,
        contextCeilingsByReport: inputs.contextCeilingsByReport });
}
function hashEvidence(observations, statuses = {}) {
    const sorted = [...observations].sort((a, b) => a.report_id - b.report_id);
    return crypto.createHash('sha256').update(JSON.stringify({ version: modelVersion(), observations: sorted,
        statuses: Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
}
function hardRanges(observations) {
    const ranges = { attack: [...arithmetic.PICKS], defence: [...arithmetic.PICKS] };
    for (const row of observations) {
        for (const [trait, field] of [['attack', 'attack_candidates'], ['defence', 'defense_candidates']]) {
            if (row[field]) ranges[trait] = ranges[trait].filter(value => row[field].includes(value));
        }
    }
    return ranges;
}
function predictiveCompatibility(previous, evidence) {
    if (!previous || !previous.evidence_count || !evidence) return 1;
    const weights = evidence.matrix.map(row => arithmetic.logsum(row) - Math.log(row.length));
    const top = Math.max(...weights);
    if (!Number.isFinite(top)) return 0;
    return weights.reduce((sum, weight, i) => sum + previous.dist[i] * Math.exp(weight - top), 0);
}
module.exports = { modelVersion, buildEvidence, hashEvidence, hardRanges, predictiveCompatibility };
