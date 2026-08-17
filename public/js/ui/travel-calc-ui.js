// Travel calculator panel — called from archives.js after the panel is injected.
//
// This file no longer carries its own copy of the formula. It used to mirror the server
// one by hand, which is how a panel and a Discord alert could quote different times for
// the same route. Both now run ../utils/travel-model.js; the side-effect import below
// runs that file and puts its API on globalThis.

import { esc } from '../utils/escape.js';
import '../utils/travel-model.js';
import '../utils/battle-model.js';   // side-effect import: cvOf for the system view
import '../utils/game-rate-limit.js'; // side-effect import: the shared 5/s gate AWApi rides
import '../utils/aw-api.js';          // side-effect import: game REST client on globalThis

const { calcTravelSeconds, formatTime: fmt, systemDistance } = globalThis.AWTravelModel;
const { getTravelTime, getSystemPlanets, mapPlanetsToSyncPayload } = globalThis.AWApi;

let sysCache = null, playerCache = null;

// ─── GAME-SERVER TRAVEL TIME (v2) ─────────────────────────────────────────────
// The local formula renders instantly and stays the authority by default. When both
// endpoints came from the system picker (so their game ids are known) and the alliance
// box is unchecked, a debounced GET /api/v1/Fleet/travelTime adds the game's own answer
// as the primary display; the local value stays visible beneath it. The API line is
// skipped for alliance moves (the endpoint's semantics for allied halving are
// unverified) and for manually typed coordinates (the endpoint takes system ids).
const API_DEBOUNCE_MS = 400;
const MISMATCH_WARN_SECONDS = 2;

// System ids are only known when the user picked from the dropdown; typing into the
// X/Y boxes clears them (the coordinates no longer describe the picked system).
let origSysId = null, destSysId = null;
// Debounce timer + a sequence token so a slow response never paints over newer inputs.
let apiTimer = null, apiSeq = 0;

function render() {
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;
    const sx = g('tc-orig-x'), sy = g('tc-orig-y'), sp = Math.max(1, g('tc-orig-p'));
    const ex = g('tc-dest-x'), ey = g('tc-dest-y'), ep = Math.max(1, g('tc-dest-p'));
    const energy = Math.max(0, g('tc-energy'));
    const speed = Math.max(-4, Math.min(4, g('tc-speed')));
    const alliance = document.getElementById('tc-alliance')?.checked;

    const secs = calcTravelSeconds(sx, sy, sp, ex, ey, ep, energy, speed, alliance);
    document.getElementById('tc-time').textContent = fmt(secs);

    const sameSys = (sx === ex && sy === ey);
    const dist = sameSys ? 0 : systemDistance(sx, sy, ex, ey);
    const meta = sameSys
        ? `Same system · ${Math.abs(sp - ep)} planet slots apart`
        : `Deep space · distance ${dist.toFixed(2)}`;
    const half = alliance ? '' : ` · allied would be ${fmt(Math.floor(secs * 0.5))}`;
    document.getElementById('tc-meta').textContent = meta + half;

    // Local is the authority again until the game server answers for THESE inputs:
    // invalidate any in-flight response, cancel the pending call, drop the API dressing.
    apiSeq++;
    if (apiTimer) { clearTimeout(apiTimer); apiTimer = null; }
    document.getElementById('tc-source-badge')?.classList.add('hidden');
    document.getElementById('tc-local-line')?.classList.add('hidden');

    const eligible = origSysId != null && destSysId != null && !alliance;
    if (!eligible) {
        document.getElementById('tc-api-note')?.classList.add('hidden');
        return;
    }
    const params = { fromSystem: origSysId, fromPlanetIndex: sp, toSystem: destSysId, toPlanetIndex: ep, energyLevel: energy };
    const context = { ...params, from: [sx, sy], to: [ex, ey], raceSpeed: speed, alliance: !!alliance, localSeconds: secs };
    apiTimer = setTimeout(() => { apiTimer = null; showApiTime(params, context); }, API_DEBOUNCE_MS);
}

async function showApiTime(params, context) {
    const seq = ++apiSeq;
    const res = await getTravelTime(params);
    if (seq !== apiSeq) return; // inputs changed while this was in flight

    const note = document.getElementById('tc-api-note');
    const total = res.ok && res.data ? res.data.totalSeconds : null;
    if (typeof total !== 'number' || !isFinite(total)) {
        // Local-only degradation: the big number is already correct, so just say quietly
        // why there is no server line. No console noise — an expired session or a game
        // outage is not this panel's error to shout about.
        if (note) {
            note.textContent = res.reason === 'session'
                ? 'Game session unavailable — using local formula.'
                : 'Game server unavailable — using local formula.';
            note.classList.remove('hidden');
        }
        return;
    }

    // totalSeconds may be fractional; formatTime assumes integers, so round first.
    const apiSecs = Math.round(total);
    document.getElementById('tc-time').textContent = fmt(apiSecs);
    document.getElementById('tc-source-badge')?.classList.remove('hidden');
    const localLine = document.getElementById('tc-local-line');
    if (localLine) {
        localLine.textContent = `local formula: ${fmt(context.localSeconds)}`;
        localLine.classList.remove('hidden');
    }
    note?.classList.add('hidden');

    // A real disagreement is calibration data — log it with everything needed to turn it
    // into a fixture. Expected sources of routine mismatch: the API answers for the
    // logged-in player (their race speed is baked in, so a speed typed for someone else
    // diverges by design), and a speed-paced round (RedZone x10) the local formula does
    // not model.
    if (Math.abs(apiSecs - context.localSeconds) > MISMATCH_WARN_SECONDS) {
        console.warn('[travel-calc] game API and local formula disagree', { ...context, apiSeconds: apiSecs });
    }
}

