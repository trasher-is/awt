const db = require('../database');

const deleteAllBattleReportsStmt = db.prepare(`DELETE FROM battle_reports`);
function deleteAllBattleReports() {
    return deleteAllBattleReportsStmt.run().changes;
}

const getPendingAnnouncementsStmt = db.prepare(
    `SELECT * FROM battle_reports WHERE announced = 0 ORDER BY started_at ASC, id ASC`
);
function getPendingAnnouncements() {
    return getPendingAnnouncementsStmt.all();
}

const markAnnouncedStmt = db.prepare(`UPDATE battle_reports SET announced = 1 WHERE id = ?`);
function markAnnounced(id) {
    markAnnouncedStmt.run(id);
}

const getNewestStartedAtStmt = db.prepare(`SELECT MAX(started_at) AS newest FROM battle_reports`);
function getNewestStartedAt() {
    return getNewestStartedAtStmt.get().newest || null;
}

module.exports = { deleteAllBattleReports, getPendingAnnouncements, markAnnounced, getNewestStartedAt };
