const db = require('../database');

// Shape used by intel.js's system-intel panel (no updated_at).
const getPlansForSystemStmt = db.prepare(`
    SELECT p.planet_index, p.note, u.game_name as author
    FROM planet_plans p
    LEFT JOIN app_users u ON p.author_id = u.id
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

// Plans worth showing an "optimal colony ship launch time" for: the target planet must
// have a confirmed-empty row in `planets` (owner_id IS NULL covers both a genuine Free
// Planet and the game's real "Unknown" owner state alike — see routes/sync.js's 2026-09-02
// fix, both are equally colonizable) AND that row must actually exist (a plan on a planet
// the hub has never scanned is excluded — "confirmed empty", not "presumed empty", since a
// stale/never-synced row could just as easily be someone's active home).
const getColonizablePlansStmt = db.prepare(`
    SELECT pp.system_id, pp.planet_index, pp.note, s.name AS system_name, s.x, s.y
    FROM planet_plans pp
    JOIN planets p ON p.system_id = pp.system_id AND p.planet_index = pp.planet_index
    JOIN systems s ON s.id = pp.system_id
    WHERE p.owner_id IS NULL AND s.x IS NOT NULL AND s.y IS NOT NULL
`);
function getColonizablePlans() {
    return getColonizablePlansStmt.all();
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
    getColonizablePlans,
    createPlan, deletePlanAsAdmin, deletePlanAsAuthor, planExists, deleteAllPlans,
};
