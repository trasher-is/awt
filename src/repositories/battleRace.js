const db = require('../database');
const { VERSION } = require('../utils/battle-race-inference');
const { readBattleRaceInputs, inferFromInputs, notBefore } = require('../utils/battle-race-inputs');

const playerStmt = db.prepare(`
    SELECT id, has_intel, joined, battle_race_inference, battle_race_not_before
    FROM players WHERE id = ?
`);
const saveStmt = db.prepare(`
    UPDATE players SET battle_race_inference = ? WHERE id = ? AND has_intel = 0
`);

function savedInference(player) {
    if (player.has_intel || !player.battle_race_inference) return null;
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
    return player ? { has_bio: !!player.has_intel, inference: savedInference(player) } : null;
}

// An IMMEDIATE transaction covers both the bio check and the conditional write: a scan
// from another hub process cannot slip confirmed race intel between those operations.
const updateTx = db.transaction((playerId, options) => {
    const inputs = readBattleRaceInputs(db, playerId);
    if (!inputs) return { status: 'not_found' };
    if (inputs.player.has_intel) return { status: 'bio_locked' };
    const boundary = notBefore(inputs.player);
    const inference = {
        ...inferFromInputs(playerId, inputs, options),
        updated_at: new Date().toISOString(),
        not_before: boundary,
    };
    if (!saveStmt.run(JSON.stringify(inference), playerId).changes) return { status: 'bio_locked' };
    return { status: 'updated', inference };
});

function updateBattleRace(playerId, options = {}) {
    return updateTx.immediate(playerId, options);
}

module.exports = { getBattleRace, updateBattleRace };
