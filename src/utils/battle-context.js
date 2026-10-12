// Context comes only from observations already synced by a member. A historical read
// is dated; it is never silently substituted for an exact battle-time measurement.
const HOUR = 3600000;
const { hasCurrentIntel } = require('../../public/js/utils/battle-model');

function time(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
    const day = new Date(value.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
    if (value.length > 10 && (Number(value.slice(11, 13)) > 23
        || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return null;
    let normalized = value.replace(' ', 'T');
    if (normalized.length === 10) normalized += 'T00:00:00';
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(normalized)) normalized += 'Z';
    const result = Date.parse(normalized);
    return Number.isFinite(result) ? result : null;
}

function evidenceStart(player) {
    const dates = [player?.joined, player?.battle_race_not_before].map(time).filter(value => value !== null);
    return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
}

function percent(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function diceCheck(report) {
    // random_number is documented on the percentage scale. 0.5 is a legitimate
    // percentage roll, so values below 1 must never be multiplied heuristically.
    const dice = percent(report.dice_roll) ?? percent(report.random_number);
    const chance = percent(report.att_win_chance);
    if (dice === null) return { dice_roll: null, dice_consistent: null, dice_reason: 'missing_or_invalid_dice' };
    if (chance === null) return { dice_roll: dice, dice_consistent: null, dice_reason: 'missing_win_chance' };
    if (report.att_has_won !== 0 && report.att_has_won !== 1) {
        return { dice_roll: dice, dice_consistent: null, dice_reason: 'missing_outcome' };
    }
    const consistent = Number(dice <= chance) === report.att_has_won;
    return { dice_roll: dice, dice_consistent: consistent ? 1 : 0,
        dice_reason: consistent ? (dice === chance ? 'consistent_equality_provisional' : 'consistent') : 'outcome_contradicts_dice' };
}

function refreshDiceChecks(db, ids) {
    const read = db.prepare('SELECT * FROM battle_reports WHERE id = ?');
    const write = db.prepare('UPDATE battle_reports SET dice_roll=@dice_roll,dice_consistent=@dice_consistent,dice_reason=@dice_reason WHERE id=@id');
    db.transaction(list => {
        for (const id of new Set(list)) {
            const row = read.get(id);
            if (row) write.run({ id, ...diceCheck(row) });
        }
    })(ids);
}

const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function recordCombatContext(db, player, observedAt = new Date().toISOString()) {
    const pick = value => Number.isSafeInteger(value) && value >= -4 && value <= 4;
    if (player?.has_intel !== 1 || !Number.isSafeInteger(player.id) || player.id <= 0
        || !pick(player.race_attack) || !pick(player.race_defense)
        || [player.physics, player.mathematics, player.level].some(value => nonnegative(value) === null)
        || time(observedAt) === null) return;
    db.prepare(`INSERT OR IGNORE INTO player_combat_history
        (player_id,race_attack,race_defense,physics,mathematics,level,observed_at) VALUES (?,?,?,?,?,?,?)`)
        .run(player.id, player.race_attack, player.race_defense, player.physics, player.mathematics,
            player.level, new Date(time(observedAt)).toISOString());
}

function nearestCombatContext(db, playerId, startedAt) {
    const when = time(startedAt);
    if (when === null || !Number.isSafeInteger(playerId)) return null;
    const player = db.prepare('SELECT joined,battle_race_not_before FROM players WHERE id=?').get(playerId);
    const cutoff = time(evidenceStart(player)) ?? -Infinity;
    if (when < cutoff) return null;
    const since = new Date(Math.max(when - 48 * HOUR, cutoff)).toISOString();
    return db.prepare(`SELECT *, 1 AS has_intel, observed_at AS intel_updated_at
        FROM player_combat_history WHERE player_id=? AND observed_at>=? AND observed_at<=?
        ORDER BY observed_at DESC LIMIT 1`).get(playerId, since, new Date(when).toISOString()) || null;
}

function enqueueRelatedEstimates(db, playerId, enqueue) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) return;
    try {
        const rows = db.prepare(`SELECT DISTINCT p.id,p.has_intel,p.intel_updated_at,p.joined,p.battle_race_not_before FROM players p JOIN battle_reports b
            ON p.id=b.att_player_id OR p.id=b.def_player_id
            WHERE b.att_player_id=? OR b.def_player_id=?`).all(playerId, playerId);
        for (const row of rows) if (!hasCurrentIntel(row)) enqueue(row.id);
    } catch (error) { console.error('[Race] Context recompute unavailable:', error.message); }
}

function recordPublicContext(db, player, observedAt = new Date().toISOString()) {
    if (!Number.isSafeInteger(player?.id) || player.id <= 0 || time(observedAt) === null) return;
    const level = nonnegative(player.level);
    const science = nonnegative(player.science_level);
    if (level === null && science === null) return;
    db.prepare(`INSERT OR IGNORE INTO player_public_history
        (player_id,level,science_level,joined,observed_at) VALUES (?,?,?,?,?)`)
        .run(player.id, level, science, typeof player.joined === 'string' ? player.joined : null,
            new Date(time(observedAt)).toISOString());
}

function recordStarbaseContext(db, systemId, planetIndex, level, observedAt) {
    if (!Number.isSafeInteger(systemId) || systemId <= 0 || !Number.isSafeInteger(planetIndex)
        || planetIndex <= 0 || nonnegative(level) === null || time(observedAt) === null) return;
    db.prepare(`INSERT OR IGNORE INTO planet_starbase_history
        (system_id,planet_index,level,observed_at) VALUES (?,?,?,?)`)
        .run(systemId, planetIndex, level, new Date(time(observedAt)).toISOString());
}

function contextCeilings(db, player, reports) {
    const cutoff = time(evidenceStart(player)) ?? -Infinity;
    let history;
    try { history = db.prepare('SELECT * FROM player_public_history WHERE player_id=? ORDER BY observed_at').all(player.id); }
    catch (error) {
        // Read-only before/after measurements must also work on a pre-rollout copy.
        // Absence of new history supplies no tighter bound than the legacy inputs.
        if (/no such table: player_public_history/.test(error.message)) return {};
        throw error;
    }
    const byReport = {};
    for (const report of reports) {
        const when = time(report.started_at);
        if (when === null || when < cutoff) continue;
        // Only a read AFTER the battle can safely cap sciences that were growing.
        // Reads from before it are lower bounds and cannot be used as ceilings.
        const eligible = history.filter(row => {
            const seen = time(row.observed_at);
            const joined = time(row.joined);
            return seen !== null && seen >= when && seen - when <= 48 * HOUR
                && (joined === null || joined <= when);
        });
        const science = eligible.find(row => nonnegative(row.science_level) !== null && row.science_level > 0);
        const level = eligible.find(row => nonnegative(row.level) !== null);
        if (!science && !level) continue;
        const side = report.att_player_id === player.id ? 'att' : 'def';
        const gained = nonnegative(report[`${side}_level_gained`]);
        byReport[report.id] = {
            science_level: science?.science_level ?? player.science_level,
            level: level ? Math.max(0, level.level - (gained ?? 0)) : player.level,
            source: 'dated_public_upper_bound',
            age_hours: Math.max(science ? (time(science.observed_at) - when) / HOUR : 0,
                level ? (time(level.observed_at) - when) / HOUR : 0),
        };
    }
    return byReport;
}

function measureContext(db) {
    const rows = db.prepare('SELECT * FROM battle_reports').all();
    const summary = { reports: rows.length, consistent: 0, inconsistent: 0, uncheckable: 0, reasons: {}, equality_provisional: 0 };
    for (const row of rows) {
        const check = diceCheck(row);
        summary[check.dice_consistent === 1 ? 'consistent' : check.dice_consistent === 0 ? 'inconsistent' : 'uncheckable']++;
        summary.reasons[check.dice_reason] = (summary.reasons[check.dice_reason] || 0) + 1;
        if (check.dice_reason === 'consistent_equality_provisional') summary.equality_provisional++;
    }
    return summary;
}

module.exports = { time, evidenceStart, percent, diceCheck, refreshDiceChecks, recordCombatContext, nearestCombatContext, enqueueRelatedEstimates, recordPublicContext,
    recordStarbaseContext, contextCeilings, measureContext };