async function loadSystems() {
    if (sysCache) return sysCache;
    try {
        const r = await fetch('/hub-api/intel/systems_db');
        const d = await r.json();
        if (d.success) sysCache = d.systems;
    } catch (e) {}
    return sysCache || [];
}
async function loadPlayers() {
    if (playerCache) return playerCache;
    try {
        const r = await fetch('/hub-api/intel/players');
        const d = await r.json();
        if (d.success) playerCache = d.players;
    } catch (e) {}
    return playerCache || [];
}

function wireSystemSearch(inputId, dropId, xId, yId, onPick) {
    const input = document.getElementById(inputId), drop = document.getElementById(dropId);
    if (!input || !drop) return;
    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { drop.classList.add('hidden'); return; }
        const systems = await loadSystems();
        const matches = systems.filter(s =>
            (s.name && s.name.toLowerCase().includes(q)) || String(s.id).includes(q)).slice(0, 12);
        if (!matches.length) { drop.classList.add('hidden'); return; }
        drop.classList.remove('hidden');
        drop.innerHTML = matches.map(s =>
            `<button data-x="${s.x}" data-y="${s.y}" data-id="${s.id}" data-name="${esc(s.name || 'Sys')}" class="tc-sys-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${esc(s.name || 'Sys')} #${s.id}</span>
                <span class="text-zinc-500 ml-auto">${s.x}/${s.y}</span>
            </button>`).join('');
        drop.querySelectorAll('.tc-sys-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            document.getElementById(xId).value = btn.dataset.x;
            document.getElementById(yId).value = btn.dataset.y;
            // Reflect the chosen system back into the search box (was showing the typed text).
            input.value = `${btn.dataset.name} #${btn.dataset.id}`;
            drop.classList.add('hidden');
            // onPick BEFORE render: render() reads the picked system id to decide whether
            // the game-server travel time applies, so the id must be recorded first.
            if (onPick) onPick(parseInt(btn.dataset.id, 10));
            render();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
}

function wirePlayerSearch() {
    const input = document.getElementById('tc-player-input'), drop = document.getElementById('tc-player-dropdown');
    if (!input || !drop) return;
    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { drop.classList.add('hidden'); return; }
        const players = await loadPlayers();
        const matches = players.filter(p => p.name && p.name.toLowerCase().includes(q)).slice(0, 12);
        if (!matches.length) { drop.classList.add('hidden'); return; }
        drop.classList.remove('hidden');
        drop.innerHTML = matches.map(p =>
            `<button data-e="${p.energy||0}" data-s="${p.race_speed||0}" data-name="${esc(p.name || '')}" class="tc-pl-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${esc(p.name)}</span>
                <span class="text-zinc-500 ml-auto">E${p.energy||0} spd${p.race_speed||0}</span>
            </button>`).join('');
        drop.querySelectorAll('.tc-pl-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            document.getElementById('tc-energy').value = btn.dataset.e;
            document.getElementById('tc-speed').value = btn.dataset.s;
            // Reflect the chosen player name back into the search box.
            input.value = btn.dataset.name;
            drop.classList.add('hidden');
            render();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
}

const { cvOf } = globalThis.AWBattleModel;

async function renderSystemView(sysId) {
    const box = document.getElementById('tc-system-view');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = `<div class="text-xs text-muted-foreground">Loading system #${sysId}…</div>`;
    try {
        const r = await fetch(`/hub-api/intel/system/${sysId}`);
        const d = await r.json();
        if (!d.success) { box.innerHTML = `<div class="text-xs text-red-400">System #${sysId} not in database — scan it in-game.</div>`; return; }

        const planetRows = (d.planets || []).map(p => {
            const owner = p.owner_name ? `${p.alliance_tag ? `[${esc(p.alliance_tag)}] ` : ''}${esc(p.owner_name)}` : '<span class="text-zinc-600">—</span>';
            const plan = (d.plans || []).find(pl => pl.planet_index === p.planet_index);
            return `<tr class="border-b border-zinc-800/50">
                <td class="py-0.5 pr-2 text-zinc-400">#${p.planet_index}</td>
                <td class="py-0.5 pr-2 text-foreground">${owner}</td>
                <td class="py-0.5 pr-2 text-right tabular-nums">${p.population || 0}</td>
                <td class="py-0.5 pr-2 text-right tabular-nums">${p.starbase || 0}</td>
                <td class="py-0.5 text-zinc-400">${plan ? '📝' : ''}</td>
            </tr>`;
        }).join('');

        const fleetRows = (d.fleets || []).sort((a, b) => a.planet_index - b.planet_index).map(f => {
            const owner = f.owner_name ? `${f.alliance_tag ? `[${esc(f.alliance_tag)}] ` : ''}${esc(f.owner_name)}` : '?';
            const ships = [
                f.transports && `${f.transports}TR`, f.colony_ships && `${f.colony_ships}CS`,
                f.destroyers && `${f.destroyers}DS`, f.cruisers && `${f.cruisers}CR`, f.battleships && `${f.battleships}BS`
            ].filter(Boolean).join(' ');
            return `<tr class="border-b border-zinc-800/50">
                <td class="py-0.5 pr-2 text-zinc-400">#${f.planet_index}</td>
                <td class="py-0.5 pr-2 text-foreground">${owner}</td>
                <td class="py-0.5 pr-2 text-right tabular-nums">${cvOf(f).toLocaleString()} CV</td>
                <td class="py-0.5 text-zinc-500">${esc(ships)}</td>
            </tr>`;
        }).join('');

        box.innerHTML = `
            <div class="flex items-center justify-between mb-2">
                <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">🎯 Target System #${sysId}</div>
                <div class="flex items-center gap-3">
                    <button id="tc-sys-update" class="text-xs text-emerald-400 hover:underline">Update</button>
                    <a href="/Game/Map/SolarSystem/${sysId}" target="_blank" class="text-xs text-blue-400 hover:underline">Open live ↗</a>
                </div>
            </div>
            <table class="w-full text-xs"><tbody>${planetRows || '<tr><td class="text-zinc-600 text-xs">No planets recorded.</td></tr>'}</tbody></table>
            ${fleetRows ? `<div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-3 mb-1">🚀 Fleets</div>
            <table class="w-full text-xs"><tbody>${fleetRows}</tbody></table>` : ''}
        `;

        // "Update" refreshes the hub's intel for this system, then re-renders. The game
        // API is asked first (one rate-gated GET instead of a full page scrape); when it
        // cannot answer — expired session, outage — the old DOM scrape still works.
        document.getElementById('tc-sys-update')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'Updating…';
            let ok = false;
            const res = await getSystemPlanets(sysId);
            if (res.ok && Array.isArray(res.data)) {
                // Same payload shape the scraper POSTs, built by the one shared mapper.
                // No scrape fallback past this point: the sync target is the hub itself,
                // and the scraper POSTs to the same route — it would fail the same way.
                try {
                    const r = await fetch('/hub-api/sync/system', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(mapPlanetsToSyncPayload(sysId, res.data)),
                    });
                    const d = await r.json();
                    ok = !!d.success;
                } catch (err) { ok = false; }
            } else {
                const { scrapeSystemById } = await import('../scrapers/system-parser.js');
                ok = await scrapeSystemById(sysId);
            }
            if (typeof window.showToast === 'function') {
                window.showToast(ok ? `System #${sysId} updated` : `Could not update system #${sysId}`);
            }
            renderSystemView(sysId); // re-fetch the freshly-synced data
        });
    } catch (e) {
        box.innerHTML = `<div class="text-xs text-red-400">Failed to load system view.</div>`;
    }
}

