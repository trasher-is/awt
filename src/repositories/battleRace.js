const db = require('../database');
const { inferBattleRace } = require('../utils/battle-race-inference');

const playerStmt = db.prepare(`
    SELECT id, has_intel, joined, battle_race_inference, battle_race_not_before
    FROM players WHERE id = ?
`);
const reportsStmt = db.prepare(`
    SELECT * FROM battle_reports WHERE att_player_id = ? OR def_player_id = ?
    ORDER BY started_at DESC, id DESC
`);
const saveStmt = db.prepare(`
    UPDATE players SET battle_race_inference = ? WHERE id = ? AND has_intel = 0
`);

// Only unambiguous ISO/SQLite dates can bound an account's current incarnation. A DOM
// Joined label can be localized: guessing its date order would silently mix old races.
function timestamp(value) {
    if (typeof value !== 'string') return null;
    const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
    if (!parts) return null;
    const [year, month, day, hour, minute, second] = parts.slice(1).map(part => Number(part || 0));
    const daysInMonth = new Date(Date.UTC(2000 + year % 400, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
    let normalized = value.replace(' ', 'T');
    if (normalized.length === 10) normalized += 'T00:00:00';
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) normalized += 'Z';
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

function notBefore(player) {
    const times = [player.joined, player.battle_race_not_before].map(timestamp).filter(t => t !== null);
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function savedInference(player) {
    if (player.has_intel || !player.battle_race_inference) return null;
    try {
        const saved = JSON.parse(player.battle_race_inference);
        // A later API Joined observation can reveal a restart that the login heuristic
        // missed. Do not display a result calculated for an earlier incarnation.
        return saved && saved.version === 1 && saved.not_before === notBefore(player) ? saved : null;
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
    const player = playerStmt.get(playerId);
    if (!player) return { status: 'not_found' };
    if (player.has_intel) return { status: 'bio_locked' };
    const boundary = notBefore(player);
    const inference = {
        ...inferBattleRace(playerId, reportsStmt.all(playerId, playerId), { ...options, notBefore: boundary }),
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
