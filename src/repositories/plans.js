const db = require('../database');

// Shape used by intel.js's system-intel panel (no updated_at). next_culture_at rides along
// (sidebar "next culture" countdown) via app_users.game_name -> players.name -> the author's
// row in alliance_member_stats — the same name-matching chain getCanonicalNameFromStats
// relies on elsewhere. It's null whenever the author isn't a tracked alliance member (or has
// no stats scraped yet), which the frontend must treat as "unknown", not "ready".
const getPlansForSystemStmt = db.prepare(`
    SELECT p.planet_index, p.note, u.game_name as author, ams.next_culture_at
    FROM planet_plans p
    LEFT JOIN app_users u ON p.author_id = u.id
    LEFT JOIN players pl ON pl.name = u.game_name COLLATE NOCASE
    LEFT JOIN alliance_member_stats ams ON ams.player_id = pl.id
    WHERE p.system_id = ?
`);
function getPlansForSystem(sysId) {
    return getPlansForSystemStmt.all(sysId);
}

// Shape used by search.js's GET /plans/:systemId (includes updated_at). Kept separate from
// getPlansForSystem per Global Constraints — same query, different column list.
const getPlansForSystemDetailedStmt = db.prepare(`
    SELECT p.planet_index, p.note, p.updated_at, u.game_name as author
    FROM planet_plans p
    LEFT JOIN app_users u ON p.author_id = u.id
    WHERE p.system_id = ?
`);
function getPlansForSystemDetailed(sysId) {
    return getPlansForSystemDetailedStmt.all(sysId);
}

const getPlansForSystemForBotStmt = db.prepare(`
    SELECT pp.*, u.game_name as author_name
    FROM planet_plans pp
    LEFT JOIN app_users u ON pp.author_id = u.id
    WHERE pp.system_id = ?
`);
function getPlansForSystemForBot(sysId) {
    return getPlansForSystemForBotStmt.all(sysId);
}

const getAllPlanIndexStmt = db.prepare(`SELECT system_id, planet_index FROM planet_plans`);
function getAllPlanIndex() {
    return getAllPlanIndexStmt.all();
}

// Plans to show a launch window for on the Science page: every plan this member authored,
// whatever currently sits on the target. Scoped to ONE author (2026-09-02, per the user: "I
// don't want to launch to other people's Plans, only to mine, everyone should see their
// own planned planet times").
//
// This used to require a confirmed-empty planets row (owner_id IS NULL). That hid exactly
// the plans members care about most: on 2026-09-25 a member's target turned out to be held
// by another player, so his launch window vanished with no explanation. A colonization
// force can take an occupied planet as well as settle a free one, and the culture slot has
// to be open on landing either way, so the timing question is the same. owner_name is
// returned so the page can say the landing will be contested. A planet the hub has never
// scanned is included too (LEFT JOIN): travel time only needs the system's coordinates.
const getLaunchWindowPlansStmt = db.prepare(`
    SELECT pp.system_id, pp.planet_index, pp.note, s.name AS system_name, s.x, s.y,
           owner.name AS owner_name
    FROM planet_plans pp
    JOIN systems s ON s.id = pp.system_id
    LEFT JOIN planets p ON p.system_id = pp.system_id AND p.planet_index = pp.planet_index
    LEFT JOIN players owner ON owner.id = p.owner_id
    WHERE pp.author_id = ? AND s.x IS NOT NULL AND s.y IS NOT NULL
    ORDER BY pp.system_id, pp.planet_index
`);
function getLaunchWindowPlans(authorId) {
    return getLaunchWindowPlansStmt.all(authorId);
}

// Used by both search.js's POST /plans and discord_bot.js's !plan command — a genuine
// duplicate in the original code, safe to share (identical SQL and parameter order in both
// call sites).
const createPlanStmt = db.prepare(`
    INSERT INTO planet_plans (system_id, planet_index, author_id, note)
    VALUES (?, ?, ?, ?)
`);
function createPlan(systemId, planetIndex, authorId, note) {
    createPlanStmt.run(systemId, planetIndex, authorId, note);
}

const deletePlanAsAdminStmt = db.prepare(`DELETE FROM planet_plans WHERE system_id = ? AND planet_index = ?`);
function deletePlanAsAdmin(systemId, planetIndex) {
    return deletePlanAsAdminStmt.run(systemId, planetIndex);
}

const deletePlanAsAuthorStmt = db.prepare(`
    DELETE FROM planet_plans
    WHERE system_id = ? AND planet_index = ? AND (author_id = ? OR author_id IS NULL)
`);
function deletePlanAsAuthor(systemId, planetIndex, authorId) {
    return deletePlanAsAuthorStmt.run(systemId, planetIndex, authorId);
}

const planExistsStmt = db.prepare(`SELECT 1 FROM planet_plans WHERE system_id = ? AND planet_index = ?`);
function planExists(systemId, planetIndex) {
    return !!planExistsStmt.get(systemId, planetIndex);
}

const deleteAllPlansStmt = db.prepare(`DELETE FROM planet_plans`);
function deleteAllPlans() {
    deleteAllPlansStmt.run();
}

module.exports = {
    getPlansForSystem, getPlansForSystemDetailed, getPlansForSystemForBot, getAllPlanIndex,
    getLaunchWindowPlans,
    createPlan, deletePlanAsAdmin, deletePlanAsAuthor, planExists, deleteAllPlans,
};
