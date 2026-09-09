// Route planner panel — called from archives.js after the panel HTML is injected.
//
// The travel maths is NOT here. Legs are computed by POST /hub-api/routes/preview so the
// numbers a member sees are the same ones the server stores and the same ones the Discord
// announcement quotes. That also means the planner picks up any recalibration of the
// travel formula for free.

import { esc } from '../utils/escape.js';
import '../utils/request-sequence.js'; // side-effect import: "only the latest request renders"
import '../utils/fresh-cache.js';      // side-effect import: reference data with a lifetime
import '../utils/route-schedule-input.js'; // preserves saved instants through local input

const { createSequencer } = globalThis.AWRequestSeq;
const { createFreshCache } = globalThis.AWFreshCache;
const { createScheduleInput } = globalThis.AWRouteScheduleInput;
const scheduleInput = createScheduleInput();

const MAX_STOPS = 7;   // start + up to 6 legs, matching the server's MAX_LEGS
let editingId = null;
let previewTimer = null;
let me = { id: null, role: null };

// The preview pane belongs to the most recent set of inputs. A slower response for the
// previous inputs must not paint its ETA over the current ones (issue #129).
const previewSeq = createSequencer();
const airportSeq = createSequencer();
const playerSeq = createSequencer();

// Systems and players used to be cached in module variables forever: opened against an
// empty database, the planner cached [] and never asked again, so a sync a minute later
// was invisible until the dashboard was reloaded (issue #133). These caches expire — a
// full list after a minute, an empty one after seconds — keep old data through a failed
// refresh, and expose the failure so the panel can offer a retry.
const systemsCache = createFreshCache();
const playersCache = createFreshCache();

