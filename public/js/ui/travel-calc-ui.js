// Travel calculator panel logic — called from archives.js after the panel is injected.
// Mirrors the server formula in src/utils/travel-calc.js (verified exact to 0s).

function calcTravelSeconds(sx, sy, sp, ex, ey, ep, energy, speed, alliance) {
    const mod = Math.pow(0.91, energy) / (1 + 0.11 * speed);
    const planetTerm = Math.sqrt(Math.abs(sp - ep) + 1);
    let t;
    if (sx === ex && sy === ey) {
        t = 1200 + 14400 * planetTerm * mod;              // same system, 20-min min
    } else {
        const dist = Math.hypot(ex - sx, ey - sy);
        t = 2700 + (36000 * dist + 3600 * planetTerm) * mod; // deep space, 45-min min
    }
    t = Math.floor(t);
    return alliance ? Math.floor(t * 0.5) : t;
}

function fmt(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

let sysCache = null, playerCache = null;

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
    const dist = sameSys ? 0 : Math.hypot(ex - sx, ey - sy);
    const meta = sameSys
        ? `Same system · ${Math.abs(sp - ep)} planet slots apart`
        : `Deep space · distance ${dist.toFixed(2)}`;
    const half = alliance ? '' : ` · allied would be ${fmt(Math.floor(secs * 0.5))}`;
    document.getElementById('tc-meta').textContent = meta + half;
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
            `<button data-x="${s.x}" data-y="${s.y}" data-id="${s.id}" data-name="${(s.name || 'Sys').replace(/"/g, '&quot;')}" class="tc-sys-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${s.name || 'Sys'} #${s.id}</span>
                <span class="text-zinc-500 ml-auto">${s.x}/${s.y}</span>
            </button>`).join('');
        drop.querySelectorAll('.tc-sys-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            document.getElementById(xId).value = btn.dataset.x;
            document.getElementById(yId).value = btn.dataset.y;
            // Reflect the chosen system back into the search box (was showing the typed text).
            input.value = `${btn.dataset.name} #${btn.dataset.id}`;
            drop.classList.add('hidden');
            render();
            if (onPick) onPick(parseInt(btn.dataset.id, 10));
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
            `<button data-e="${p.energy||0}" data-s="${p.race_speed||0}" data-name="${(p.name || '').replace(/"/g, '&quot;')}" class="tc-pl-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${p.name}</span>
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

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cvOf = (f) => (f.destroyers || 0) * 3 + (f.cruisers || 0) * 24 + (f.battleships || 0) * 60;

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

        // "Update" pulls the live system map, parses + syncs it, then re-renders.
        document.getElementById('tc-sys-update')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'Updating…';
            const { scrapeSystemById } = await import('../scrapers/system-parser.js');
            const ok = await scrapeSystemById(sysId);
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
    document.querySelectorAll('#travel-calc-panel .tc-in').forEach(el => {
        el.addEventListener('input', render);
        el.addEventListener('change', render);
    });
    wireSystemSearch('tc-orig-sys-input', 'tc-orig-sys-dropdown', 'tc-orig-x', 'tc-orig-y');
    wireSystemSearch('tc-dest-sys-input', 'tc-dest-sys-dropdown', 'tc-dest-x', 'tc-dest-y', renderSystemView);
    wirePlayerSearch();
    render();
}
