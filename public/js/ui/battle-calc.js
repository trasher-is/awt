// Battle calculator panel — called from archives.js after the panel HTML is injected.
//
// This file is presentation only. The model itself (ship table, constants, survivors and
// win %) lives in ONE shared place: ../utils/battle-model.js. The side-effect import
// below runs that file and puts its API on globalThis, which is how the same physical
// file can also be require()d by the Discord bot and the server — see the header of
// battle-model.js and docs/battle-model.md.

import { esc } from '../utils/escape.js';
import '../utils/battle-model.js';
import '../utils/sb-buster.js';
import '../utils/race-inference.js';
import '../utils/race-estimate-display.js';

const M = globalThis.AWBattleModel;
const Buster = globalThis.AWSbBuster;
const { SHIPS, sbCV } = M;
const RaceDisplay = globalThis.AWRaceEstimateDisplay;
const selectedSides = { def: null, atk: null };
const selectionGeneration = { def: 0, atk: 0 };

let playerCache = null;

function fmt(n) {
    if (n === 0) return '0';
    const r = Math.round(n * 100) / 100;
    return r % 1 === 0 ? String(r) : r.toFixed(2);
}

// Read the panel inputs and hand them to the shared model. Clamping happens inside
// normalizeInputs() so the Discord !battle command applies exactly the same ranges.
// The normalised inputs are kept so render() can ask winBand() how wide the uncertainty
// is for this particular fight.
let lastInputs = { def: {}, atk: {} };

function fillPlayerStats(prefix, player, envelope = null) {
    const resolved = M.resolveStats(player, envelope);
    for (const [field, value] of Object.entries({ phys: resolved.phys, math: resolved.math,
        ra: resolved.ra, rd: resolved.rd, lvl: resolved.lvl })) {
        const input = document.getElementById(`bc-${prefix}-${field}`);
        if (input) input.value = value;
    }
}

