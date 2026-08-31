import { esc } from '../utils/escape.js';
import '../utils/battle-model.js';   // side-effect import: puts the model on globalThis
import '../utils/sqlite-time.js';    // side-effect import: puts the model on globalThis

const { formatSqliteUtc } = globalThis.AWSqliteTime;

let localSystemId = null;

function formatEventTime(ts) {
    return formatSqliteUtc(ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function setIntelSystemId(sysId) {
    localSystemId = sysId;
}

export async function loadPlans(sysId) {
    if (!sysId) return;
    localSystemId = sysId;
    try {
        const res = await fetch(`/hub-api/intel/system/${sysId}`);
        const data = await res.json();
        if (!data.success) return;

        // Refines the sidebar header dashboard.js already set to "System Data - #{id}"
        // (from GAME_CONTEXT, before this fetch had a chance to resolve) into the full
        // "System Data - #{id} {name}" once the system's own name is known.
        const sysLabel = document.getElementById('ui-sys-id');
        if (sysLabel && data.system && data.system.name) {
            sysLabel.innerText = `System Data - #${sysId} ${data.system.name}`;
        }

        const list = document.getElementById('plans-list');
        if (list) {
            if (data.plans.length > 0) {
                list.innerHTML = data.plans.map(p => `
                    <div class="bg-card border border-border p-3 rounded-lg plan-card relative group shadow-sm">
                        <div class="flex justify-between items-start mb-1.5">
                            <span class="text-foreground font-semibold text-s">Planet #${p.planet_index}</span>
                            <button data-planet="${p.planet_index}" class="btn-delete-plan text-muted-foreground hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                <i class="fa-solid fa-trash text-s"></i>
                            </button>
                        </div>
                        <p class="text-muted-foreground text-s mb-2">${esc(p.note)}</p>
                        <div class="text-s text-muted-foreground opacity-70 text-right">by ${esc(p.author || 'Unknown')}</div>
                    </div>
                `).join('');

                list.querySelectorAll('.btn-delete-plan').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const pIdx = e.currentTarget.getAttribute('data-planet');
                        deletePlan(pIdx);
                    });
                });
            } else {
                list.innerHTML = '';
            }
        }

        document.getElementById('intel-fleets-list').innerHTML = data.fleets.length ? data.fleets.map(f => {
            const cv = globalThis.AWBattleModel.cvOf(f);
            const statBadge = (f.arrival_time && f.arrival_time !== '-') ? `<span class="text-s bg-red-500/20 text-red-400 px-1 rounded ml-1">Transit: ${esc(f.arrival_time)}</span>` : '';
            return `
                <div class="flex justify-between items-center py-0.5 text-s">
                    <span class="text-muted-foreground">At #${f.planet_index} ${statBadge}</span>
                    <span class="text-red-400 font-medium">by [${esc(f.alliance_tag || '?')}] ${esc(f.owner_name || 'Unknown')} (CV: ${cv.toLocaleString()})</span>
                </div>`;
        }).join('') : '<span class="text-muted-foreground italic text-center py-2">No fleets detected.</span>';

        document.getElementById('intel-history-list').innerHTML = data.history.length ? data.history.map(h => {
            const when = formatEventTime(h.timestamp);
            const detail = h.event_type_id === 1
                ? `<span class="text-foreground font-medium">${esc(h.old_owner || 'None')} &rarr; ${esc(h.new_owner || 'None')}</span>`
                : `<span class="text-red-400 font-medium">Population drop${(h.old_value != null && h.new_value != null) ? ` (${h.old_value} &rarr; ${h.new_value})` : ''}</span>`;
            return `
            <div class="text-s leading-tight mb-2 border-l-2 border-border pl-2">
                <span class="text-muted-foreground">${when} (#${h.planet_index})</span><br>
                ${detail}
            </div>`;
        }).join('') : '<span class="text-muted-foreground italic text-center py-2">History empty.</span>';

        const iframe = document.getElementById('game-frame');
        if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'INJECT_TACTICAL_OVERLAYS', payload: { plans: data.plans, fleets: data.fleets, planets: data.planets } }, window.location.origin);
        }
    } catch (err) {}
}

export async function savePlan() {
    const pIdx = document.getElementById('plan-planet-idx').value;
    const note = document.getElementById('plan-note').value;
    if (!localSystemId || !pIdx || !note) return window.showToast('Fill in all fields');
    try {
        const res = await fetch('/hub-api/plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_id: localSystemId, planet_index: pIdx, note })
        });
        if (res.ok) {
            document.getElementById('plan-planet-idx').value = '';
            document.getElementById('plan-note').value = '';
            loadPlans(localSystemId);
            if (typeof window.showToast === 'function') window.showToast('Plan saved');
        }
    } catch (err) {}
}

export async function deletePlan(pIdx) {
    if (!localSystemId || !confirm("Delete this plan?")) return;
    try {
        const res = await fetch(`/hub-api/plans/${localSystemId}/${pIdx}`, { method: 'DELETE' });
        if (res.ok) { loadPlans(localSystemId); if (typeof window.showToast === 'function') window.showToast('Plan deleted'); }
    } catch (err) {}
}
