// Route planner panel — called from archives.js after the panel HTML is injected.
//
// The travel maths is NOT here. Legs are computed by POST /hub-api/routes/preview so the
// numbers a member sees are the same ones the server stores and the same ones the Discord
// announcement quotes. That also means the planner picks up any recalibration of the
// travel formula for free.

import { esc } from '../utils/escape.js';

const MAX_STOPS = 7;   // start + up to 6 legs, matching the server's MAX_LEGS
let sysCache = null, playerCache = null;
let editingId = null;
let previewTimer = null;
let me = { id: null, role: null };

// ─── SMALL HELPERS ────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// <input type="datetime-local"> gives local wall-clock with no zone. Interpret it as
// local (which is what the user meant) and hand the server an explicit UTC instant.
function localInputToIso(value) {
    if (!value) return null;
    const ms = Date.parse(value);          // no zone suffix -> parsed as local time
    return isNaN(ms) ? null : new Date(ms).toISOString();
}

function fmtLocal(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtUtc(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toISOString().slice(5, 16).replace('T', ' ') + 'Z';
}

async function getJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

async function loadSystems() {
    if (sysCache) return sysCache;
    try {
        const d = await getJson('/hub-api/intel/systems_db');
        if (d.success) sysCache = d.systems;
    } catch (e) {}
    return sysCache || [];
}

async function loadPlayers() {
    if (playerCache) return playerCache;
    try {
        const d = await getJson('/hub-api/intel/players');
        if (d.success) playerCache = d.players;
    } catch (e) {}
    return playerCache || [];
}

// ─── WAYPOINT ROWS ────────────────────────────────────────────────────────────

function stopLabel(index, total) {
    if (index === 0) return { text: 'Start', color: 'text-sky-400', icon: 'fa-location-dot' };
    if (index === total - 1) return { text: 'Target', color: 'text-red-400', icon: 'fa-flag-checkered' };
    return { text: `Jump ${index}`, color: 'text-violet-400', icon: 'fa-arrow-right-arrow-left' };
}

function renderWaypoints(values) {
    const box = $('rp-waypoints');
    if (!box) return;
    const rows = values || collectWaypoints();
    const total = rows.length;

    box.innerHTML = rows.map((w, i) => {
        const l = stopLabel(i, total);
        const removable = total > 2;
        return `
        <div class="rp-wp bg-zinc-950 border border-border rounded p-2 flex flex-col sm:flex-row sm:items-end gap-2" data-index="${i}">
            <div class="flex items-center gap-2 sm:w-24 shrink-0 ${l.color} text-xs font-semibold uppercase tracking-wider">
                <i class="fa-solid ${l.icon}"></i> ${l.text}
            </div>
            <div class="relative flex-1 min-w-0">
                <label class="text-xs text-muted-foreground">System</label>
                <input type="text" class="rp-sys-input h-9 w-full rounded border border-input bg-black px-2 text-sm text-foreground focus:outline-none focus:border-zinc-500"
                       placeholder="Find system…" autocomplete="off" value="${esc(w.label || '')}">
                <input type="hidden" class="rp-sys-id" value="${w.systemId || ''}">
                <div class="rp-sys-drop hidden absolute top-full left-0 z-50 w-full bg-zinc-900 border border-border rounded shadow-xl max-h-48 overflow-y-auto"></div>
            </div>
            <div class="w-full sm:w-24 shrink-0">
                <label class="text-xs text-muted-foreground">Planet</label>
                <input type="number" min="1" max="12" value="${w.planetIndex || 1}"
                       class="rp-planet h-9 w-full rounded border border-input bg-black px-2 text-sm text-foreground focus:outline-none focus:border-zinc-500">
            </div>
            <button class="rp-remove h-9 w-9 shrink-0 rounded border border-input text-muted-foreground hover:text-red-400 hover:border-red-400/50 transition-colors ${removable ? '' : 'invisible'}"
                    title="Remove this stop"><i class="fa-solid fa-trash text-xs"></i></button>
        </div>`;
    }).join('');

    box.querySelectorAll('.rp-wp').forEach(wireWaypointRow);
}

function collectWaypoints() {
    const rows = [...document.querySelectorAll('#rp-waypoints .rp-wp')];
    if (!rows.length) return [{ systemId: null, planetIndex: 1, label: '' }, { systemId: null, planetIndex: 1, label: '' }];
    return rows.map(r => ({
        systemId: parseInt(r.querySelector('.rp-sys-id').value, 10) || null,
        planetIndex: parseInt(r.querySelector('.rp-planet').value, 10) || 1,
        label: r.querySelector('.rp-sys-input').value
    }));
}

function wireWaypointRow(row) {
    const input = row.querySelector('.rp-sys-input');
    const hidden = row.querySelector('.rp-sys-id');
    const drop = row.querySelector('.rp-sys-drop');

    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        hidden.value = '';                       // typing invalidates the previous pick
        if (!q) { drop.classList.add('hidden'); schedulePreview(); return; }
        const systems = await loadSystems();
        const matches = systems.filter(s =>
            (s.name && s.name.toLowerCase().includes(q)) || String(s.id).includes(q)).slice(0, 12);
        if (!matches.length) { drop.classList.add('hidden'); return; }
        drop.classList.remove('hidden');
        drop.innerHTML = matches.map(s => `
            <button type="button" data-id="${s.id}" data-name="${esc(s.name || 'Sys')}"
                    class="rp-sys-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${esc(s.name || 'Sys')} #${s.id}</span>
                <span class="text-zinc-500 ml-auto">${s.x}/${s.y}</span>
            </button>`).join('');
        drop.querySelectorAll('.rp-sys-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            hidden.value = btn.dataset.id;
            input.value = `${btn.dataset.name} #${btn.dataset.id}`;
            drop.classList.add('hidden');
            schedulePreview();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));

    row.querySelector('.rp-planet').addEventListener('input', schedulePreview);
    row.querySelector('.rp-remove').addEventListener('click', () => {
        const values = collectWaypoints();
        if (values.length <= 2) return;
        values.splice(parseInt(row.dataset.index, 10), 1);
        renderWaypoints(values);
        schedulePreview();
    });
}

