import '../utils/battle-model.js';
import '../utils/race-inference.js';
import '../utils/race-estimate-display.js';
import '../utils/sqlite-time.js';
const Display = globalThis.AWRaceEstimateDisplay;
const { formatLocalDateTime } = globalThis.AWSqliteTime;
const mounted = new WeakMap();

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function mountRaceEstimateCard(container, { playerId, hasBio = false, hasLiveIntel = false }) {
    if (mounted.has(container)) return mounted.get(container);
    const id = Number(playerId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const card = element('section', 'aw-race-estimate-card mb-3');
    card.setAttribute('aria-label', 'Stored race estimate');
    const heading = element('h3', 'h6', 'Stored race estimate');
    const status = element('p', 'small'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const traits = element('div', 'small');
    const details = element('details', 'small mb-2');
    details.appendChild(element('summary', '', 'Evidence, prior and AI check'));
    const explanation = element('div', 'mt-1'); details.appendChild(explanation);
    const gate = element('p', 'small');
    const retry = element('button', 'btn btn-sm btn-outline-secondary', 'Refresh saved estimate'); retry.type = 'button';
    const requestCheck = element('button', 'btn btn-sm btn-outline-secondary ms-2'); requestCheck.type = 'button';
    for (const node of [heading, status, traits, details, gate, retry, requestCheck]) card.appendChild(node);
    container.appendChild(card);
    let snapshot = null, busy = false, error = '', authFailed = false;
    let bioAvailable = !!hasBio || !!hasLiveIntel;
    function respectLiveIntel() {
        // The open profile may acquire stronger evidence before hub sync catches up.
        if (snapshot?.player?.has_intel || (typeof document.querySelectorAll === 'function'
            && [...document.querySelectorAll('.race-summary, .ir-summary')]
                .some(table => !table.closest('.overflow-auto')))) bioAvailable = true;
        return bioAvailable;
    }
    function render() {
        const locked = respectLiveIntel();
        card.setAttribute('aria-busy', String(busy));
        retry.disabled = busy || authFailed;
        requestCheck.hidden = locked || snapshot?.check_request_allowed !== true;
        requestCheck.disabled = busy || authFailed;
        const admin = snapshot?.viewer_role === 'admin';
        requestCheck.textContent = admin ? 'Run AI check (paid)' : 'Request AI check for admin approval';
        status.textContent = locked ? 'Observed intel is available; it remains authoritative.'
            : error || (busy ? 'Loading saved race estimate…' : !snapshot ? 'Saved estimate unavailable.'
            : snapshot.estimate ? `Estimate · ${Display.checkLabel(snapshot.check)}.`
                : snapshot.player?.has_intel ? 'Observed intel is available; it remains authoritative.'
                    : 'No member-visible estimate. Worst case remains in calculations.');
        traits.replaceChildren(); explanation.replaceChildren();
        details.hidden = locked || !snapshot?.estimate;
        if (!locked && snapshot?.estimate) {
            for (const [kind, label] of [['attack', 'Attack'], ['defence', 'Defence']]) {
                const trait = snapshot.estimate[kind];
                traits.appendChild(element('p', 'mb-1', `${label}: ${Display.traitText(trait, {
                    calibrated: snapshot.gate?.allowed === true, check: snapshot.check, kind,
                })}.`));
                if (!trait) continue;
                explanation.appendChild(element('p', 'mb-1', `${label} prior: ${trait.prior?.name || 'unavailable'}; hard compatible picks: ${Display.setText(trait.hard_candidates || [])}.`));
                if (admin && snapshot.gate?.allowed !== true) explanation.appendChild(element('p', 'mb-1',
                    `${label} raw posterior 90% mass set (uncalibrated): ${Display.setText(trait.credible_values || Display.credibleSet(trait))}.`));
                const updated = formatLocalDateTime(trait.estimated_at, undefined, 'unknown');
                explanation.appendChild(element('p', 'mb-1', `${label} estimate saved ${updated} (your local time).`));
            }
            const reportIds = [...new Set(['attack', 'defence'].flatMap(kind => snapshot.estimate[kind]?.evidence_report_ids || []))]
                .filter(reportId => Number.isSafeInteger(reportId) && reportId > 0);
            if (reportIds.length) {
                const reports = element('p', 'mb-1', 'Evidence reports: ');
                reportIds.slice(0, 20).forEach((reportId, index) => {
                    if (index) reports.appendChild(element('span', '', ', '));
                    const link = element('a', '', `#${reportId}`); link.href = `/About/BattleReport/${reportId}`; reports.appendChild(link);
                });
                if (reportIds.length > 20) reports.appendChild(element('span', '', `; ${reportIds.length - 20} more.`));
                explanation.appendChild(reports);
            }
            explanation.appendChild(element('p', 'mb-1', `AI check: ${Display.checkLabel(snapshot.check)}.`));
            if (typeof snapshot.check?.explanation === 'string') explanation.appendChild(element('p', 'mb-1', snapshot.check.explanation));
        }
        const state = snapshot?.gate;
        gate.textContent = state ? `Calculation gate: ${state.allowed ? 'calibration passed; a current agreeing AI check is still required' : 'display only'}. `
            + `${Number.isSafeInteger(state.players) ? state.players : 0}/30 calibrated players; ${Number.isSafeInteger(state.pairs) ? state.pairs : 0} pairs. `
            + (Array.isArray(state.reasons) ? state.reasons.filter(reason => typeof reason === 'string').map(reason => reason.replace(/_/g, ' ')).join('; ') : '')
            : '';
    }
    async function load() {
        if (busy || !card.isConnected) return;
        busy = true; error = ''; render();
        try {
            const response = await fetch(`/hub-api/intel/player/${id}/race-estimate`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
            if (!card.isConnected) return;
            if (response.status === 401 || response.status === 403) { authFailed = true; throw new Error('Your hub session cannot read this estimate. Sign in again and reload the profile.'); }
            if (!response.ok) throw new Error('Could not read the saved estimate. Refresh to retry.');
            const data = await response.json();
            if (!data || data.success !== true || Number(data.player?.id) !== id
                || (data.estimate && Number(data.estimate.player_id) !== id)) {
                throw new Error('The hub returned an invalid estimate. Refresh to retry.');
            }
            snapshot = data;
        } catch (err) { error = err instanceof Error ? err.message : 'Could not read the saved estimate.'; }
        finally { busy = false; if (card.isConnected) render(); }
    }
    async function askForCheck() {
        if (busy || snapshot?.check_request_allowed !== true || !card.isConnected || respectLiveIntel()) return;
        busy = true; error = ''; render();
        try {
            const admin = snapshot.viewer_role === 'admin';
            const endpoint = admin ? `/hub-api/admin/race/${id}/check` : `/hub-api/intel/race/${id}/check-request`;
            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await response.json().catch(() => null);
            if (!response.ok || data?.success !== true) throw new Error(typeof data?.error === 'string' ? data.error : 'The AI check request could not be submitted.');
            error = admin ? 'AI check completed. Refresh the saved estimate to read its result.' : 'AI check requested. A hub admin will review it before any paid call.';
        } catch (err) { error = err instanceof Error ? err.message : 'The AI check request failed.'; }
        finally { busy = false; if (card.isConnected) render(); }
    }
    retry.addEventListener('click', () => { void load(); });
    requestCheck.addEventListener('click', () => { void askForCheck(); });
    render();
    const controller = { ready: load(), refresh: load };
    mounted.set(container, controller);
    return controller;
}
