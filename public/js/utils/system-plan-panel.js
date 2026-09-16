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
    function buildSystemPlanHtml(plan, { formatUpdatedAt } = {}) {
        const updated = typeof formatUpdatedAt === 'function' ? formatUpdatedAt(plan.updated_at) : '';
        const byline = plan.was_edited
            ? `by ${esc(plan.author_name || 'unknown')}, last edited by ${esc(plan.last_edited_by_name || 'unknown')}`
            : `by ${esc(plan.author_name || 'unknown')}`;

        return `
        <div class="col-md-12">
            <div class="mt-2" style="border:1px solid #444;border-radius:4px;background:#1a1a1a;">
                <div data-aw-splan-toggle role="button" style="cursor:pointer;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <span><i class="bi bi-clipboard2-check me-2"></i><strong>System Plan</strong>
                        <span style="color:#888;font-size:0.85em;margin-left:6px;">${byline}${updated ? ` &middot; ${esc(updated)}` : ''}</span>
                    </span>
                    <i class="bi bi-chevron-down" data-aw-splan-chevron></i>
                </div>
                <div data-aw-splan-body style="display:none;padding:0 10px 10px;white-space:pre-wrap;">${esc(plan.note)}</div>
            </div>
        </div>`;
    }

    return { buildSystemPlanHtml, esc };
});
