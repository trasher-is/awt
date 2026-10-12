const db = require('../database');
const { VERSION } = require('../utils/battle-race-inference');
const { readBattleRaceInputs, inferFromInputs, notBefore } = require('../utils/battle-race-inputs');
const { hasCurrentIntel } = require('../../public/js/utils/battle-model');

const playerStmt = db.prepare(`
    SELECT id, has_intel,intel_updated_at, joined, battle_race_inference, battle_race_not_before
    FROM players WHERE id = ?
`);
const saveStmt = db.prepare(`
    UPDATE players SET battle_race_inference = ? WHERE id = ? AND has_intel = ?
        AND intel_updated_at IS ? AND joined IS ? AND battle_race_not_before IS ?
`);

function savedInference(player) {
    if (player.joined === 'N/A' || hasCurrentIntel(player) || !player.battle_race_inference) return null;
    try {
        const saved = JSON.parse(player.battle_race_inference);
        // A later API Joined observation can reveal a restart that the login heuristic
        // missed. Do not display a result calculated for an earlier incarnation, or by an
        // earlier version of the method.
        return saved && saved.version === VERSION && saved.not_before === notBefore(player) ? saved : null;
    } catch (_) {
        return null;
    }
}

function getBattleRace(playerId) {
    const player = playerStmt.get(playerId);
    return player ? { has_bio: hasCurrentIntel(player), inference: savedInference(player) } : null;
}

// An IMMEDIATE transaction covers both the bio check and the conditional write: a scan
// from another hub process cannot slip confirmed race intel between those operations.
const updateTx = db.transaction((playerId, options) => {
    const inputs = readBattleRaceInputs(db, playerId);
    if (!inputs) return { status: 'not_found' };
    if (inputs.player.has_intel) return { status: 'bio_locked' };
    const recordedPlayer = playerStmt.get(playerId);
    const boundary = notBefore(inputs.player);
    const inference = {
        ...inferFromInputs(playerId, inputs, options),
        updated_at: new Date().toISOString(),
        not_before: boundary,
    };
    if (!saveStmt.run(JSON.stringify(inference), playerId, recordedPlayer.has_intel,
        recordedPlayer.intel_updated_at, recordedPlayer.joined, recordedPlayer.battle_race_not_before).changes) return { status: 'bio_locked' };
    return { status: 'updated', inference };
});

function updateBattleRace(playerId, options = {}) {
    return updateTx.immediate(playerId, options);
}

module.exports = { getBattleRace, updateBattleRace };