export function initTravelCalc() {
    document.getElementById('close-travel-calc-btn')?.addEventListener('click', () => {
        document.getElementById('travel-calc-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    });
    // Typing into a coordinate box forgets the picked system id — registered BEFORE the
    // render listeners below so render() never captures a stale id. (The picker sets
    // .value programmatically, which fires no 'input' event, so picks survive this.)
    [['tc-orig-x', 'tc-orig-y'], ['tc-dest-x', 'tc-dest-y']].forEach(([xId, yId], i) => {
        const clear = () => { if (i === 0) origSysId = null; else destSysId = null; };
        document.getElementById(xId)?.addEventListener('input', clear);
        document.getElementById(yId)?.addEventListener('input', clear);
    });
    document.querySelectorAll('#travel-calc-panel .tc-in').forEach(el => {
        el.addEventListener('input', render);
        el.addEventListener('change', render);
    });
    wireSystemSearch('tc-orig-sys-input', 'tc-orig-sys-dropdown', 'tc-orig-x', 'tc-orig-y',
        id => { origSysId = id; });
    wireSystemSearch('tc-dest-sys-input', 'tc-dest-sys-dropdown', 'tc-dest-x', 'tc-dest-y',
        id => { destSysId = id; renderSystemView(id); });
    wirePlayerSearch();
    render();
}
