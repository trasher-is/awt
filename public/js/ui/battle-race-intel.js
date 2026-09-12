// Battle-derived race evidence stays separate from confirmed biology intel. This card
// never writes the race/science fields and never presents model compatibility as a
// calibrated probability. All requests stay on the hub's own stored reports.
import '../utils/sqlite-time.js';
const { formatLocalDateTime } = globalThis.AWSqliteTime;

const mounted = new WeakMap();

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function liveIntelVisible() {
    return [...document.querySelectorAll('.race-summary, .ir-summary')]
        .some(table => !table.closest('.overflow-auto'));
}

function candidateText(defense) {
    if (defense?.status === 'conflicting') return 'No compatible pick; reports disagree with the model.';
    const values = defense?.candidates;
    if (defense?.status !== 'compatible' || !Array.isArray(values) || !values.length || values.length >= 9
        || values.some(value => !Number.isInteger(value) || value < -4 || value > 4)) {
        return 'Not enough evidence to narrow the picks.';
    }
    return [...new Set(values)].sort((a, b) => a - b)
        .map(value => value >= 0 ? `+${value}` : String(value)).join(', ');
}

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function percentRange(range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min > range.max) return null;
    const percent = value => `${value < 0 ? '−' : '+'}${Math.abs(value)}%`;
    return range.min === range.max ? percent(range.min) : `${percent(range.min)} to ${percent(range.max)}`;
}