// ─── PREVIEW ──────────────────────────────────────────────────────────────────

function currentPayload() {
    return {
        waypoints: collectWaypoints().map(w => ({ systemId: w.systemId, planetIndex: w.planetIndex })),
        energy: parseInt($('rp-energy').value, 10) || 0,
        raceSpeed: parseInt($('rp-speed').value, 10) || 0,
        biology: parseInt($('rp-biology').value, 10) || 0,
        isAllianceMove: $('rp-alliance').checked,
        plannedStartAt: localInputToIso($('rp-start').value),
        title: $('rp-title').value,
        note: $('rp-note').value,
        visibility: $('rp-shared').checked ? 'alliance' : 'private'
    };
}

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 250);
}

function showError(msg) {
    const el = $('rp-error');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = msg;
}

async function preview() {
    const payload = currentPayload();
    const incomplete = payload.waypoints.some(w => !w.systemId);
    if (incomplete) {
        $('rp-total').textContent = '--:--:--';
        $('rp-legs').innerHTML = '<div class="text-xs text-muted-foreground">Pick a system for every stop.</div>';
        $('rp-arrival').textContent = '';
        showError('');
        return;
    }

    try {
        const d = await getJson('/hub-api/routes/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        showError('');
        $('rp-total').textContent = d.totalTime;
        $('rp-legs').innerHTML = d.legs.map(renderLeg).join('');
        $('rp-arrival').innerHTML = d.arrivesAt
            ? `Arrives <span class="text-foreground">${esc(fmtLocal(d.arrivesAt))}</span> local · <span class="font-mono">${esc(fmtUtc(d.arrivesAt))}</span>`
            : 'Set a planned start to get arrival times.';
    } catch (err) {
        $('rp-total').textContent = '--:--:--';
        $('rp-legs').innerHTML = '';
        $('rp-arrival').textContent = '';
        showError(err.message);
    }
}

function renderLeg(l) {
    const warn = l.outOfReach
        ? `<span class="text-amber-400" title="Needs biology ${l.bioNeeded}"><i class="fa-solid fa-triangle-exclamation"></i> bio ${l.bioNeeded}</span>`
        : `<span class="text-zinc-500">bio ${l.bioNeeded}</span>`;
    const times = l.arrivesAt
        ? `<span class="text-zinc-500">${esc(fmtLocal(l.departsAt))} → ${esc(fmtLocal(l.arrivesAt))}</span>`
        : '';
    return `
    <div class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-xs border-l-2 ${l.outOfReach ? 'border-amber-500/60' : 'border-border'} pl-2 py-1">
        <span class="font-mono text-foreground font-semibold w-20 shrink-0">${esc(l.travelTime)}</span>
        <span class="text-muted-foreground truncate flex-1 min-w-0">
            ${esc(l.from.systemName || '?')} #${l.from.planetIndex}
            <i class="fa-solid fa-arrow-right mx-1 text-zinc-600"></i>
            ${esc(l.to.systemName || '?')} #${l.to.planetIndex}
        </span>
        <span class="text-zinc-500 shrink-0">dist ${l.distance}</span>
        ${warn}
        ${times}
    </div>`;
}

// ─── SAVE / LOAD ──────────────────────────────────────────────────────────────

async function save() {
    const payload = currentPayload();
    const msg = $('rp-save-msg');
    const btn = $('rp-save');
    btn.disabled = true;
    msg.textContent = 'Saving…';
    try {
        const url = editingId ? `/hub-api/routes/${editingId}` : '/hub-api/routes';
        const d = await getJson(url, {
            method: editingId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        editingId = d.id;
        msg.textContent = 'Saved.';
        if (typeof window.showToast === 'function') window.showToast('Route saved');
        await loadShared();
    } catch (err) {
        msg.textContent = err.message;
    } finally {
        btn.disabled = false;
        setTimeout(() => { if (msg.textContent === 'Saved.') msg.textContent = ''; }, 3000);
    }
}

function resetForm() {
    editingId = null;
    $('rp-title').value = '';
    $('rp-note').value = '';
    $('rp-start').value = '';
    $('rp-shared').checked = true;
    renderWaypoints([{ systemId: null, planetIndex: 1, label: '' }, { systemId: null, planetIndex: 1, label: '' }]);
    $('rp-save-msg').textContent = '';
    preview();
}

function loadIntoForm(route) {
    editingId = route.id;
    $('rp-title').value = route.title || '';
    $('rp-note').value = route.note || '';
    $('rp-energy').value = route.energy || 0;
    $('rp-speed').value = route.raceSpeed || 0;
    $('rp-biology').value = route.biology || 0;
    $('rp-alliance').checked = !!route.isAllianceMove;
    $('rp-shared').checked = route.visibility !== 'private';
    if (route.plannedStartAt) {
        const d = new Date(route.plannedStartAt);
        // back to a local wall-clock string the input understands
        const pad = n => String(n).padStart(2, '0');
        $('rp-start').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
        $('rp-start').value = '';
    }

    const stops = [];
    route.legs.forEach((l, i) => {
        if (i === 0) stops.push({ systemId: l.from.systemId, planetIndex: l.from.planetIndex, label: `${l.from.systemName || 'Sys'} #${l.from.systemId}` });
        stops.push({ systemId: l.to.systemId, planetIndex: l.to.planetIndex, label: `${l.to.systemName || 'Sys'} #${l.to.systemId}` });
    });
    renderWaypoints(stops.length >= 2 ? stops : undefined);
    preview();
    $('rp-save-msg').textContent = `Editing "${route.title || 'untitled route'}" — Save to overwrite, New to start fresh.`;
    $('route-planner-panel')?.querySelector('.flex-1')?.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadShared() {
    const box = $('rp-shared-list');
    if (!box) return;
    try {
        const d = await getJson('/hub-api/routes');
        if (!d.routes.length) {
            box.innerHTML = '<div class="text-xs text-muted-foreground">No routes shared yet.</div>';
            return;
        }
        box.innerHTML = d.routes.map(r => {
            const mine = me.id != null && r.authorId === me.id;
            const canEdit = mine || me.role === 'admin' || r.authorId == null;
            const hops = r.legs.map(l => `${esc(l.to.systemName || '?')} #${l.to.planetIndex}`).join(' → ');
            const origin = r.legs.length ? `${esc(r.legs[0].from.systemName || '?')} #${r.legs[0].from.planetIndex}` : '?';
            const start = r.plannedStartAt
                ? `${esc(fmtLocal(r.plannedStartAt))} local · ${esc(fmtUtc(r.plannedStartAt))}`
                : 'no planned start';
            const arrival = r.legs.length && r.legs[r.legs.length - 1].arrivesAt
                ? ` · arrives ${esc(fmtLocal(r.legs[r.legs.length - 1].arrivesAt))}`
                : '';
            return `
            <div class="bg-zinc-950 border border-border rounded p-2 flex flex-col gap-1" data-route="${r.id}">
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <div class="text-sm text-foreground font-medium truncate">${esc(r.title || 'Untitled route')}</div>
                        <div class="text-xs text-muted-foreground truncate">by ${esc(r.author)}${r.visibility === 'private' ? ' · private' : ''}</div>
                    </div>
                    <div class="font-mono text-sm text-foreground shrink-0">${esc(r.totalTime)}</div>
                </div>
                <div class="text-xs text-muted-foreground truncate">${origin} → ${hops}</div>
                <div class="text-xs text-zinc-500">${start}${arrival}</div>
                ${r.note ? `<div class="text-xs text-muted-foreground">${esc(r.note)}</div>` : ''}
                <div class="flex items-center gap-3 pt-1">
                    <button class="rp-load text-xs text-sky-400 hover:underline">Open</button>
                    <button class="rp-announce text-xs text-violet-400 hover:underline">Announce</button>
                    ${canEdit ? '<button class="rp-delete text-xs text-red-400 hover:underline ml-auto">Delete</button>' : ''}
                </div>
            </div>`;
        }).join('');

        box.querySelectorAll('[data-route]').forEach(card => {
            const id = parseInt(card.dataset.route, 10);
            const route = d.routes.find(r => r.id === id);
            card.querySelector('.rp-load')?.addEventListener('click', () => loadIntoForm(route));
            card.querySelector('.rp-announce')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Posting…';
                try {
                    await getJson(`/hub-api/routes/${id}/announce`, { method: 'POST' });
                    btn.textContent = 'Posted ✓';
                    if (typeof window.showToast === 'function') window.showToast('Route announced on Discord');
                } catch (err) {
                    btn.textContent = 'Announce';
                    btn.disabled = false;
                    if (typeof window.showToast === 'function') window.showToast(err.message);
                }
            });
            card.querySelector('.rp-delete')?.addEventListener('click', async () => {
                if (!confirm('Delete this route?')) return;
                try {
                    await getJson(`/hub-api/routes/${id}`, { method: 'DELETE' });
                    if (editingId === id) resetForm();
                    await loadShared();
                } catch (err) {
                    if (typeof window.showToast === 'function') window.showToast(err.message);
                }
            });
        });
    } catch (err) {
        box.innerHTML = `<div class="text-xs text-red-400">${esc(err.message)}</div>`;
    }
}

function wirePlayerSearch() {
    const input = $('rp-player-input'), drop = $('rp-player-dropdown');
    if (!input || !drop) return;
    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { drop.classList.add('hidden'); return; }
        const players = await loadPlayers();
        const matches = players.filter(p => p.name && p.name.toLowerCase().includes(q)).slice(0, 12);
        if (!matches.length) { drop.classList.add('hidden'); return; }
        drop.classList.remove('hidden');
        drop.innerHTML = matches.map(p => `
            <button type="button" data-e="${p.energy || 0}" data-s="${p.race_speed || 0}" data-b="${p.biology || 0}"
                    data-name="${esc(p.name || '')}"
                    class="rp-pl-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${esc(p.name)}</span>
                <span class="text-zinc-500 ml-auto">E${p.energy || 0} spd${p.race_speed || 0} bio${p.biology || 0}</span>
            </button>`).join('');
        drop.querySelectorAll('.rp-pl-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            $('rp-energy').value = btn.dataset.e;
            $('rp-speed').value = btn.dataset.s;
            $('rp-biology').value = btn.dataset.b;
            input.value = btn.dataset.name;
            drop.classList.add('hidden');
            schedulePreview();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
}

export async function initRoutePlanner() {
    $('close-route-planner-btn')?.addEventListener('click', () => {
        $('route-planner-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    });

    try {
        const d = await getJson('/hub-api/me');
        me = { id: d.id, role: d.role };
    } catch (e) { /* the list just falls back to hiding edit controls */ }

    renderWaypoints([{ systemId: null, planetIndex: 1, label: '' }, { systemId: null, planetIndex: 1, label: '' }]);

    $('rp-add-stop')?.addEventListener('click', () => {
        const values = collectWaypoints();
        if (values.length >= MAX_STOPS) {
            showError(`A route can have at most ${MAX_STOPS - 1} legs.`);
            return;
        }
        // insert before the target so the last row stays the destination
        values.splice(values.length - 1, 0, { systemId: null, planetIndex: 1, label: '' });
        renderWaypoints(values);
        schedulePreview();
    });

    document.querySelectorAll('#route-planner-panel .rp-in').forEach(el => {
        el.addEventListener('input', schedulePreview);
        el.addEventListener('change', schedulePreview);
    });

    $('rp-save')?.addEventListener('click', save);
    $('rp-reset')?.addEventListener('click', resetForm);
    $('rp-refresh')?.addEventListener('click', loadShared);

    wirePlayerSearch();
    preview();
    loadShared();
}
