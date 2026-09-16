// The collapsed system-plan panel's HTML, pure and DOM-free — same UMD pattern as
// fleet-launch-target-dossier.js and manual-intel-form.js, for the same reason: this is the
// part worth testing in Node, and page-injections.js's own DOM wiring (where to insert it,
// the click-to-expand toggle) is not.
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AWSystemPlanPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // `formatUpdatedAt` is injected rather than imported: sqlite-time.js's formatSqliteUtc
    // already handles the UTC-no-zone-marker parsing every other timestamp in the hub goes
    // through, and this module has no reason to duplicate that rather than take the result.
    //
    // `isAdmin` adds the ✏️/🗑️ buttons (2026-09-16e — the web equivalent of !splan's own
    // Edit/Delete buttons, so a plan is no longer editable ONLY from Discord). They sit
    // next to the collapse chevron, not inside the collapsible body, so an admin can act on
    // a plan without needing to expand it first — and the DOM wiring must stopPropagation
    // on their clicks, or a click meant for Edit would also toggle the collapse.
    function buildSystemPlanHtml(plan, { formatUpdatedAt, isAdmin } = {}) {
        const updated = typeof formatUpdatedAt === 'function' ? formatUpdatedAt(plan.updated_at) : '';
        const byline = plan.was_edited
            ? `by ${esc(plan.author_name || 'unknown')}, last edited by ${esc(plan.last_edited_by_name || 'unknown')}`
            : `by ${esc(plan.author_name || 'unknown')}`;

        const adminButtons = isAdmin ? `
                    <span style="display:flex;gap:4px;">
                        <button type="button" data-aw-splan-edit-btn title="Edit" style="background:none;border:1px solid #555;border-radius:3px;color:#eee;cursor:pointer;padding:1px 6px;font-size:0.85em;">✏️</button>
                        <button type="button" data-aw-splan-delete-btn title="Delete" style="background:none;border:1px solid #555;border-radius:3px;color:#eee;cursor:pointer;padding:1px 6px;font-size:0.85em;">🗑️</button>
                    </span>` : '';

        return `
        <div class="col-md-12">
            <div class="mt-2" style="border:1px solid #444;border-radius:4px;background:#1a1a1a;">
                <div data-aw-splan-toggle role="button" style="cursor:pointer;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <span><i class="bi bi-clipboard2-check me-2"></i><strong>System Plan</strong>
                        <span style="color:#888;font-size:0.85em;margin-left:6px;">${byline}${updated ? ` &middot; ${esc(updated)}` : ''}</span>
                    </span>
                    <span style="display:flex;align-items:center;gap:8px;">${adminButtons}<i class="bi bi-chevron-down" data-aw-splan-chevron></i></span>
                </div>
                <div data-aw-splan-body style="display:none;padding:0 10px 10px;white-space:pre-wrap;">${esc(plan.note)}</div>
            </div>
        </div>`;
    }

    // The inline editor: a textarea pre-filled with the current note (empty for a brand-new
    // plan), matching !splan's own Edit modal — "give a text to edit, so you don't have to
    // rewrite it all" was the actual feature request behind the Discord version, and the web
    // editor exists for the same reason, in the same place the plan is already displayed.
    function buildSystemPlanEditFormHtml(note) {
        return `
        <div class="col-md-12" data-aw-splan-editor>
            <div class="mt-2" style="border:1px solid #556;border-radius:4px;background:#15151c;padding:8px;">
                <div style="font-weight:bold;margin-bottom:6px;">Edit system plan</div>
                <textarea data-aw-splan-textarea rows="4" maxlength="4000"
                    style="width:100%;background:#111;color:#eee;border:1px solid #444;border-radius:3px;padding:6px;font-family:inherit;resize:vertical;">${esc(note || '')}</textarea>
                <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
                    <button type="button" data-aw-splan-save-btn class="btn btn-sm btn-success">Save</button>
                    <button type="button" data-aw-splan-cancel-btn class="btn btn-sm btn-secondary">Cancel</button>
                    <span data-aw-splan-status style="font-size:11px;color:#aaa;"></span>
                </div>
            </div>
        </div>`;
    }

    // Shown to admins in place of the panel entirely when nothing has been written for this
    // system yet — the toggle/body markup above only renders once a plan actually exists.
    function buildAddPlanPromptHtml() {
        return `
        <div class="col-md-12">
            <button type="button" data-aw-splan-add-btn class="btn btn-sm btn-outline-info mt-2">
                <i class="bi bi-clipboard2-plus me-1"></i>Add a system plan
            </button>
        </div>`;
    }

    function readSystemPlanEditForm(root) {
        const el = root.querySelector('[data-aw-splan-textarea]');
        return el ? el.value.trim() : '';
    }

    return { buildSystemPlanHtml, buildSystemPlanEditFormHtml, buildAddPlanPromptHtml, readSystemPlanEditForm, esc };
});
