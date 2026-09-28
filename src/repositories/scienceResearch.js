const db = require('../database');

// --- science_research: research tracker (2026-09-28) ---
// See database.js's comment. One row per member, replaced on every read of their own
// /Game/Science page.

const upsertStmt = db.prepare(`
    INSERT INTO science_research (player_id, observed_at, science_rate, levels_json, queue_json)
    VALUES (@player_id, @observed_at, @science_rate, @levels_json, @queue_json)
    ON CONFLICT(player_id) DO UPDATE SET
        observed_at = excluded.observed_at,
        science_rate = excluded.science_rate,
        levels_json = excluded.levels_json,
        queue_json = excluded.queue_json
`);

const listStmt = db.prepare(`
    SELECT r.player_id, p.name, r.observed_at, r.science_rate, r.levels_json, r.queue_json
    FROM science_research r
    JOIN players p ON p.id = r.player_id
    ORDER BY p.name COLLATE NOCASE
`);

// Active hub accounts that map to a player but have never reported research — so the
// Discord list can say who is missing instead of silently leaving them out.
const missingMembersStmt = db.prepare(`
    SELECT u.game_name AS name
    FROM app_users u
    JOIN players p ON LOWER(u.game_name) = LOWER(p.name)
    LEFT JOIN science_research r ON r.player_id = p.id
    WHERE u.is_active = 1 AND r.player_id IS NULL
    ORDER BY u.game_name COLLATE NOCASE
`);

/**
 * @param {number} playerId
 * @param {{observedAtMs:number, scienceRate:number|null, levels:Object<string,number>, items:Array}} snap
 *        items as research-queue.js's schedule() returns them
 */
function saveResearch(playerId, snap) {
    upsertStmt.run({
        player_id: playerId,
        observed_at: new Date(snap.observedAtMs).toISOString(),
        science_rate: Number.isFinite(snap.scienceRate) ? snap.scienceRate : null,
        levels_json: JSON.stringify(snap.levels || {}),
        queue_json: JSON.stringify(snap.items || []),
    });
}

function hydrate(row) {
    let levels = {}, items = [];
    try { levels = JSON.parse(row.levels_json) || {}; } catch (_) { /* keep {} */ }
    try { items = JSON.parse(row.queue_json) || []; } catch (_) { /* keep [] */ }
    return {
        player_id: row.player_id,
        name: row.name,
        observed_at_ms: Date.parse(row.observed_at),
        science_rate: row.science_rate,
        levels,
        items,
    };
}

function listResearch() {
    return listStmt.all().map(hydrate);
}

function findResearchByName(name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    return listResearch().find(r => String(r.name).toLowerCase() === q) || null;
}

function listMembersWithoutResearch() {
    return missingMembersStmt.all().map(r => r.name);
}

module.exports = { saveResearch, listResearch, findResearchByName, listMembersWithoutResearch };
