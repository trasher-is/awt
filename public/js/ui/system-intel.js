import { esc } from '../utils/escape.js';
import '../utils/battle-model.js';   // side-effect import: puts the model on globalThis
import '../utils/game-rate-limit.js'; // side-effect import: the shared 5-req/s gate (must precede aw-api use)
import '../utils/aw-api.js';         // side-effect import: globalThis.AWApi — every /api/v1 call rides the gate

let localSystemId = null;
let ordersRenderedFor = null;   // which system the orders box currently shows (null = closed)
let ordersLoading = false;      // in-flight guard: a double click must not double-spend the rate budget
let refreshing = false;

// Parse a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") and format it in the user's local time.
function formatEventTime(ts) {
    if (!ts) return '—';
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

export function setIntelSystemId(sysId) {
    localSystemId = sysId;
}

export async function loadPlans(sysId) {
    if (!sysId) return;
    // Moving to another system: drop API state that belongs to the previous one — a stale
    // orders editor or error line about system X is misleading while looking at system Y.
    if (localSystemId !== null && String(localSystemId) !== String(sysId)) {
        setApiStatus('');
        closeOrdersBox();
    }
    localSystemId = sysId;
    try {
        const res = await fetch(`/hub-api/intel/system/${sysId}`);
        const data = await res.json();
        if (!data.success) return;

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
        
        document.getElementById('intel-planets-list').innerHTML = data.planets.map(p => `
            <div class="flex justify-between items-center py-0.5">
                <span class="text-muted-foreground">#${p.planet_index}</span>
                <span class="font-medium">${p.owner_name ? `[${esc(p.alliance_tag || '?')}] ${esc(p.owner_name)}` : 'Empty'}</span>
            </div>
        `).join('');

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

// ─── LIVE GAME-API ACTIONS ────────────────────────────────────────────────────
// Both actions below talk to the game's /api/v1 through globalThis.AWApi, which routes
// every call through the shared 5-req/s gate — that budget is a promise made to the
// game's administrator. Failures are shown in #awt-intel-api-status (the newer visible
// error-surface convention), never swallowed.

// Visible status line under the API buttons. kind: 'error' paints it red.
function setApiStatus(msg, kind) {
    const el = document.getElementById('awt-intel-api-status');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.classList.toggle('text-red-400', kind === 'error');
    el.classList.toggle('text-muted-foreground', kind !== 'error');
    el.textContent = msg;
}

// One line for an AWApi failure, verbatim: the status code and reason, no guessing.
function describeApiError(r) {
    if (r.reason === 'session') return `HTTP ${r.status} — session (log in to the game first)`;
    if (r.reason === 'network') return 'network error (request never completed)';
    return `HTTP ${r.status} (${r.reason})`;
}

// "Odśwież z API": pull this system's planets from the game API, push them through the
// existing /hub-api/sync/system upsert (fog-of-war guards live server-side), re-render.
async function refreshFromApi() {
    if (refreshing) return;
    const sysId = localSystemId;
    if (!sysId) return setApiStatus('Open a system view first.', 'error');
    const api = globalThis.AWApi;
    if (!api) return setApiStatus('AWApi failed to load.', 'error');

    refreshing = true;
    try {
        setApiStatus(`Fetching system #${sysId} from the game API…`);
        const r = await api.getSystemPlanets(sysId);
        if (String(localSystemId) !== String(sysId)) return;   // user moved on while the call sat in the rate queue
        if (!r.ok) return setApiStatus(`Refresh failed: ${describeApiError(r)}`, 'error');
        if (!Array.isArray(r.data) || r.data.length === 0) {
            return setApiStatus('Refresh failed: the API returned no planets for this system.', 'error');
        }

        // The ONE shared API->sync mapper (aw-api.js) — never a local copy of it.
        const payload = api.mapPlanetsToSyncPayload(sysId, r.data);
        let synced;
        try {
            const res = await fetch('/hub-api/sync/system', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const d = await res.json();
            if (!res.ok || !d.success) throw new Error(d.error || `HTTP ${res.status}`);
            synced = d.synced_count;
        } catch (err) {
            if (String(localSystemId) === String(sysId)) setApiStatus(`Hub sync failed: ${err.message}`, 'error');
            return;
        }
        if (String(localSystemId) !== String(sysId)) return;

        await loadPlans(sysId);
        setApiStatus(`Refreshed from the API — ${synced} planets synced.`);
        if (typeof window.showToast === 'function') window.showToast('System intel refreshed');
    } finally {
        refreshing = false;
    }
}

// ─── STARBASE ORDER EDITOR (own planets only, write-only) ────────────────────
// The API exposes NO read of an order's current geometry — {id, canBeChanged} is all it
// returns — so this editor is write-only and says so on screen. One order per explicit
// confirm; no automation, no batch writes.

function closeOrdersBox() {
    ordersRenderedFor = null;
    const box = document.getElementById('awt-intel-orders-box');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

async function toggleStarbaseOrders() {
    if (ordersLoading) return;
    if (ordersRenderedFor !== null) return closeOrdersBox();
    ordersLoading = true;
    try { await openStarbaseOrders(); } finally { ordersLoading = false; }
}

async function openStarbaseOrders() {
    const box = document.getElementById('awt-intel-orders-box');
    if (!box) return;
    const sysId = localSystemId;
    if (!sysId) return setApiStatus('Open a system view first.', 'error');
    const api = globalThis.AWApi;
    if (!api) return setApiStatus('AWApi failed to load.', 'error');

    setApiStatus(`Loading starbase orders for system #${sysId}…`);

    // "Own planet" = the API's ownerName equals the hub account's game name,
    // case-insensitive — the same name bridge the server uses everywhere.
    let myName = null;
    try {
        const res = await fetch('/hub-api/me');
        const me = await res.json();
        if (res.ok && me && me.gameName) myName = String(me.gameName).toLowerCase();
    } catch (err) {}
    if (!myName) return setApiStatus('Could not resolve your game name from /hub-api/me.', 'error');

    const r = await api.getSystemPlanets(sysId);
    if (String(localSystemId) !== String(sysId)) return;   // user navigated away while the call was queued
    if (!r.ok) return setApiStatus(`Orders lookup failed: ${describeApiError(r)}`, 'error');

    const planets = Array.isArray(r.data) ? r.data : [];
    const own = planets.filter(p => p && typeof p.ownerName === 'string' && p.ownerName.toLowerCase() === myName);

    setApiStatus('');
    ordersRenderedFor = sysId;
    box.innerHTML = renderOrdersBox(own);
    box.classList.remove('hidden');
}

function renderOrdersBox(ownPlanets) {
    const header = `
        <div class="text-muted-foreground font-semibold border-b border-border pb-1">Starbase Orders <span class="text-xs font-normal">(write-only)</span></div>
        <div class="text-xs text-amber-500/90">The API does not expose current geometry — values you send overwrite whatever each order has now.</div>`;
    if (!ownPlanets.length) {
        return header + '<div class="text-muted-foreground italic text-xs py-1">No planets of yours in this system.</div>';
    }
    return header + ownPlanets.map(p => {
        const orders = Array.isArray(p.starbaseOrders) ? p.starbaseOrders : [];
        const body = orders.length
            ? orders.map(o => renderOrderRow(p, o)).join('')
            : '<div class="text-muted-foreground italic text-xs">No starbase orders on this planet.</div>';
        return `
            <div class="bg-card border border-border rounded-lg p-2 shadow-sm flex flex-col gap-2">
                <div class="text-foreground font-medium">Planet #${esc(String(p.index))}${p.name ? ` — ${esc(p.name)}` : ''}</div>
                ${body}
            </div>`;
    }).join('');
}

// Everything interpolated below came from the API and is spec-derived, never observed —
// treated as hostile: esc() even inside attributes.
function renderOrderRow(p, o) {
    const oid = esc(String(o && o.id));
    const pidx = esc(String(p.index));
    if (!o || o.canBeChanged !== true) {
        // Surfaced verbatim: the API says this order cannot be changed right now.
        return `
            <div class="border border-border rounded-md p-2 text-xs">
                <span class="font-mono">Order #${oid}</span>
                <span class="text-red-400 ml-1">canBeChanged: ${esc(String(o && o.canBeChanged))} — not editable</span>
            </div>`;
    }
    return `
        <div class="awt-order-row border border-border rounded-md p-2 flex flex-col gap-1.5 text-xs" data-order-id="${oid}" data-planet-index="${pidx}">
            <div class="font-mono text-foreground">Order #${oid}</div>
            <div class="grid grid-cols-3 gap-1.5">
                <label class="flex flex-col gap-0.5 text-muted-foreground">range
                    <input type="number" step="any" class="awt-order-range h-7 rounded-md border border-input bg-transparent px-2 shadow-sm focus:outline-none" placeholder="?">
                </label>
                <label class="flex flex-col gap-0.5 text-muted-foreground">angle1 °
                    <input type="number" step="any" class="awt-order-angle1 h-7 rounded-md border border-input bg-transparent px-2 shadow-sm focus:outline-none" placeholder="?">
                </label>
                <label class="flex flex-col gap-0.5 text-muted-foreground">angle2 °
                    <input type="number" step="any" class="awt-order-angle2 h-7 rounded-md border border-input bg-transparent px-2 shadow-sm focus:outline-none" placeholder="?">
                </label>
            </div>
            <div class="flex items-center gap-2">
                <button type="button" class="awt-order-send inline-flex items-center justify-center h-7 px-3 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 shadow-sm shrink-0">Send</button>
                <span class="awt-order-status text-muted-foreground break-words"></span>
            </div>
        </div>`;
}

async function submitOrderGeometry(row) {
    const sysId = ordersRenderedFor;
    const statusEl = row.querySelector('.awt-order-status');
    const say = (msg, isError) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.toggle('text-red-400', !!isError);
        statusEl.classList.toggle('text-muted-foreground', !isError);
    };

    // The server's audit route 400s on a non-integer order id, and the API path would be
    // /orders/NaN — validate the spec-derived id before anything leaves.
    const orderId = Number(row.getAttribute('data-order-id'));
    if (!Number.isInteger(orderId) || orderId <= 0) return say('Bad order id from the API.', true);
    const planetIndex = Number(row.getAttribute('data-planet-index'));

    const range = parseFloat(row.querySelector('.awt-order-range')?.value);
    const angle1 = parseFloat(row.querySelector('.awt-order-angle1')?.value);
    const angle2 = parseFloat(row.querySelector('.awt-order-angle2')?.value);
    if (![range, angle1, angle2].every(Number.isFinite)) {
        return say('Fill range, angle1 and angle2 with numbers.', true);
    }

    // Exactly what will be sent — the PUT body's real keys — before anything is sent.
    const summary = `PUT /api/v1/Starbase/orders/${orderId}/geometry\n\n`
        + `  range: ${range}\n  angleDegree1: ${angle1}\n  angleDegree2: ${angle2}\n\n`
        + `This overwrites the order's current geometry (the API cannot read it back). Send?`;
    if (!confirm(summary)) return;

    say('Sending…', false);
    const api = globalThis.AWApi;
    if (!api) return say('AWApi failed to load.', true);
    const r = await api.putOrderGeometry(orderId, { range, angleDegree1: angle1, angleDegree2: angle2 });
    if (!r.ok) return say(`PUT failed: ${describeApiError(r)}`, true);   // 403/404 verbatim

    // The write went through — record it in the hub's audit log. If THAT part fails the
    // member must still learn the order changed, or they would retry the PUT.
    try {
        const res = await fetch('/hub-api/sync/starbase-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                order_id: orderId,
                system_id: Number(sysId),
                planet_index: planetIndex,
                range, angle1, angle2
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        say('Order updated and logged.', false);
        if (typeof window.showToast === 'function') window.showToast(`Starbase order #${orderId} updated`);
    } catch (err) {
        say(`Order UPDATED, but the audit log write failed (${err.message}) — do not resend.`, true);
    }
}

// Wired here, not in dashboard.js: module scripts run after the document is parsed, so
// the static sidebar elements already exist. The orders box gets ONE delegated listener —
// its rows re-render on every open and per-row bindings would leak.
document.getElementById('awt-intel-refresh-btn')?.addEventListener('click', refreshFromApi);
document.getElementById('awt-intel-orders-btn')?.addEventListener('click', toggleStarbaseOrders);
document.getElementById('awt-intel-orders-box')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.awt-order-send');
    if (!btn) return;
    const row = btn.closest('.awt-order-row');
    if (row) submitOrderGeometry(row);
});