const db = require('../database');

// --- Reads for the incoming-attack battle lines (src/utils/incoming-battle.js) ---

// The attacked planet: its owner, starbase level, when it was last seen, and whether it is
// the owner's home planet (from home he can spend every planet's PP).
const getPlanetDefenceStmt = db.prepare(`
    SELECT pn.owner_id, pl.name AS owner_name, pn.starbase, pn.updated_at, pn.game_planet_id,
           (pl.home_system_id = pn.system_id AND pl.home_planet_index = pn.planet_index) AS is_home
    FROM planets pn
    LEFT JOIN players pl ON pl.id = pn.owner_id
    WHERE pn.system_id = ? AND pn.planet_index = ?
`);
function getPlanetDefence(systemId, planetIndex) {
    return getPlanetDefenceStmt.get(systemId, planetIndex);
}

// The owner's own ships on the planet when the attack lands: fleets sitting there, plus
// fleets of his that land there before the attacker (arrival_at is an ISO string, so the
// text comparison orders correctly).
const getGarrisonStmt = db.prepare(`
    SELECT COALESCE(SUM(destroyers), 0) AS d, COALESCE(SUM(cruisers), 0) AS c, COALESCE(SUM(battleships), 0) AS b
    FROM fleets
    WHERE owner_id = ? AND system_id = ? AND planet_index = ?
      AND (arrival_at IS NULL OR arrival_at = '' OR arrival_at <= ?)
`);
function getGarrison(ownerId, systemId, planetIndex, beforeIso) {
    const r = getGarrisonStmt.get(ownerId, systemId, planetIndex, beforeIso);
    return r ? [r.d, r.c, r.b] : [0, 0, 0];
}

// One of our players' combat stats, with the member sheet's sciences beside the scan's —
// see allySide() in src/utils/incoming-battle.js for why both.
const getAllyCombatRowStmt = db.prepare(`
    SELECT p.race_attack, p.race_defense, p.physics, p.mathematics, p.science_level, p.level,
           p.has_intel, p.intel_updated_at, p.total_xp,
           s.physics AS sheet_physics, s.mathematics AS sheet_mathematics,
           s.sciences_updated_at AS sheet_sciences_updated_at
    FROM players p
    LEFT JOIN alliance_member_stats s ON s.player_id = p.id
    WHERE LOWER(p.name) = ?
`);
function getAllyCombatRow(nameLower) {
    return getAllyCombatRowStmt.get(nameLower);
}

// Saved PP per planet (My Savings), placed on the map, for every planet a member could
// build a defence on or launch one from. Scoped like the interceptor search: the defender's
// alliance, or every active hub user when the defender is unknown.
const BUILD_COLS = `
    p.id AS owner_id, p.name AS owner_name, p.energy, p.race_speed, p.economy,
    pn.system_id, pn.planet_index, s.x AS sx, s.y AS sy,
    b.production_pp, b.production_rate,
    (p.home_system_id = pn.system_id AND p.home_planet_index = pn.planet_index) AS is_home,
    ams.astro_dollars
`;
const BUILD_FROM = `
    FROM planet_banking b
    JOIN players p ON p.id = b.player_id
    JOIN planets pn ON pn.game_planet_id = b.game_planet_id
    JOIN systems s ON s.id = pn.system_id
    LEFT JOIN alliance_member_stats ams ON ams.player_id = p.id
    WHERE s.x IS NOT NULL AND s.y IS NOT NULL
`;
const getBuildPlanetsByAllianceStmt = db.prepare(`SELECT ${BUILD_COLS} ${BUILD_FROM} AND p.alliance_id = @aid`);
const getBuildPlanetsByActiveUsersStmt = db.prepare(`SELECT ${BUILD_COLS} ${BUILD_FROM}
    AND LOWER(p.name) IN (SELECT LOWER(game_name) FROM app_users WHERE is_active = 1)`);
function getBuildPlanets(allianceId) {
    return allianceId ? getBuildPlanetsByAllianceStmt.all({ aid: allianceId }) : getBuildPlanetsByActiveUsersStmt.all({});
}

// One player's planets with saved PP — what the attacked planet's owner can put into its
// starbase before the attack lands.
const getOwnerPlanetsStmt = db.prepare(`SELECT ${BUILD_COLS} ${BUILD_FROM} AND p.id = ?`);
function getOwnerPlanets(ownerId) {
    return getOwnerPlanetsStmt.all(ownerId);
}

// A player's total experience, for the level he reaches by winning a fight (see
// levelAfter in src/utils/incoming-battle.js). By id when the report has it, else by name.
const getTotalXpByIdStmt = db.prepare(`SELECT total_xp FROM players WHERE id = ?`);
const getTotalXpByNameStmt = db.prepare(`SELECT total_xp FROM players WHERE LOWER(name) = ?`);
function getTotalXp({ id, nameLower }) {
    const row = (id && getTotalXpByIdStmt.get(id)) || (nameLower && getTotalXpByNameStmt.get(nameLower));
    return row && Number.isFinite(row.total_xp) ? row.total_xp : null;
}

module.exports = { getPlanetDefence, getGarrison, getAllyCombatRow, getBuildPlanets, getOwnerPlanets, getTotalXp };
