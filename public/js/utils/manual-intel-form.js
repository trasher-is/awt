// The "type in an ally's screenshot" form for a player's Intelligence Report.
//
// WHY IT LOOKS LIKE THE GAME'S OWN TABLE: whoever fills this in is reading a screenshot of
// the game's Intelligence Report and Race Summary while they type. Same field order, same
// labels, same two-traits-per-row race grid — so it can be copied straight down without
// hunting for which box is which, and a skipped row is visible as a gap in the same shape.
//
// WHY SOURCE IS A FIELD AND NOT A COMMENT: these values land in exactly the columns a real
// capture writes, and they are read by the threat matrix, the battle calculator and !bio.
// Second-hand data that cannot be told apart from our own is worse than no data, because it
// is trusted at the moment it matters and nobody can judge its age. The form will not submit
// without it, and every place the values are shown says where they came from.
//
// Pure and DOM-free on purpose (the UMD wrapper is the same one sqlite-time.js and
// fleet-launch-target-dossier.js use), so the layout and the read-back can be exercised in
// Node — see src/utils/manual-intel-form.test.js.
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.AWManualIntelForm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // Mirrors the game's Intelligence Report rows, in its order. Trade Revenue and Artefact
    // are last there too.
    const SCIENCE_FIELDS = [
        { field: 'biology', label: 'Biology' },
        { field: 'economy', label: 'Economy' },
        { field: 'energy', label: 'Energy' },
        { field: 'mathematics', label: 'Mathematics' },
        { field: 'physics', label: 'Physics' },
        { field: 'social', label: 'Social' },
    ];

    // The game shows two traits per row with Defence alone at the end, and prints each as
    // "-16% Growth -2" — the percentage is derived, the PICK (-2) is the number worth typing,
    // so that is what the form asks for. race_trader and race_sul are absent because the
    // Race Summary does not show them: a screenshot cannot contain them and a 0 would be a
    // fabrication rather than a reading.
    const RACE_FIELDS = [
        { field: 'race_growth', label: 'Growth' },
        { field: 'race_science', label: 'Science' },
        { field: 'race_culture', label: 'Culture' },
        { field: 'race_production', label: 'Production' },
        { field: 'race_speed', label: 'Speed' },
        { field: 'race_attack', label: 'Attack' },
        { field: 'race_defense', label: 'Defence' },
    ];

    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : '');

    function numberCell(f, value, min, max) {
        return `<td style="padding:2px 4px;">
            <input type="number" data-mi="${f.field}" value="${esc(num(value))}" min="${min}" max="${max}" step="1"
                   style="width:70px;background:#111;color:#eee;border:1px solid #444;border-radius:3px;padding:2px 4px;">
        </td>`;
    }

    // Prefilled from whatever is already on record, so correcting one wrong number in an
    // existing entry does not mean retyping all fifteen.
    function buildManualIntelFormHtml(player = {}) {
        const p = player || {};
        const sciRows = SCIENCE_FIELDS.map(f => `
            <tr><td style="padding:2px 4px;">${esc(f.label)}</td>${numberCell(f, p[f.field], 0, 99)}</tr>`).join('');

        const raceRows = [[0, 1], [2, 3], [4, 5], [6, null]].map(([a, b]) => {
            const fa = RACE_FIELDS[a], fb = b == null ? null : RACE_FIELDS[b];
            return `<tr>
                <td style="padding:2px 4px;">${esc(fa.label)}</td>${numberCell(fa, p[fa.field], -10, 10)}
                <td style="padding:2px 4px;">${fb ? esc(fb.label) : ''}</td>${fb ? numberCell(fb, p[fb.field], -10, 10) : '<td></td>'}
            </tr>`;
        }).join('');

        return `
        <div class="aw-manual-intel" style="border:1px solid #556;border-radius:4px;padding:8px;margin-bottom:8px;background:#15151c;">
            <div style="font-weight:bold;margin-bottom:6px;">Enter intel from a screenshot</div>
            <table class="table" style="margin-bottom:6px;"><tbody>
                ${sciRows}
                <tr><td style="padding:2px 4px;">Trade Revenue %</td><td style="padding:2px 4px;">
                    <input type="number" data-mi="trade_revenue" value="${esc(num(p.trade_revenue))}" min="0" max="999" step="1"
                           style="width:70px;background:#111;color:#eee;border:1px solid #444;border-radius:3px;padding:2px 4px;"></td></tr>
                <tr><td style="padding:2px 4px;">Artefact</td><td style="padding:2px 4px;">
                    <input type="text" data-mi="artefact" value="${esc(p.artefact || '')}" placeholder="N/A" maxlength="100"
                           style="width:140px;background:#111;color:#eee;border:1px solid #444;border-radius:3px;padding:2px 4px;"></td></tr>
            </tbody></table>
            <table class="table" style="margin-bottom:6px;">
                <thead><tr><th colspan="4">Race Summary (the pick, e.g. -2)</th></tr></thead>
                <tbody>${raceRows}</tbody>
            </table>
            <div style="margin-bottom:6px;">
                <label style="display:block;font-size:11px;color:#aaa;margin-bottom:2px;">
                    Where did this come from? (required — it is shown wherever these numbers are)
                </label>
                <input type="text" data-mi="source" value="${esc(p.intel_source || '')}" maxlength="200"
                       placeholder="e.g. screenshot from Glutus [PUNK]"
                       style="width:100%;background:#111;color:#eee;border:1px solid #444;border-radius:3px;padding:3px 5px;">
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
                <button type="button" data-mi-action="save" class="btn btn-sm btn-success">Save intel</button>
                <button type="button" data-mi-action="cancel" class="btn btn-sm btn-secondary">Cancel</button>
                <span data-mi-status style="font-size:11px;color:#aaa;"></span>
            </div>
        </div>`;
    }

    // Reads the form back into the POST body. Blank number boxes become 0 rather than being
    // dropped: the game prints a real 0 for an untaken trait or an unresearched science, and
    // a missing key would fail the server's validation with a message about a field the
    // member left blank on purpose. Source is sent as typed and checked server-side, so the
    // rule lives in exactly one place.
    function readManualIntelForm(root, playerId) {
        const get = (name) => {
            const el = root.querySelector(`[data-mi="${name}"]`);
            return el ? el.value : '';
        };
        const body = { player_id: playerId, source: String(get('source') || '').trim() };
        for (const f of [...SCIENCE_FIELDS, ...RACE_FIELDS]) {
            const raw = String(get(f.field) || '').trim();
            body[f.field] = raw === '' ? 0 : Number(raw);
        }
        const trade = String(get('trade_revenue') || '').trim();
        body.trade_revenue = trade === '' ? 0 : Number(trade);
        body.artefact = String(get('artefact') || '').trim();
        return body;
    }

    return { buildManualIntelFormHtml, readManualIntelForm, SCIENCE_FIELDS, RACE_FIELDS, esc };
});
