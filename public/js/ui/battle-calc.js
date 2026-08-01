// Battle calculator panel — called from archives.js after the panel HTML is injected.
//
// This file is presentation only. The model itself (ship table, constants, survivors and
// win %) lives in ONE shared place: ../utils/battle-model.js. The side-effect import
// below runs that file and puts its API on globalThis, which is how the same physical
// file can also be require()d by the Discord bot and the server — see the header of
// battle-model.js and docs/battle-model.md.

import { esc } from '../utils/escape.js';
import '../utils/battle-model.js';

const M = globalThis.AWBattleModel;
const { SHIPS, sbCV } = M;

let playerCache = null;

function fmt(n) {
    if (n === 0) return '0';
    const r = Math.round(n * 100) / 100;
    return r % 1 === 0 ? String(r) : r.toFixed(2);
}

// Read the panel inputs and hand them to the shared model. Clamping happens inside
// normalizeInputs() so the Discord !battle command applies exactly the same ranges.
function calc() {
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;

    return M.simulate(M.normalizeInputs({
        defFleet: [g('bc-def-d'), g('bc-def-c'), g('bc-def-b')],
        atkFleet: [g('bc-atk-d'), g('bc-atk-c'), g('bc-atk-b')],
        sbLevel: g('bc-def-sb'),
        def: { phys: g('bc-def-phys'), math: g('bc-def-math'),
               ra: g('bc-def-ra'), rd: g('bc-def-rd'), lvl: g('bc-def-lvl') },
        atk: { phys: g('bc-atk-phys'), math: g('bc-atk-math'),
               ra: g('bc-atk-ra'), rd: g('bc-atk-rd'), lvl: g('bc-atk-lvl') }
    }));
}

function render() {
    const r = calc();
    const el = document.getElementById('bc-results');
    if (!el) return;
    if (!r) { el.classList.add('hidden'); el.classList.remove('flex'); return; }
    el.classList.remove('hidden');
    el.classList.add('flex');

    const shipRows = (fleet, surv, side) => SHIPS.map((s, i) => {
        if (fleet[i] === 0) return '';
        const lost = fleet[i] - surv[i];
        const pct  = fleet[i] > 0 ? (surv[i] / fleet[i] * 100).toFixed(1) : '0.0';
        const color = side === 'def' ? 'text-emerald-300' : 'text-red-300';
        return `<div class="flex items-center gap-2 text-xs font-mono">
            <span class="w-20 text-muted-foreground">${s.name}</span>
            <span class="${color} font-semibold">${fmt(surv[i])}</span>
            <span class="text-zinc-600">/ ${fleet[i]}</span>
            <span class="text-zinc-500 ml-auto">(${pct}% survive, −${fmt(lost)})</span>
        </div>`;
    }).join('');

    // Starbase result is shown as the level its surviving CV maps back to (matches the game).
    const sbRemCv = r.survSB * sbCV(r.sbLvl);
    const sbResultLvl = sbRemCv > 0 ? Math.log((sbRemCv + 4) / 4) / Math.log(1.5) : 0;
    const sbRow = r.sbLvl > 0 ? `<div class="flex items-center gap-2 text-xs font-mono">
        <span class="w-20 text-muted-foreground">Starbase</span>
        <span class="text-emerald-300 font-semibold">lvl ${sbResultLvl.toFixed(2)}</span>
        <span class="text-zinc-600">/ ${r.sbLvl}</span>
        <span class="text-zinc-500 ml-auto">(${(r.survSB * 100).toFixed(1)}% CV left)</span>
    </div>` : '';

    const winColor = r.winD > 0.65 ? '#22c55e' : r.winA > 0.65 ? '#ef4444' : '#f59e0b';
    const winBarD  = (r.winD * 100).toFixed(1);
    const winBarA  = (r.winA * 100).toFixed(1);

    el.innerHTML = `
        <div class="grid grid-cols-2 gap-4 w-full">
            <div class="flex flex-col gap-2">
                <div class="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1">Defender survivors</div>
                ${shipRows(r.defFleet, r.survDef, 'def') || '<div class="text-xs text-zinc-600">No ships</div>'}
                ${sbRow}
                <div class="flex items-center gap-2 text-xs mt-1 border-t border-border/40 pt-1">
                    <span class="text-muted-foreground">CV</span>
                    <span class="text-emerald-300 font-mono font-semibold">${fmt(r.cvDefRemain)}</span>
                    <span class="text-zinc-600 font-mono">/ ${r.initCVD} (−${fmt(r.initCVD - r.cvDefRemain)})</span>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <div class="text-xs font-semibold text-red-400 uppercase tracking-wider mb-1">Attacker survivors</div>
                ${shipRows(r.atkFleet, r.survAtk, 'atk') || '<div class="text-xs text-zinc-600">No ships</div>'}
                <div class="flex items-center gap-2 text-xs mt-1 border-t border-border/40 pt-1">
                    <span class="text-muted-foreground">CV</span>
                    <span class="text-red-300 font-mono font-semibold">${fmt(r.cvAtkRemain)}</span>
                    <span class="text-zinc-600 font-mono">/ ${r.initCVA} (−${fmt(r.initCVA - r.cvAtkRemain)})</span>
                </div>
            </div>
        </div>
        <div class="border-t border-border pt-4 flex flex-col gap-2 w-full">
            <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Win probability</div>
            <div class="flex items-center gap-3">
                <span class="text-emerald-400 font-bold text-lg w-16 text-right font-mono">${winBarD}%</span>
                <div class="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                    <div class="h-full rounded transition-all duration-300" style="width:${winBarD}%;background:${winColor}"></div>
                </div>
                <span class="text-red-400 font-bold text-lg w-16 font-mono">${winBarA}%</span>
            </div>
            <div class="flex justify-between text-xs text-muted-foreground"><span>Defender</span><span>Attacker</span></div>
            <div class="text-xs text-zinc-600 mt-1">Calibrated to the in-game calculator (±3%). The losing side's survivors can read slightly high in a lopsided math mismatch, and a starbase + fleet together is approximate.</div>
        </div>
    `;
}

