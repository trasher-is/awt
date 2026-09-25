// What battle-race inference reads for one player, from any database handle. The profile
// card (src/repositories/battleRace.js) passes the hub's database; the measurement script
// (scripts/battle-race-measure.js) passes a read-only copy. Sharing this read is what makes
// the script's numbers describe the card, not a second implementation of it.
const { inferBattleRace, VERSION } = require('./battle-race-inference');

const statements = new WeakMap();
function prepared(db) {
    if (!statements.has(db)) {
        statements.set(db, {
            player: db.prepare(`
                SELECT id, has_intel, joined, battle_race_inference, battle_race_not_before, science_level, level
                FROM players WHERE id = ?
            `),
            reports: db.prepare(`
                SELECT * FROM battle_reports WHERE att_player_id = ? OR def_player_id = ?
                ORDER BY started_at DESC, id DESC
            `),
            // The other side of each report. Its bio intel, if recorded near the battle, is
            // the known side the inference measures the player against.
            opponent: db.prepare(`
                SELECT id, has_intel, race_attack, race_defense, physics, mathematics, level, intel_updated_at
                FROM players WHERE id = ?
            `),
            unknownPlayers: db.prepare(`
                SELECT id FROM players WHERE has_intel = 0 AND id IN (
                    SELECT att_player_id FROM battle_reports UNION SELECT def_player_id FROM battle_reports
                ) ORDER BY id
            `),
        });
    }
    return statements.get(db);
}

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

function readBattleRaceInputs(db, playerId) {
    const statement = prepared(db);
    const player = statement.player.get(playerId);
    if (!player) return null;
    const reports = statement.reports.all(playerId, playerId);
    const opponents = {};
    for (const report of reports) {
        const otherId = report.att_player_id === playerId ? report.def_player_id : report.att_player_id;
        if (Number.isSafeInteger(otherId) && !(otherId in opponents)) opponents[otherId] = statement.opponent.get(otherId) || null;
    }
    return {
        player, reports, opponents,
        subject: { science_level: player.science_level, level: player.level },
    };
}

function inferFromInputs(playerId, inputs, options = {}) {
    return inferBattleRace(playerId, inputs.reports, {
        ...options, notBefore: notBefore(inputs.player), subject: inputs.subject, opponents: inputs.opponents,
    });
}

const narrowed = trait => Array.isArray(trait?.candidates) && trait.candidates.length > 0 && trait.candidates.length < 9;

// Counts only: how many players the current method narrows, and which filters remove
// reports. No names, ids or report numbers leave this function, so the output can be
// posted on a public issue. It computes and never saves.
function measureBattleRace(db, options = {}) {
    const summary = {
        version: VERSION, players: 0, with_eligible_reports: 0,
        defense_narrowed: 0, defense_conflicting: 0, attack_narrowed: 0,
        reports_seen: 0, reports_eligible: 0, skipped: {},
        saved: { by_version: {}, defense_narrowed: 0 },
    };
    for (const { id } of prepared(db).unknownPlayers.all()) {
        const inputs = readBattleRaceInputs(db, id);
        const result = inferFromInputs(id, inputs, options);
        summary.players++;
        summary.reports_seen += result.report_count;
        summary.reports_eligible += result.eligible_report_count;
        if (result.eligible_report_count) summary.with_eligible_reports++;
        if (narrowed(result.defense)) summary.defense_narrowed++;
        if (result.defense.status === 'conflicting') summary.defense_conflicting++;
        if (narrowed(result.attack)) summary.attack_narrowed++;
        for (const [reason, count] of Object.entries(result.skipped)) {
            summary.skipped[reason] = (summary.skipped[reason] || 0) + count;
        }
        // The results members saved with an earlier version are the "before" numbers.
        let saved = null;
        try { saved = JSON.parse(inputs.player.battle_race_inference); } catch (_) { /* unreadable: not counted */ }
        if (saved && Number.isSafeInteger(saved.version)) {
            summary.saved.by_version[saved.version] = (summary.saved.by_version[saved.version] || 0) + 1;
            if (narrowed(saved.defense)) summary.saved.defense_narrowed++;
        }
    }
    return summary;
}

module.exports = { readBattleRaceInputs, inferFromInputs, notBefore, measureBattleRace };