// ─── SMALL HELPERS ────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// Issue #159: every clock in the planner is the viewer's LOCAL time on a 24-hour dial.
// hourCycle 'h23' pins the dial regardless of the browser locale — without it an en-US
// browser renders "03:45 PM" next to the 24-hour "13:45Z" UTC stamp, the exact AM/PM vs
// 24h mix the report was about. (hour12: false is NOT equivalent: some engines map it to
// 'h24' and print midnight as "24:05".) The <input type="datetime-local"> picker itself
// follows the OS/browser locale and cannot be forced from script.
function fmtLocal(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

// UTC stamp, kept ONLY for a hover tooltip: the visible text is local time alone (#159),
// but an alliance spread across zones still needs one shared reference when coordinating.
function fmtUtc(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toISOString().slice(5, 19).replace('T', ' ') + 'Z';
}

async function getJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

// A failed load THROWS here rather than returning [] — the cache records it as an error
// with a retry, instead of remembering an empty list as if the database were empty.
async function fetchSystems() {
    const d = await getJson('/hub-api/intel/systems_db');
    if (!d.success) throw new Error(d.error || 'Could not load systems');
    return Array.isArray(d.systems) ? d.systems : [];
}

async function fetchPlayers() {
    const d = await getJson('/hub-api/intel/players');
    if (!d.success) throw new Error(d.error || 'Could not load players');
    return Array.isArray(d.players) ? d.players : [];
}

async function loadSystems(opts) {
    const r = await systemsCache.get(fetchSystems, opts);
    renderDataStatus();
    return r.data || [];
}

async function loadPlayers(opts) {
    const r = await playersCache.get(fetchPlayers, opts);
    renderDataStatus();
    return r.data || [];
}

// Both reference lists at once: on panel open (respecting freshness, so reopening within
// the TTL costs nothing) and on the explicit Refresh/Retry button (forced).
async function refreshReferenceData(opts) {
    await Promise.all([loadSystems(opts), loadPlayers(opts)]);
}

function ageText(ms) {
    if (ms == null) return '';
    if (ms < 5000) return 'just now';
    if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
    return `${Math.round(ms / 60000)} min ago`;
}

// One line under the waypoints: what the planner is searching in, how old it is, and —
// when a load failed — that it failed, with the button next to it acting as Retry.
function renderDataStatus() {
    const el = $('rp-data-status');
    const btn = $('rp-data-refresh');
    if (!el) return;
    const s = systemsCache.peek(), p = playersCache.peek();
    const failed = [s.error && 'systems', p.error && 'players'].filter(Boolean);
    if (failed.length) {
        const why = (s.error || p.error).message;
        el.innerHTML = `<span class="text-red-400"><i class="fa-solid fa-triangle-exclamation"></i> Could not load ${failed.join(' and ')}${esc(why ? ` (${why})` : '')}.</span>`
            + (s.loaded || p.loaded ? ' <span>Showing the last data loaded.</span>' : '');
        if (btn) btn.textContent = 'Retry';
        return;
    }
    if (!s.loaded && !p.loaded) {
        el.textContent = 'Loading systems and players…';
        if (btn) btn.textContent = 'Refresh data';
        return;
    }
    const sysN = s.data ? s.data.length : 0, plN = p.data ? p.data.length : 0;
    const age = Math.max(s.ageMs || 0, p.ageMs || 0);
    el.textContent = `${sysN} systems · ${plN} players in the hub · updated ${ageText(age)}`
        + (sysN === 0 ? ' — nothing scanned yet? Sync the galaxy, then Refresh.' : '');
    if (btn) btn.textContent = 'Refresh data';
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
    // loadSystems() is async (a first load, or a refresh, may be in flight), so two
    // keystrokes race: the dropdown must show matches for the LAST text typed.
    const rowSeq = createSequencer();

    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        hidden.value = '';                       // typing invalidates the previous pick
        schedulePreview();                       // invalidate suggestions before async lookup
        if (!q) { rowSeq.cancel(); drop.classList.add('hidden'); return; }
        const token = rowSeq.next();
        const systems = await loadSystems();
        if (!rowSeq.isCurrent(token)) return;
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
    const dateInput = $('rp-start');
    if (!dateInput.validity.valid) throw new Error('Enter a valid local date and time, including seconds.');
    return {
        waypoints: collectWaypoints().map(w => ({ systemId: w.systemId, planetIndex: w.planetIndex })),
        energy: parseInt($('rp-energy').value, 10) || 0,
        raceSpeed: parseInt($('rp-speed').value, 10) || 0,
        biology: parseInt($('rp-biology').value, 10) || 0,
        isAllianceMove: $('rp-alliance').checked,
        ...scheduleInput.fields(dateInput.value),
        title: $('rp-title').value,
        note: $('rp-note').value,
        visibility: $('rp-shared').checked ? 'alliance' : 'private'
    };
}

function schedulePreview() {
    clearTimeout(previewTimer);
    clearAirports();
    // Invalidate at the edit itself, including the debounce window before the next
    // request. An invalid new date must never let an older successful ETA repaint.
    previewSeq.cancel();
    clearSchedule();
    previewTimer = setTimeout(preview, 250);
}

function updateScheduleLabel() {
    $('rp-schedule-label').textContent = `${scheduleInput.mode === 'arrival' ? 'Target arrival' : 'Planned start'} (your local time)`;
}

function clearSchedule() {
    $('rp-departure').textContent = '';
    $('rp-arrival').textContent = '';
    $('rp-start-warning').textContent = '';
    $('rp-start-warning').classList.add('hidden');
}

function showError(msg) {
    const el = $('rp-error');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = msg;
}

async function preview() {
    // Every preview — including the "incomplete" placeholder — takes the token, so a
    // response for inputs the member has since changed can never paint the pane.
    const token = previewSeq.next();
    let payload;
    try { payload = currentPayload(); }
    catch (err) {
        $('rp-total').textContent = '--:--:--';
        $('rp-legs').innerHTML = '';
        clearSchedule();
        showError(err.message);
        return;
    }
    const incomplete = payload.waypoints.some(w => !w.systemId);
    if (incomplete) {
        $('rp-total').textContent = '--:--:--';
        $('rp-legs').innerHTML = '<div class="text-xs text-muted-foreground">Pick a system for every stop.</div>';
        clearSchedule();
        showError('');
        return;
    }

    try {
        const d = await getJson('/hub-api/routes/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!previewSeq.isCurrent(token)) return;
        renderPreview(d, !!payload.targetArrivalAt);
    } catch (err) {
        if (!previewSeq.isCurrent(token)) return;
        $('rp-total').textContent = '--:--:--';
        $('rp-legs').innerHTML = '';
        clearSchedule();
        showError(err.message);
    }
}

function renderPreview(d, arrivalMode) {
    showError('');
    $('rp-total').textContent = d.totalTime;
    $('rp-legs').innerHTML = d.legs.map(renderLeg).join('');
    clearSchedule();
    $('rp-departure').innerHTML = d.departsAt
        ? `${arrivalMode ? 'Required start' : 'Starts'} <span title="${esc(fmtUtc(d.departsAt))} UTC">${esc(fmtLocal(d.departsAt))}</span> your local time`
        : '';
    $('rp-arrival').innerHTML = d.arrivesAt
        ? `Arrives <span class="text-foreground" title="${esc(fmtUtc(d.arrivesAt))} UTC">${esc(fmtLocal(d.arrivesAt))}</span> your local time`
        : 'Set a planned start or target arrival to get a schedule.';
    if (d.departsAt && Date.parse(d.departsAt) < Date.now()) {
        $('rp-start-warning').textContent = 'The required start is in the past. This fleet would already need to have departed.';
        $('rp-start-warning').classList.remove('hidden');
    }
}

// Closing the panel: nothing pending may paint it, and the debounced preview is dropped.
function cancelPendingWork() {
    clearTimeout(previewTimer);
    previewSeq.cancel();
    playerSeq.cancel();
    clearAirports();
}

// ─── FRIENDLY AIRPORTS ────────────────────────────────────────────────────────

function clearAirports() {
    airportSeq.cancel();
    $('rp-airport-results')?.classList.add('hidden');
    if ($('rp-airport-status')) $('rp-airport-status').textContent = '';
    if ($('rp-airport-list')) $('rp-airport-list').innerHTML = '';
    if ($('rp-find-airport')) {
        $('rp-find-airport').disabled = false;
        $('rp-find-airport').textContent = 'Find friendly airport';
    }
}

function payloadMatches(signature) {
    try { return JSON.stringify(currentPayload()) === signature; }
    catch { return false; }
}

function durationDifference(seconds) {
    const n = Math.abs(seconds);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(Math.floor(n / 3600))}:${pad(Math.floor(n / 60) % 60)}:${pad(n % 60)}`;
}

function recordedIntel(meta) {
    const owner = `${esc(meta.ownerName || 'Unknown owner')}${meta.allianceTag ? ` [${esc(meta.allianceTag)}]` : ''}`;
    const synced = meta.lastSeenAt
        ? `Last synced <span title="${esc(fmtUtc(meta.lastSeenAt))} UTC">${esc(fmtLocal(meta.lastSeenAt))}</span>`
        : 'Sync time unknown';
    const vision = meta.isInVision === true ? 'Within recorded vision'
        : meta.isInVision === false ? 'Outside recorded vision' : 'Vision unknown';
    return `${owner} · ${synced} · ${vision}`;
}

async function findAirports() {
    clearAirports();
    const token = airportSeq.next();
    const status = $('rp-airport-status');
    const button = $('rp-find-airport');
    $('rp-airport-results').classList.remove('hidden');
    let payload;
    try { payload = currentPayload(); }
    catch (err) { status.textContent = err.message; return; }
    if (payload.waypoints.some(w => !w.systemId)) {
        status.textContent = 'Pick a system for every stop before finding an airport.';
        return;
    }
    if (payload.waypoints.length >= MAX_STOPS) {
        status.textContent = `This route already has ${MAX_STOPS - 1} legs. Remove a stop before adding an airport.`;
        return;
    }
    const signature = JSON.stringify(payload);
    status.textContent = 'Comparing friendly airports using recorded intel…';
    button.disabled = true;
    button.textContent = 'Finding airports…';
    try {
        const d = await getJson('/hub-api/routes/airports', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: signature
        });
        if (!airportSeq.isCurrent(token)) return;
        if (!payloadMatches(signature)) { clearAirports(); return; }
        if (d.limitReached) {
            status.textContent = `This route already has ${MAX_STOPS - 1} legs. Remove a stop before adding an airport.`;
            return;
        }
        if (!d.suggestions.length) {
            status.textContent = 'No friendly airports with recorded SB 0 were found for this route. You can still add a stop manually.';
            return;
        }
        status.textContent = `Current route: ${d.current.totalTime}. Comparing up to five options with recorded friendly ownership and SB 0. Conditions may change before arrival.`;
        $('rp-airport-list').innerHTML = d.suggestions.map((candidate, index) => {
            const comparison = candidate.savedSeconds > 0 ? `Saves ${durationDifference(candidate.savedSeconds)} vs current route`
                : candidate.savedSeconds < 0 ? `${durationDifference(candidate.savedSeconds)} slower than current route`
                    : 'Same travel time as current route';
            const departure = payload.targetArrivalAt && candidate.departsAt
                ? `<div>Required start <span title="${esc(fmtUtc(candidate.departsAt))} UTC">${esc(fmtLocal(candidate.departsAt))}</span> your local time</div>`
                : '';
            return `<div class="border border-border rounded bg-zinc-950 p-2 flex flex-col gap-1 text-xs">
                <div class="flex items-start justify-between gap-2">
                    <span class="text-foreground font-semibold">${esc(candidate.waypoint.systemName || 'Sys')} #${candidate.waypoint.systemId}, planet ${candidate.waypoint.planetIndex}</span>
                    <button type="button" class="rp-use-airport shrink-0 text-emerald-400 hover:underline" data-airport-index="${index}">Use airport</button>
                </div>
                <div class="text-emerald-400">Friendly airport (SB ${candidate.starbase}) · Insert after ${candidate.insertAfterIndex === 0 ? 'Start' : `Jump ${candidate.insertAfterIndex}`}</div>
                <div class="text-muted-foreground">${recordedIntel(candidate)}</div>
                <div class="text-foreground">Total travel time ${esc(candidate.totalTime)} · <span class="${candidate.savedSeconds > 0 ? 'text-emerald-400' : candidate.savedSeconds < 0 ? 'text-amber-400' : 'text-muted-foreground'}">${comparison}</span></div>
                ${candidate.outOfReach ? `<div class="text-amber-400">Needs biology ${esc(candidate.bioNeeded)}</div>` : ''}
                ${departure}
            </div>`;
        }).join('');
        $('rp-airport-list').querySelectorAll('.rp-use-airport').forEach(btn => {
            const candidate = d.suggestions[Number(btn.dataset.airportIndex)];
            btn.addEventListener('click', () => useAirport(candidate, token, signature));
        });
    } catch (err) {
        if (airportSeq.isCurrent(token)) status.textContent = err.message;
    } finally {
        if (airportSeq.isCurrent(token)) {
            button.disabled = false;
            button.textContent = 'Find friendly airport';
        }
    }
}

function useAirport(candidate, token, signature) {
    if (!airportSeq.isCurrent(token)) return;
    if (!payloadMatches(signature)) { clearAirports(); return; }
    const stops = collectWaypoints();
    if (stops.length >= MAX_STOPS || !Number.isInteger(candidate.insertAfterIndex)
        || candidate.insertAfterIndex < 0 || candidate.insertAfterIndex >= stops.length - 1) {
        clearAirports();
        return;
    }
    const w = candidate.waypoint;
    stops.splice(candidate.insertAfterIndex + 1, 0, {
        systemId: w.systemId, planetIndex: w.planetIndex, label: `${w.systemName || 'Sys'} #${w.systemId}`
    });
    renderWaypoints(stops);
    schedulePreview();
}

