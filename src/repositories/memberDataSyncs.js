const db = require('../database');

// --- member_data_syncs: "Update my data" ages (2026-10-17) ---
// See database.js's comment. Stamped by the /sync routes for a member's own Science,
// Planets and Trade pages; read back by the sidebar's "Update my data" line.

const KINDS = ['science', 'planets', 'trade'];

const upsertStmt = db.prepare(`
    INSERT INTO member_data_syncs (player_id, kind, synced_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(player_id, kind) DO UPDATE SET synced_at_ms = excluded.synced_at_ms
`);
const forPlayerStmt = db.prepare(`SELECT kind, synced_at_ms FROM member_data_syncs WHERE player_id = ?`);

function stamp(playerId, kind, now = Date.now()) {
    if (!KINDS.includes(kind)) throw new Error(`unknown member data kind: ${kind}`);
    upsertStmt.run(playerId, kind, now);
}

// { science: ms|null, planets: ms|null, trade: ms|null }
function getForPlayer(playerId) {
    const out = Object.fromEntries(KINDS.map(k => [k, null]));
    for (const row of forPlayerStmt.all(playerId)) {
        if (KINDS.includes(row.kind)) out[row.kind] = row.synced_at_ms;
    }
    return out;
}

module.exports = { KINDS, stamp, getForPlayer };