async function loadPlayers() {
    if (playerCache) return playerCache;
    try {
        const res = await fetch('/hub-api/intel/players');
        const data = await res.json();
        if (data.success) playerCache = data.players;
    } catch (e) {}
    return playerCache || [];
}

function setupPlayerSearch(inputId, dropdownId, prefix) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    input.addEventListener('input', async () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { dropdown.classList.add('hidden'); return; }

        const players = await loadPlayers();
        const matches = players.filter(p => p.name && p.name.toLowerCase().includes(q)).slice(0, 12);

        if (matches.length === 0) { dropdown.classList.add('hidden'); return; }

        dropdown.classList.remove('hidden');
        dropdown.innerHTML = matches.map(p => {
            const intel = p.has_intel ? `<span class="text-zinc-500 ml-auto">L${p.level||0} phy${p.physics||0}</span>` : '';
            return `<button data-pid="${p.id}" class="bc-player-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors">
                <span class="text-foreground font-medium truncate">${esc(p.name)}</span>
                ${intel}
            </button>`;
        }).join('');

        dropdown.querySelectorAll('.bc-player-pick').forEach(btn => {
            btn.addEventListener('mousedown', e => {
                e.preventDefault();
                const p = players.find(x => String(x.id) === btn.dataset.pid);
                if (!p) return;
                input.value = p.name;
                dropdown.classList.add('hidden');
                const set = (id, val) => {
                    const el = document.getElementById(id);
                    if (el && val != null) el.value = val;
                };
                set(`bc-${prefix}-phys`, p.physics      || 0);
                set(`bc-${prefix}-math`, p.mathematics  || 0);
                set(`bc-${prefix}-ra`,   p.race_attack   || 0);
                set(`bc-${prefix}-rd`,   p.race_defense  || 0);
                set(`bc-${prefix}-lvl`,  p.level         || 0);
                render();
            });
        });
    });

    input.addEventListener('blur', () => {
        setTimeout(() => dropdown.classList.add('hidden'), 150);
    });
}

export function initBattleCalc() {
    document.getElementById('close-battle-calc-btn')?.addEventListener('click', () => {
        document.getElementById('battle-calc-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    });

    document.querySelectorAll('#battle-calc-panel .bc-num-input').forEach(el => {
        el.addEventListener('input', render);
    });

    setupPlayerSearch('bc-def-player-input', 'bc-def-player-dropdown', 'def');
    setupPlayerSearch('bc-atk-player-input', 'bc-atk-player-dropdown', 'atk');
}