export function mountBattleRaceIntel(container, { playerId, hasBio = false, hasLiveIntel = false }) {
    if (mounted.has(container)) return mounted.get(container);
    const id = Number(playerId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const card = element('section', 'aw-battle-race-intel mb-3');
    card.setAttribute('aria-label', 'Race evidence from battle reports');
    const table = element('table', 'table mb-2');
    const head = element('thead');
    const headRow = element('tr');
    headRow.appendChild(element('th', '', 'Race evidence from battle reports'));
    head.appendChild(headRow);
    table.appendChild(head);
    const tbody = element('tbody');
    const row = element('tr');
    const body = element('td');
    const status = element('p', 'mb-2');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const attack = element('p', 'mb-1');
    const defense = element('p', 'mb-1');
    const evidence = element('p', 'small mb-2');
    const details = element('details', 'small mb-2');
    details.appendChild(element('summary', '', 'How this is estimated'));
    const explanation = element('div', 'mt-1');
    details.appendChild(explanation);
    const controls = element('div', 'd-flex flex-wrap gap-2');
    const update = element('button', 'btn btn-sm btn-outline-secondary', 'Update from battle reports');
    update.type = 'button';
    const retry = element('button', 'btn btn-sm btn-outline-secondary', 'Retry');
    retry.type = 'button';
    controls.appendChild(update);
    controls.appendChild(retry);
    for (const node of [status, attack, defense, evidence, details, controls]) body.appendChild(node);
    row.appendChild(body);
    tbody.appendChild(row);
    table.appendChild(tbody);
    card.appendChild(table);
    container.appendChild(card);

    let locked = !!hasBio || !!hasLiveIntel;
    let busy = false;
    let loaded = false;
    let authFailed = false;
    let error = '';
    let inference = null;
    let retryMethod = 'GET';
    const endpoint = `/hub-api/intel/player/${id}/battle-race-inference`;

    function render() {
        if (!card.isConnected) return;
        card.setAttribute('aria-busy', String(busy));
        update.disabled = locked || busy || !loaded || authFailed;
        update.title = locked ? 'Bio intel is already available and cannot be overwritten.' : '';
        retry.hidden = !error || authFailed || locked;
        retry.disabled = busy;
        attack.hidden = defense.hidden = evidence.hidden = details.hidden = locked || !inference;
        if (locked) {
            status.textContent = 'Bio intel is available. Battle estimates cannot replace it.';
            attack.textContent = defense.textContent = evidence.textContent = '';
            explanation.replaceChildren();
            return;
        }
        status.textContent = error || (busy
            ? (loaded ? 'Analyzing stored battle reports…' : 'Loading battle evidence…')
            : inference ? 'Conditional estimate only; these picks are not confirmed by bio intel.'
                : 'No estimate saved. Update to analyze the reports stored in the hub.');
        if (!inference) return;
        const attackRange = percentRange(inference.attack?.bonus_percent_range);
        const defenseRange = inference.defense?.status === 'conflicting' ? null : percentRange(inference.defense?.bonus_percent_range);
        attack.textContent = `Attack: ${attackRange ? `${attackRange} — unresolved.` : 'Not identifiable from stored reports.'}`;
        defense.textContent = `Defence: ${defenseRange
            ? `${defenseRange} — ${inference.defense?.status === 'compatible' ? 'conditional range' : 'unresolved'}.`
            : candidateText(inference.defense)}`;
        const total = count(inference.report_count);
        const eligible = count(inference.eligible_report_count);
        evidence.textContent = `${eligible} eligible of ${total} stored report${total === 1 ? '' : 's'}.`;
        const updatedAt = formatLocalDateTime(inference.updated_at, undefined, '');
        if (updatedAt) evidence.textContent += ` Updated ${updatedAt}.`;
        const notes = [`Compatible DEF picks: ${candidateText(inference.defense)}`, inference.attack?.reason, inference.defense?.reason,
            ...(Array.isArray(inference.assumptions) ? inference.assumptions : [])]
            .filter(note => typeof note === 'string' && note.trim());
        explanation.replaceChildren(...notes.map(note => element('p', 'mb-1', note)));
        const reportIds = [...new Set(Array.isArray(inference.used_report_ids) ? inference.used_report_ids : [])]
            .filter(reportId => Number.isSafeInteger(reportId) && reportId > 0).sort((a, b) => b - a);
        if (reportIds.length) {
            const reports = element('p', 'mb-1', 'Reports used: ');
            reportIds.slice(0, 20).forEach((reportId, index) => {
                if (index) reports.appendChild(element('span', '', ', '));
                const link = element('a', '', `#${reportId}`);
                link.href = `/About/BattleReport/${reportId}`;
                reports.appendChild(link);
            });
            if (reportIds.length > 20) reports.appendChild(element('span', '', `; ${reportIds.length - 20} more.`));
            explanation.appendChild(reports);
        }
        const skipped = inference.skipped && typeof inference.skipped === 'object'
            ? Object.entries(inference.skipped).filter(([, value]) => count(value) > 0) : [];
        if (skipped.length) explanation.appendChild(element('p', 'mb-1', `Excluded reports: ${skipped
            .slice(0, 30).map(([reason, value]) => `${reason.replace(/_/g, ' ')}: ${value}`).join('; ')}.`));
    }

    async function request(method) {
        if (busy || !card.isConnected) return;
        // A profile can gain live intel after this card mounted, before the background
        // profile sync reaches the hub. Respect that stronger evidence immediately.
        if (liveIntelVisible()) locked = true;
        if (locked) {
            inference = null;
            render();
            return;
        }
        busy = true;
        error = '';
        retryMethod = method;
        render();
        try {
            const response = await fetch(endpoint, { method, headers: { Accept: 'application/json' } });
            if (!card.isConnected) return;
            if (response.status === 401 || response.status === 403) {
                authFailed = true;
                throw new Error(response.status === 401
                    ? 'Your hub session is unavailable. Sign in again and reload this profile.'
                    : 'Your hub role does not allow this action. Reload the profile after your access changes.');
            }
            if (response.status === 409) {
                locked = true;
                inference = null;
                return;
            }
            if (!response.ok) throw new Error(method === 'GET'
                ? 'Could not load battle evidence. Retry to check the saved estimate.'
                : 'Could not update battle evidence. Any previous estimate is still shown; retry the update.');
            const data = await response.json();
            if (!card.isConnected) return;
            if (!data || data.success !== true || typeof data.has_bio !== 'boolean') {
                throw new Error('The hub returned an invalid response. Retry to refresh battle evidence.');
            }
            locked = data.has_bio || liveIntelVisible();
            inference = locked ? null : data.inference;
            loaded = true;
        } catch (err) {
            if (!card.isConnected) return;
            error = err instanceof Error ? err.message : 'Could not reach the hub. Retry to refresh battle evidence.';
        } finally {
            busy = false;
            render();
        }
    }

    update.addEventListener('click', () => { if (!update.disabled) void request('POST'); });
    retry.addEventListener('click', () => { if (!retry.disabled) void request(retryMethod); });
    render();
    const controller = { ready: request('GET') };
    mounted.set(container, controller);
    return controller;
}
