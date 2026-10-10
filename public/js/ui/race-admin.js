// A manual admin surface. GETs read stored results; only button handlers write or
// approve a provider call. All evidence and AI explanations render as text.
import '../utils/battle-model.js';
import '../utils/race-estimate-display.js';
const Display = globalThis.AWRaceEstimateDisplay;
const section = document.createElement('section');
section.className = 'flex flex-col gap-4';
section.setAttribute('aria-label', 'Race evidence and AI checks');
const heading = document.createElement('h2');
heading.className = 'text-xl font-bold border-b border-border pb-2';
heading.textContent = 'Race evidence and AI checks';
const status = document.createElement('p');
status.setAttribute('role', 'status');
status.className = 'text-sm text-muted-foreground';
const controls = document.createElement('div');
controls.className = 'flex flex-wrap gap-3';
const content = document.createElement('div');
content.className = 'flex flex-col gap-4';
section.append(heading, status, controls, content);
document.querySelector('main')?.append(section);

function node(tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
}
function button(text, action, refresh = true) {
    const element = node('button', text, 'rounded border border-border px-3 py-2 text-sm hover:bg-secondary');
    element.type = 'button';
    element.addEventListener('click', async () => {
        element.disabled = true;
        try { await action(); if (refresh) await load(); }
        catch (error) { status.textContent = error.message; }
        finally { element.disabled = false; }
    });
    return element;
}
async function request(path, body) {
    const response = await fetch(`/hub-api${path}`, body === undefined
        ? { headers: { Accept: 'application/json' } }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(result.error || 'Could not complete this action.');
    return result;
}
controls.append(button('Refresh', () => Promise.resolve()), button('Recompute stored evidence', () => request('/admin/race/recompute', {})));

function probabilityTable(estimate) {
    const table = document.createElement('table');
    table.className = 'w-full text-sm text-left';
    const head = document.createElement('tr');
    for (const title of ['Trait', 'Compatible range', 'Evidence band', 'Evidence', 'Prior-based probabilities −4…+4']) head.append(node('th', title, 'p-2'));
    table.append(head);
    for (const [name, key] of [['Attack', 'attack'], ['Defence', 'defence']]) {
        const trait = estimate[key];
        const row = document.createElement('tr');
        const values = Array.isArray(trait?.dist) ? trait.dist.map((p, index) => `${index - 4}: ${(p * 100).toFixed(1)}%`).join(' · ') : 'No data';
        const compatible = Display.compatibleSet(trait);
        const range = trait?.band !== 'none' ? `estimate ${compatible.length === 1 ? '~' : ''}${Display.setText(compatible)}` : 'estimate unavailable';
        for (const text of [name, range, trait?.band || 'none', String(trait?.evidence_count || 0), values]) row.append(node('td', text, 'p-2 border-t border-border'));
        table.append(row);
    }
    return table;
}

async function inspect(card, id) {
    const result = await request(`/admin/race/${id}`);
    let box = card.querySelector('[data-race-detail]');
    if (!box) { box = document.createElement('div'); box.dataset.raceDetail = ''; card.append(box); }
    box.replaceChildren();
    if (!result.evidence?.length) { box.append(node('p', 'No usable stored observations.', 'text-sm')); return; }
    for (const evidence of result.evidence) {
        const line = document.createElement('div');
        line.className = 'flex flex-wrap items-center gap-2 border-t border-border py-2 text-sm';
        line.append(node('span', `Report #${evidence.battle_report_id} · ${evidence.kind} · ${evidence.status}`));
        line.append(button(evidence.status === 'excluded' ? 'Include' : 'Exclude', () => request(`/admin/race/evidence/${evidence.id}`,
            { status: evidence.status === 'excluded' ? 'ok' : 'excluded' })));
        box.append(line);
    }
}

let loading = false;
async function load() {
    if (loading) return;
    loading = true;
    status.textContent = 'Loading stored race evidence…';
    try {
        const [data, approvals, usage] = await Promise.all([
            request('/admin/race'), request('/admin/race/check-requests'), request('/admin/llm-usage'),
        ]);
        const calibration = data.calibration || {};
        const high = calibration.high_accuracy == null ? 'not measured' : `${(100 * calibration.high_accuracy).toFixed(1)}%`;
        const error = calibration.calibration_error_pp == null ? 'not measured' : `${calibration.calibration_error_pp.toFixed(1)} pp`;
        const coverage = calibration.credible_coverage == null ? 'not measured' : `${(100 * calibration.credible_coverage).toFixed(1)}%`;
        status.textContent = `${calibration.passed ? 'Calibration passed' : 'Shadow calibration'}: ${calibration.players || 0}/30 players, ${calibration.pairs || 0} pairs · error ${error} · high accuracy ${high} · raw 90% set coverage ${coverage} (required 88–92%). Calculations also require a current agreeing AI check.`;
        content.replaceChildren();
        const accounting = node('p', `AI ${usage.enabled ? 'enabled' : 'off'} · daily cost accounting: $${Number(usage.today?.cost_usd || 0).toFixed(4)} / $${Number(usage.daily_budget_usd || 0).toFixed(2)}. Provider calls need a manual admin action.`, 'text-sm text-muted-foreground');
        content.append(accounting);
        const queue = approvals.requests || approvals.queue || [];
        const pending = queue.filter(item => ['pending', 'approved'].includes(item.status));
        const approvalsBox = document.createElement('div');
        approvalsBox.className = 'rounded border border-border p-4';
        approvalsBox.append(node('h3', 'Approval queue', 'font-semibold mb-2'));
        if (!pending.length) approvalsBox.append(node('p', 'No pending requests.', 'text-sm'));
        for (const item of pending) {
            const line = document.createElement('div'); line.className = 'flex flex-wrap gap-2 items-center py-2';
            line.append(node('span', `Request #${item.id} · player #${item.player_id} · ${item.status}`, 'text-sm'));
            const approve = button(item.status === 'approved' ? 'Retry approved AI check' : 'Approve AI check', () => request(`/admin/race/check-requests/${item.id}/approve`, {}));
            approve.disabled = !usage.enabled;
            line.append(approve, button('Reject', () => request(`/admin/race/check-requests/${item.id}/reject`, {})));
            approvalsBox.append(line);
        }
        content.append(approvalsBox);
        if (!data.estimates?.length) content.append(node('p', 'No estimates stored yet. Recompute reads existing reports only.', 'text-sm'));
        for (const estimate of data.estimates || []) {
            const card = document.createElement('article'); card.className = 'rounded border border-border p-4 overflow-x-auto';
            card.append(node('h3', `Player #${estimate.player_id} · estimate`, 'font-semibold mb-2'), probabilityTable(estimate));
            const actions = document.createElement('div'); actions.className = 'flex flex-wrap gap-2 mt-3';
            const ai = button('Run AI check', () => request(`/admin/race/${estimate.player_id}/check`, {}));
            ai.disabled = !usage.enabled;
            actions.append(button('View evidence', () => inspect(card, estimate.player_id), false),
                button('Recompute', () => request('/admin/race/recompute', { player_id: estimate.player_id })), ai);
            card.append(actions);
            const display = await request(`/intel/player/${estimate.player_id}/race-estimate`);
            const check = display.check || {};
            card.append(node('p', `AI check: ${check.state || 'not_checked'}`, 'text-sm mt-3'));
            if (check.explanation) card.append(node('p', `AI-written explanation: ${check.explanation}`, 'text-sm mt-1'));
            if (check.state === 'held') actions.append(
                button('Release hold', () => request(`/admin/race/${estimate.player_id}/check/resolve`, { decision: 'release' })),
                button('Keep hold', () => request(`/admin/race/${estimate.player_id}/check/resolve`, { decision: 'keep' })));
            content.append(card);
        }
    } catch (error) { status.textContent = error.message; }
    finally { loading = false; }
}

window.loadRaceAdmin = load;
if (document.body.style.display === 'block') load();
