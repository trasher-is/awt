// system_plans: ONE evolving note per system, not a log — see database.js's schema comment
// for why this is a separate table from planet_plans rather than a reuse of it. Written
// through !splan (discord_bot.js) and, since 2026-09-16e, the web panel's own inline editor
// (routes/intel.js) — both admin-gated, both sharing this repository and the length cap
// below so the two paths can never quietly drift apart.
const db = require('../database');

// Discord's own cap on a Paragraph text input (the !splan Edit modal) — the web editor and
// the plain-text !splan write path both enforce the SAME limit, so nothing ever gets
// written from one surface that the other couldn't later reopen.
const SYSTEM_PLAN_MAX_LENGTH = 4000;

// was_edited comes from edit_count, not a created_at/updated_at comparison — SQLite's
// CURRENT_TIMESTAMP only has one second of resolution, so a real edit landing in the same
// second as the original write would read updated_at == created_at and be misreported as
// unedited. See database.js's schema comment; edit_count only ever moves on an UPDATE.
const getSystemPlanStmt = db.prepare(`
    SELECT sp.system_id, sp.note, sp.created_at, sp.updated_at,
           author.game_name AS author_name,
           editor.game_name AS last_edited_by_name,
           (sp.edit_count > 0) AS was_edited
    FROM system_plans sp
    LEFT JOIN app_users author ON author.id = sp.author_id
    LEFT JOIN app_users editor ON editor.id = sp.last_edited_by
    WHERE sp.system_id = ?
`);
function getSystemPlan(systemId) {
    const row = getSystemPlanStmt.get(systemId);
    return row ? { ...row, was_edited: !!row.was_edited } : null;
}

// Upsert rather than separate create/update (2026-09-16): !splan <system_id> <text> is the
// one command for both "write it for the first time" and "replace it" — the button-driven
// edit modal is the ergonomic path for a small tweak, but the plain command must still work
// as a blunt overwrite, and a caller should never need to know in advance which case they're
// in. author_id is set ONLY on the first insert (excluded.author_id is never referenced in
// the UPDATE branch), so the original writer's credit survives every later edit; updated_at
// and last_edited_by move on every write, insert included, so a same-second read after
// creation is consistent — see getSystemPlanStmt's was_edited comment above.
const upsertSystemPlanStmt = db.prepare(`
    INSERT INTO system_plans (system_id, note, author_id, last_edited_by, created_at, updated_at)
    VALUES (@system_id, @note, @editor_id, @editor_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(system_id) DO UPDATE SET
        note = excluded.note,
        last_edited_by = excluded.last_edited_by,
        edit_count = system_plans.edit_count + 1,
        updated_at = CURRENT_TIMESTAMP
`);
function upsertSystemPlan(systemId, note, editorUserId) {
    upsertSystemPlanStmt.run({ system_id: systemId, note, editor_id: editorUserId });
    return getSystemPlan(systemId);
}

const deleteSystemPlanStmt = db.prepare(`DELETE FROM system_plans WHERE system_id = ?`);
function deleteSystemPlan(systemId) {
    return deleteSystemPlanStmt.run(systemId).changes > 0;
}

module.exports = { getSystemPlan, upsertSystemPlan, deleteSystemPlan, SYSTEM_PLAN_MAX_LENGTH };
