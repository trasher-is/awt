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

function wireSystemSearch(inputId, dropId, xId, yId) {
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
            `<button data-x="${s.x}" data-y="${s.y}" class="tc-sys-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${s.name || 'Sys'} #${s.id}</span>
                <span class="text-zinc-500 ml-auto">${s.x}/${s.y}</span>
            </button>`).join('');
        drop.querySelectorAll('.tc-sys-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            document.getElementById(xId).value = btn.dataset.x;
            document.getElementById(yId).value = btn.dataset.y;
            drop.classList.add('hidden');
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
            `<button data-e="${p.energy||0}" data-s="${p.race_speed||0}" class="tc-pl-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${p.name}</span>
                <span class="text-zinc-500 ml-auto">E${p.energy||0} spd${p.race_speed||0}</span>
            </button>`).join('');
        drop.querySelectorAll('.tc-pl-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            document.getElementById('tc-energy').value = btn.dataset.e;
            document.getElementById('tc-speed').value = btn.dataset.s;
            drop.classList.add('hidden');
            render();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
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
    wireSystemSearch('tc-dest-sys-input', 'tc-dest-sys-dropdown', 'tc-dest-x', 'tc-dest-y');
    wirePlayerSearch();
    render();
}