async function loadRaceEnvelope(prefix, player, generation) {
    try {
        const response = await fetch(`/hub-api/intel/player/${encodeURIComponent(player.id)}/race-estimate`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (!data || data.success !== true || selectionGeneration[prefix] !== generation
            || Number(selectedSides[prefix]?.player.id) !== Number(player.id)) return;
        const currentPlayer = data.player && Number(data.player.id) === Number(player.id) ? data.player : player;
        selectedSides[prefix] = { ...data, player: currentPlayer };
        fillPlayerStats(prefix, currentPlayer, selectedSides[prefix]);
        render();
    } catch (_) {
        // Failure preserves the selected player's observed intel/worst-case inputs.
        // It can never promote an old or unavailable estimate.
    }
}

function raceComparisonHtml() {
    const rows = RaceDisplay.comparisonRows(lastInputs, selectedSides);
    if (!rows.length) return '';
    const band = value => value ? `${value.low === value.high ? value.low : `${value.low}–${value.high}`}%` : 'unavailable';
    const assumptions = ['def', 'atk'].map(side => {
        const selected = selectedSides[side];
        const source = selected ? M.resolveStats(selected.player, selected).source : 'manual inputs';
        const label = source === 'estimate' ? 'estimate — confirmed by LLM' : source === 'worst' ? 'worst case' : source;
        return `${side === 'def' ? 'Defender' : 'Attacker'}: ${label}`;
    }).join(' · ');
    return `<div class="w-full border-t border-border pt-3 text-xs" aria-label="Race sources and win-chance comparison">
        <p class="text-muted-foreground">${esc(assumptions)}</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">${rows.map(row => `<div class="rounded border border-border p-2">
            <strong>${esc(row.label)}</strong>
            <p>${row.values ? `Defender ${row.source === 'estimate' ? '~' : ''}${band(row.values.defender)} · Attacker ${row.source === 'estimate' ? '~' : ''}${band(row.values.attacker)}` : esc(row.reason || 'unavailable')}</p>
            ${row.values && row.reason ? `<p class="text-zinc-500">${esc(row.reason)}</p>` : ''}
        </div>`).join('')}</div>
    </div>`;
}

function calc() {
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;

    lastInputs = M.normalizeInputs({
        defFleet: [g('bc-def-d'), g('bc-def-c'), g('bc-def-b')],
        atkFleet: [g('bc-atk-d'), g('bc-atk-c'), g('bc-atk-b')],
        sbLevel: g('bc-def-sb'),
        def: { phys: g('bc-def-phys'), math: g('bc-def-math'),
               ra: g('bc-def-ra'), rd: g('bc-def-rd'), lvl: g('bc-def-lvl') },
        atk: { phys: g('bc-atk-phys'), math: g('bc-atk-math'),
               ra: g('bc-atk-ra'), rd: g('bc-atk-rd'), lvl: g('bc-atk-lvl') }
    });
    return M.simulate(lastInputs);
}

function render() {
    const r = calc();
    renderBuster();
    const el = document.getElementById('bc-results');
    if (!el) return;
    for (const box of [el, document.getElementById('bc-fight')]) {
        box?.classList.toggle('hidden', !r);
        box?.classList.toggle('flex', !!r);
    }
    if (!r) return;

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

    // Starbase result: the level left, fraction kept. The game fights the next battle with
    // that fraction (9.5 stays 9.5) even though its pages print whole levels.
    const sbResultLvl = r.sbLevelLeft;
    const sbRow = r.sbLvl > 0 ? `<div class="flex items-center gap-2 text-xs font-mono">
        <span class="w-20 text-muted-foreground">Starbase</span>
        <span class="text-emerald-300 font-semibold">lvl ${sbResultLvl.toFixed(2)}</span>
        <span class="text-zinc-600">/ ${r.sbLvl}</span>
        <span class="text-zinc-500 ml-auto">(${(r.survSB * 100).toFixed(1)}% CV left)</span>
    </div>` : '';

    const winColor = r.winD > 0.65 ? '#22c55e' : r.winA > 0.65 ? '#ef4444' : '#f59e0b';
    // Bar width uses the point estimate. The NUMBER is the band winBand() gives: the
    // model matches the in-game calculator to ±BASE_ERROR_PP, so the range is narrow.
    const winBarD  = (r.winD * 100).toFixed(1);
    const winBarA  = (r.winA * 100).toFixed(1);
    const bandD = M.winBand(r.winD, { sbLevel: r.sbLvl, defFleet: r.defFleet, atkFleet: r.atkFleet, def: lastInputs.def, atk: lastInputs.atk });
    const bandA = M.winBand(r.winA, { sbLevel: r.sbLvl, defFleet: r.defFleet, atkFleet: r.atkFleet, def: lastInputs.def, atk: lastInputs.atk });
    const caveatText = bandD.caveats.length
        ? ` This estimate is wider than usual because ${bandD.caveats.join(', and ')}.`
        : '';

    el.innerHTML = `
        ${raceComparisonHtml()}
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
            <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Estimated win chance</div>
            <div class="flex items-center gap-3">
                <span class="text-emerald-400 font-bold text-lg w-24 text-right font-mono">${bandD.text}</span>
                <div class="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                    <div class="h-full rounded transition-all duration-300" style="width:${winBarD}%;background:${winColor}"></div>
                </div>
                <span class="text-red-400 font-bold text-lg w-24 font-mono">${bandA.text}</span>
            </div>
            <div class="flex justify-between text-xs text-muted-foreground"><span>Defender</span><span>Attacker</span></div>
            <div class="text-xs text-zinc-600 mt-1">
                The same result as the game's own battle calculator, to within ±${M.uncertainty.BASE_ERROR_PP} points
                (win chance) across every recorded calculator result; survivors follow the same rules.${caveatText}
                It is only as good as the inputs: an enemy's sciences, race or level that are out of date move the real chance far more.
            </div>
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
        selectedSides[prefix] = null;
        selectionGeneration[prefix]++;
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
                selectedSides[prefix] = { player: p };
                const generation = ++selectionGeneration[prefix];
                fillPlayerStats(prefix, p);
                render();
                void loadRaceEnvelope(prefix, p, generation);
            });
        });
    });

    input.addEventListener('blur', () => {
        setTimeout(() => dropdown.classList.add('hidden'), 150);
    });
}

// ─── SB BUSTER ────────────────────────────────────────────────────────────────
// Fewest ships per buster fleet to bring a starbase to a target level (sb-buster.js).
// Defender (and attacker) stats come from the calculator's own columns, so the player
// picker fills them. Pure local math: no game or hub request.
const SHIP_SHORT = { destroyers: 'DS', cruisers: 'CR', battleships: 'BS' };
function renderBuster() {
    const out = document.getElementById('bcb-out');
    if (!out || !Buster) return;
    const val = id => document.getElementById(id)?.value;
    const hidden = !!document.getElementById('bcb-hidden')?.checked;
    const start = Buster.worstCase(val('bcb-sb'), hidden);
    const target = M.clampStarbase(val('bcb-target'));
    const fleets = Math.max(1, Math.min(12, parseInt(val('bcb-fleets'), 10) || 4));
    const ship = val('bcb-ship') || 'destroyers';
    const own = parseInt(val('bcb-own'), 10);
    const stats = { def: lastInputs.def, atk: lastInputs.atk };
    const short = SHIP_SHORT[ship] || 'DS';

    const table = steps => steps.length ? `<table class="w-full text-xs tabular-nums">
        <thead><tr class="text-muted-foreground border-b border-zinc-800">
            <th class="py-1 pr-2 text-left font-normal">Fleet</th><th class="py-1 px-2 text-right font-normal">Ships</th>
            <th class="py-1 px-2 text-right font-normal">SB after</th><th class="py-1 pl-2 text-right font-normal">Fleet wins</th>
        </tr></thead>
        <tbody>${steps.map(s => `<tr class="border-b border-zinc-800/50">
            <td class="py-1 pr-2 text-muted-foreground">#${s.fleet}</td>
            <td class="py-1 px-2 text-right font-mono">${s.ships} ${short}</td>
            <td class="py-1 px-2 text-right font-mono text-emerald-300">${s.before.toFixed(2)} → ${s.after.toFixed(2)}</td>
            <td class="py-1 pl-2 text-right font-mono ${s.winA > 0 ? 'text-amber-400' : 'text-zinc-500'}">${(s.winA * 100).toFixed(1)}%</td>
        </tr>`).join('')}</tbody></table>` : '';

    const p = Buster.plan({ sbLevel: start, target, fleets, ship, ...stats });
    const from = `SB ${start.toFixed(2)}${hidden && start !== M.clampStarbase(val('bcb-sb')) ? ' (visible ' + esc(String(M.clampStarbase(val('bcb-sb')))) + ')' : ''}`;
    let html;
    if (p.reason === 'already_at_target') html = `<div class="text-muted-foreground">${from} is already at or below level ${target}.</div>`;
    else if (p.reason === 'below_level_1') html = `<div class="text-amber-400">A starbase defending alone never ends a fight below level 1, so busters that lose cannot take it under 1. Your main fleet has to win that fight.</div>`;
    else if (p.reason === 'too_many') html = `<div class="text-red-400">More than a million ${short} per fleet. Try more fleets or bigger ships.</div>`;
    else {
        html = `<div>${from} → level ${target}: send <b class="text-foreground">${fleets} × ${p.perFleet} ${short}</b>
            <span class="text-muted-foreground">(${p.total} ${short}), one fleet after another before the main fleet.</span></div>`
            + table(p.steps);
        if (p.steps.some(s => s.winA > 0)) html += `<div class="text-xs text-amber-400">A buster fleet that wins takes the starbase out completely. The table shows the levels left when each fleet loses.</div>`;
    }
    if (own > 0) {
        const c = Buster.chainFor({ sbLevel: start, perFleet: own, fleets, ship, ...stats });
        html += `<div class="mt-2 text-xs text-muted-foreground">${fleets} × ${own} ${short}: SB ends at <b class="${c.end <= target ? 'text-emerald-400' : 'text-red-400'}">${c.end.toFixed(2)}</b>.</div>`
            + (own === p.perFleet ? '' : table(c.steps));
    }
    out.innerHTML = html;
}

export function initBattleCalc() {
    document.getElementById('close-battle-calc-btn')?.addEventListener('click', () => {
        document.getElementById('battle-calc-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    });

    document.querySelectorAll('#battle-calc-panel .bc-num-input').forEach(el => {
        el.addEventListener('input', () => {
            const side = el.id?.match(/^bc-(def|atk)-/)?.[1];
            if (side) { selectedSides[side] = null; selectionGeneration[side]++; }
            render();
        });
    });

    // The fight window is only loaded when someone actually taps Fight.
    document.getElementById('bc-fight-btn')?.addEventListener('click', async () => {
        const r = calc();
        if (!r) return;
        const { openFightSimulation } = await import('./battle-anim.js');
        openFightSimulation(r);
    });

    document.querySelectorAll('#battle-calc-panel .bcb-in').forEach(el => {
        el.addEventListener('input', renderBuster);
        el.addEventListener('change', renderBuster);
    });
    renderBuster();

    setupPlayerSearch('bc-def-player-input', 'bc-def-player-dropdown', 'def');
    setupPlayerSearch('bc-atk-player-input', 'bc-atk-player-dropdown', 'atk');
}
