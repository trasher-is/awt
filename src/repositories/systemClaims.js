const db = require('../database');

// All claims, joined to the system's name — the Galaxy Archive's Claims layer loads this
// once alongside the map data and groups rows by system_id client-side.
const getAllClaimsStmt = db.prepare(`
    SELECT sc.system_id, sc.alliance_tag, sc.planet_count, sc.note, sc.updated_at,
           u.game_name as updated_by_name
    FROM system_claims sc
    LEFT JOIN app_users u ON u.id = sc.updated_by
    ORDER BY sc.system_id, sc.alliance_tag
`);
function getAllClaims() {
    return getAllClaimsStmt.all();
}

// One alliance's share of one system. planet_count is nullable ("whole system" / unsplit).
const upsertClaimStmt = db.prepare(`
    INSERT INTO system_claims (system_id, alliance_tag, planet_count, note, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(system_id, alliance_tag) DO UPDATE SET
        planet_count = excluded.planet_count,
        note = excluded.note,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertClaim(systemId, allianceTag, planetCount, note, updatedBy) {
    upsertClaimStmt.run(systemId, allianceTag.trim().toUpperCase(), planetCount, note || null, updatedBy);
}

const deleteClaimStmt = db.prepare(`
    DELETE FROM system_claims WHERE system_id = ? AND alliance_tag = ?
`);
function deleteClaim(systemId, allianceTag) {
    return deleteClaimStmt.run(systemId, allianceTag.trim().toUpperCase());
}

module.exports = { getAllClaims, upsertClaim, deleteClaim };
