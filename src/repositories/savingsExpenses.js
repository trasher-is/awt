// My Savings' planned expenses (savings_expenses in database.js). Every statement is scoped
// by user_id, so one member can never read, change or delete another member's rows.
const db = require('../database');

const listStmt = db.prepare(`SELECT id, amount, due_at FROM savings_expenses WHERE user_id = ? ORDER BY due_at, id`);
const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM savings_expenses WHERE user_id = ?`);
const insertStmt = db.prepare(`INSERT INTO savings_expenses (user_id, amount, due_at) VALUES (?, ?, ?)`);
const getStmt = db.prepare(`SELECT id, amount, due_at FROM savings_expenses WHERE id = ? AND user_id = ?`);
const updateStmt = db.prepare(`UPDATE savings_expenses SET amount = ?, due_at = ? WHERE id = ? AND user_id = ?`);
const deleteStmt = db.prepare(`DELETE FROM savings_expenses WHERE id = ? AND user_id = ?`);

function listExpenses(userId) { return listStmt.all(userId); }
function countExpenses(userId) { return countStmt.get(userId).n; }
function createExpense(userId, amount, dueAt) {
    const info = insertStmt.run(userId, amount, dueAt);
    return getStmt.get(info.lastInsertRowid, userId);
}
function getExpense(id, userId) { return getStmt.get(id, userId); }
function updateExpense(id, userId, amount, dueAt) {
    return updateStmt.run(amount, dueAt, id, userId).changes > 0 ? getStmt.get(id, userId) : null;
}
function deleteExpense(id, userId) { return deleteStmt.run(id, userId).changes > 0; }

module.exports = { listExpenses, countExpenses, createExpense, getExpense, updateExpense, deleteExpense };