function renderJumpPoint(point) {
    if (!point) return '';
    const friendly = point.status === 'friendly-no-starbase';
    const label = friendly ? 'Friendly airport (SB 0)'
        : point.status === 'starbase-present' ? `Caution: starbase present (SB ${point.starbase})`
            : point.status === 'not-friendly' ? 'Caution: jump point is not known friendly'
                : point.status === 'sieged' ? 'Caution: jump point is under siege'
                    : 'Caution: airport eligibility is unknown';
    return `<div class="rp-jump-point text-xs mt-1 ${friendly ? 'text-emerald-400' : 'text-amber-400'}">
        <div>${esc(label)}</div>
        <div class="text-muted-foreground">${recordedIntel(point)}. Based on recorded intel; check conditions before onward departure.</div>
    </div>`;
}

function renderLeg(l) {
    const warn = l.outOfReach
        ? `<span class="text-amber-400" title="Needs biology ${l.bioNeeded}"><i class="fa-solid fa-triangle-exclamation"></i> bio ${l.bioNeeded}</span>`
        : `<span class="text-zinc-500">bio ${l.bioNeeded}</span>`;
    const times = l.arrivesAt
        ? `<span class="text-zinc-500"><span title="${esc(fmtUtc(l.departsAt))} UTC">${esc(fmtLocal(l.departsAt))}</span> → <span title="${esc(fmtUtc(l.arrivesAt))} UTC">${esc(fmtLocal(l.arrivesAt))}</span></span>`
        : '';
    // Issue #147: the halving is now auto-detected per leg from who currently owns the
    // destination (own alliance or the Admin -> Alliance Relations allied list), not one
    // manual checkbox for the whole route. autoAllianceMove distinguishes "we found this
    // ourselves" from "forced by the checkbox below" so the label stays honest either way.
    // Saved legs preserve the modifier, but not its detection provenance.
    const alliedTitle = l.autoAllianceMove == null ? 'Saved alliance/own-destination travel modifier'
        : l.autoAllianceMove ? 'Auto-detected: destination is owned by your alliance or an ally'
            : 'Forced by the Alliance/own move checkbox below';
    const allied = l.isAllianceMove
        ? `<span class="text-emerald-400 shrink-0" title="${alliedTitle}"><i class="fa-solid fa-handshake mr-1"></i>${l.autoAllianceMove === false ? 'allied (forced)' : 'allied'}</span>`
        : '';
    return `
    <div class="text-xs border-l-2 ${l.outOfReach ? 'border-amber-500/60' : 'border-border'} pl-2 py-1">
      <div class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
        <span class="font-mono text-foreground font-semibold w-20 shrink-0">${esc(l.travelTime)}</span>
        <span class="text-muted-foreground truncate flex-1 min-w-0">
            ${esc(l.from.systemName || '?')} #${l.from.planetIndex}
            <i class="fa-solid fa-arrow-right mx-1 text-zinc-600"></i>
            ${esc(l.to.systemName || '?')} #${l.to.planetIndex}
        </span>
        <span class="text-zinc-500 shrink-0">dist ${l.distance}</span>
        ${warn}
        ${allied}
        ${times}
      </div>
      ${renderJumpPoint(l.jumpPoint)}
    </div>`;
}

// ─── SAVE / LOAD ──────────────────────────────────────────────────────────────

async function save() {
    const msg = $('rp-save-msg');
    const btn = $('rp-save');
    btn.disabled = true;
    msg.textContent = 'Saving…';
    try {
        const payload = currentPayload();
        const url = editingId ? `/hub-api/routes/${editingId}` : '/hub-api/routes';
        const d = await getJson(url, {
            method: editingId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        editingId = d.id;
        msg.textContent = 'Saved.';
        if (typeof window.showToast === 'function') window.showToast('Route saved');
        const routes = await loadShared();
        const saved = routes?.find(route => route.id === d.id);
        let unchanged = false;
        try { unchanged = JSON.stringify(currentPayload()) === JSON.stringify(payload); }
        catch { /* The member may be midway through editing the next date. */ }
        if (saved && editingId === d.id && unchanged) {
            // Saving recalculates durations. Show the snapshot actually written, even
            // if ownership changed since the preview, but never replace newer edits.
            cancelPendingWork();
            renderPreview(saved, !!saved.targetArrivalAt);
        }
    } catch (err) {
        msg.textContent = err.message;
    } finally {
        btn.disabled = false;
        setTimeout(() => { if (msg.textContent === 'Saved.') msg.textContent = ''; }, 3000);
    }
}

function resetForm() {
    cancelPendingWork();
    editingId = null;
    $('rp-title').value = '';
    $('rp-note').value = '';
    $('rp-start').value = '';
    $('rp-schedule-mode').value = 'start';
    scheduleInput.setMode('start');
    updateScheduleLabel();
    $('rp-shared').checked = true;
    renderWaypoints([{ systemId: null, planetIndex: 1, label: '' }, { systemId: null, planetIndex: 1, label: '' }]);
    $('rp-save-msg').textContent = '';
    preview();
}

// Explicit Travel Calculator handoff: create a new plan from this flight, without
// overwriting a saved route or carrying over its date, biology or player selection.
export function loadRouteDraft(draft) {
    cancelPendingWork();
    editingId = null;
    $('rp-title').value = '';
    $('rp-note').value = '';
    $('rp-start').value = '';
    $('rp-schedule-mode').value = 'start';
    scheduleInput.setMode('start');
    updateScheduleLabel();
    $('rp-energy').value = draft.energy ?? 0;
    $('rp-speed').value = draft.raceSpeed ?? 0;
    $('rp-biology').value = 0;
    $('rp-alliance').checked = !!draft.isAllianceMove;
    $('rp-shared').checked = true;
    $('rp-player-input').value = '';
    $('rp-player-dropdown').innerHTML = '';
    $('rp-player-dropdown').classList.add('hidden');
    $('rp-save-msg').textContent = '';
    renderWaypoints(draft.waypoints);
    return preview();
}

function loadIntoForm(route) {
    cancelPendingWork();
    editingId = route.id;
    $('rp-title').value = route.title || '';
    $('rp-note').value = route.note || '';
    $('rp-energy').value = route.energy || 0;
    $('rp-speed').value = route.raceSpeed || 0;
    $('rp-biology').value = route.biology || 0;
    $('rp-alliance').checked = !!route.isAllianceMove;
    $('rp-shared').checked = route.visibility !== 'private';
    const schedule = scheduleInput.load(route);
    $('rp-schedule-mode').value = schedule.mode;
    $('rp-start').value = schedule.value;
    updateScheduleLabel();

    const stops = [];
    route.legs.forEach((l, i) => {
        if (i === 0) stops.push({ systemId: l.from.systemId, planetIndex: l.from.planetIndex, label: `${l.from.systemName || 'Sys'} #${l.from.systemId}` });
        stops.push({ systemId: l.to.systemId, planetIndex: l.to.planetIndex, label: `${l.to.systemName || 'Sys'} #${l.to.systemId}` });
    });
    renderWaypoints(stops.length >= 2 ? stops : undefined);
    // A saved route is a duration snapshot. Opening it must show the same launch as
    // its shared card/announcement even if ownership or the travel model changed.
    // The first input edit requests a fresh calculation with the saved anchor intact.
    renderPreview(route, !!route.targetArrivalAt);
    $('rp-save-msg').textContent = `Editing "${route.title || 'untitled route'}" — Save to overwrite, New to start fresh.`;
    $('route-planner-panel')?.querySelector('.flex-1')?.scrollTo({ top: 0, behavior: 'smooth' });
}

export async function showSavedRoutes() {
    await loadShared();
    $('rp-shared-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function loadShared() {
    const box = $('rp-shared-list');
    if (!box) return;
    try {
        const d = await getJson('/hub-api/routes');
        if (!d.routes.length) {
            box.innerHTML = '<div class="text-xs text-muted-foreground">No routes shared yet.</div>';
            return [];
        }
        box.innerHTML = d.routes.map(r => {
            const mine = me.id != null && r.authorId === me.id;
            const canEdit = mine || me.role === 'admin' || r.authorId == null;
            const hops = r.legs.map(l => `${esc(l.to.systemName || '?')} #${l.to.planetIndex}`).join(' → ');
            const origin = r.legs.length ? `${esc(r.legs[0].from.systemName || '?')} #${r.legs[0].from.planetIndex}` : '?';
            const start = r.departsAt
                ? `starts <span title="${esc(fmtUtc(r.departsAt))} UTC">${esc(fmtLocal(r.departsAt))}</span>`
                : 'no schedule';
            const arrival = r.arrivesAt
                ? ` · ${r.targetArrivalAt ? 'target arrival' : 'arrives'} <span title="${esc(fmtUtc(r.arrivesAt))} UTC">${esc(fmtLocal(r.arrivesAt))}</span>`
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
        return d.routes;
    } catch (err) {
        box.innerHTML = `<div class="text-xs text-red-400">${esc(err.message)}</div>`;
    }
}

function wirePlayerSearch() {
    const input = $('rp-player-input'), drop = $('rp-player-dropdown');
    if (!input || !drop) return;
    input.addEventListener('input', async () => {
        clearAirports();
        const q = input.value.trim().toLowerCase();
        if (!q) { playerSeq.cancel(); drop.classList.add('hidden'); return; }
        const token = playerSeq.next();
        const players = await loadPlayers();
        if (!playerSeq.isCurrent(token)) return;
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
    const panel = $('route-planner-panel');
    $('close-route-planner-btn')?.addEventListener('click', () => {
        cancelPendingWork();
        panel?.classList.replace('translate-x-0', 'translate-x-full');
    });

    // archives.js runs this initialiser ONCE and afterwards only toggles the panel's
    // translate class, so "reopened" has to be observed rather than called. On open the
    // reference lists are refreshed if their TTL ran out (a reopen within the TTL costs no
    // request); on close, pending preview work is dropped.
    if (panel && typeof MutationObserver === 'function') {
        let wasOpen = panel.classList.contains('translate-x-0');
        new MutationObserver(() => {
            const open = panel.classList.contains('translate-x-0');
            if (open === wasOpen) return;
            wasOpen = open;
            if (open) refreshReferenceData();
            else cancelPendingWork();
        }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }

    $('rp-data-refresh')?.addEventListener('click', async (e) => {
        clearAirports();
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await refreshReferenceData({ force: true }); } finally { btn.disabled = false; }
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
    $('rp-find-airport')?.addEventListener('click', findAirports);
    ['rp-note', 'rp-shared'].forEach(id => {
        $(id)?.addEventListener('input', clearAirports);
        $(id)?.addEventListener('change', clearAirports);
    });

    document.querySelectorAll('#route-planner-panel .rp-in').forEach(el => {
        el.addEventListener('input', schedulePreview);
        el.addEventListener('change', schedulePreview);
    });

    $('rp-schedule-mode')?.addEventListener('change', () => {
        scheduleInput.setMode($('rp-schedule-mode').value);
        $('rp-start').value = '';
        updateScheduleLabel();
        schedulePreview();
    });
    const onDateEdit = () => {
        scheduleInput.edit();
        schedulePreview();
    };
    $('rp-start')?.addEventListener('input', onDateEdit);
    $('rp-start')?.addEventListener('change', onDateEdit);

    $('rp-save')?.addEventListener('click', save);
    $('rp-reset')?.addEventListener('click', resetForm);
    $('rp-refresh')?.addEventListener('click', loadShared);

    wirePlayerSearch();
    preview();
    loadShared();
    // One load of both lists per panel open at most — never one per keystroke.
    refreshReferenceData();
}
