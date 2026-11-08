// Speed Rules panel — defender vs attacker under today's travel rule and a proposed one.
//
// The proposal: race speed also shrinks the fixed 20/45-minute minimum of every flight
// (travel-model opts.fixedSpeedStep). Player A (defender) and Player B (attacker) fly to the
// same destination; the panel shows both flight times under both rules and who lands first.
//
// Pure local math on the shared travel model. The only requests are the hub's own player
// and system lists for the pickers — never the game.

import { esc } from '../utils/escape.js';
import '../utils/travel-model.js';

const { calcTravelSeconds, formatTime: fmt, systemDistance, fixedMinimums } = globalThis.AWTravelModel;

let systemsCache = null, playersCache = null;

async function loadList(url, key) {
    try {
        const r = await fetch(url);
        const d = await r.json();
        if (d.success && Array.isArray(d[key])) return d[key];
    } catch (e) { /* the pickers just stay empty; typing by hand still works */ }
    return null;
}
async function loadSystems() { return systemsCache || (systemsCache = await loadList('/hub-api/intel/systems_db', 'systems')) || []; }
async function loadPlayers() { return playersCache || (playersCache = await loadList('/hub-api/intel/players', 'players')) || []; }

const $ = id => document.getElementById(id);
const num = (id, lo, hi, fallback = 0) => {
    const v = parseFloat($(id)?.value);
    return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : fallback));
};

function readSide(prefix) {
    return {
        energy: num(`sr-${prefix}-energy`, 0, 100),
        speed: num(`sr-${prefix}-speed`, -4, 4),
        at: [num(`sr-${prefix}-x`, -1e6, 1e6), num(`sr-${prefix}-y`, -1e6, 1e6), num(`sr-${prefix}-p`, 1, 12, 1)],
    };
}

function flight(side, dest, allied, opts) {
    return calcTravelSeconds(...side.at, ...dest, side.energy, side.speed, allied, opts);
}

// "0:12:05" without the leading zero hour padding, for margins.
function span(seconds) {
    const s = Math.abs(seconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function verdict(rule, a, b) {
    const diff = b - a; // > 0: the defender lands first
    if (diff === 0) return `<div><b>${rule}:</b> both land at the same second.</div>`;
    return diff > 0
        ? `<div><b>${rule}:</b> <span class="text-emerald-400 font-semibold">Defender lands ${span(diff)} before the attacker.</span></div>`
        : `<div><b>${rule}:</b> <span class="text-red-400 font-semibold">Attacker lands ${span(-diff)} before the defender.</span></div>`;
}

function describeLeg(side, dest) {
    const [x, y, p] = side.at;
    if (x === dest[0] && y === dest[1]) return `same system, ${Math.abs(p - dest[2])} slot${Math.abs(p - dest[2]) === 1 ? '' : 's'} apart`;
    return `distance ${systemDistance(x, y, dest[0], dest[1]).toFixed(2)}`;
}

function render() {
    const a = readSide('a'), b = readSide('b');
    const dest = [num('sr-d-x', -1e6, 1e6), num('sr-d-y', -1e6, 1e6), num('sr-d-p', 1, 12, 1)];
    const allied = !!$('sr-a-allied')?.checked;
    const now = {}, next = { fixedSpeedStep: num('sr-step', 0, 20, 11) / 100 };

    const aNow = flight(a, dest, allied, now), aNew = flight(a, dest, allied, next);
    const bNow = flight(b, dest, false, now), bNew = flight(b, dest, false, next);

    const change = (n, o) => {
        const d = n - o;
        if (d === 0) return '<div class="text-xs text-zinc-500">no change</div>';
        return `<div class="text-xs ${d < 0 ? 'text-emerald-400' : 'text-red-400'}">${d < 0 ? '−' : '+'}${span(d)}</div>`;
    };
    const row = (label, cls, n, o) => `<tr class="border-b border-zinc-800/50 align-top">
        <td class="py-2 pr-2 ${cls} font-semibold">${label}</td>
        <td class="py-2 px-2 text-right font-mono text-foreground">${fmt(n)}</td>
        <td class="py-2 pl-2 text-right font-mono text-foreground">${fmt(o)}${change(o, n)}</td>
    </tr>`;
    $('sr-rows').innerHTML =
        row(`A · Defender${allied ? ' <span class="text-xs font-normal text-zinc-500">(½)</span>' : ''}`, 'text-sky-400', aNow, aNew)
        + row('B · Attacker', 'text-red-400', bNow, bNew);

    $('sr-verdict').innerHTML = verdict('Now', aNow, bNow) + verdict('New', aNew, bNew);

    const mins = side => {
        const m = fixedMinimums(side.speed, next);
        return `${span(Math.floor(m.sameSystem))} / ${span(Math.floor(m.deepSpace))}`;
    };
    $('sr-meta').innerHTML = `A: E${a.energy} speed ${a.speed > 0 ? '+' : ''}${a.speed}, ${esc(describeLeg(a, dest))}. `
        + `B: E${b.energy} speed ${b.speed > 0 ? '+' : ''}${b.speed}, ${esc(describeLeg(b, dest))}.<br>`
        + `Fixed minimum (same system / other system): now 0:20:00 / 0:45:00 for everyone; new A ${mins(a)}, B ${mins(b)}.`;
}

function wirePicker({ inputId, dropId, load, match, button, onPick }) {
    const input = $(inputId), drop = $(dropId);
    if (!input || !drop) return;
    let seq = 0;
    input.addEventListener('input', async () => {
        const token = ++seq;
        const q = input.value.trim().toLowerCase();
        if (!q) { drop.classList.add('hidden'); return; }
        const list = await load();
        if (token !== seq) return;
        const hits = list.filter(item => match(item, q)).slice(0, 12);
        if (!hits.length) { drop.classList.add('hidden'); return; }
        drop.innerHTML = hits.map(button).join('');
        drop.classList.remove('hidden');
        drop.querySelectorAll('.sr-pick').forEach(btn => btn.addEventListener('mousedown', e => {
            e.preventDefault();
            onPick(btn.dataset, input);
            drop.classList.add('hidden');
            render();
        }));
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
}

const pickBtn = 'sr-pick w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800 text-left transition-colors';

function wireSystemPicker(prefix) {
    wirePicker({
        inputId: `sr-${prefix}-sys-input`, dropId: `sr-${prefix}-sys-dropdown`, load: loadSystems,
        match: (s, q) => (s.name && s.name.toLowerCase().includes(q)) || String(s.id).includes(q),
        button: s => `<button data-x="${s.x}" data-y="${s.y}" data-id="${s.id}" data-name="${esc(s.name || 'Sys')}" class="${pickBtn}">
                <span class="text-foreground font-medium truncate">${esc(s.name || 'Sys')} #${s.id}</span>
                <span class="text-zinc-500 ml-auto">${s.x}/${s.y}</span></button>`,
        onPick: (d, input) => {
            $(`sr-${prefix}-x`).value = d.x;
            $(`sr-${prefix}-y`).value = d.y;
            input.value = `${d.name} #${d.id}`;
        },
    });
}

function wirePlayerPicker(prefix) {
    wirePicker({
        inputId: `sr-${prefix}-player-input`, dropId: `sr-${prefix}-player-dropdown`, load: loadPlayers,
        match: (p, q) => p.name && p.name.toLowerCase().includes(q),
        button: p => `<button data-e="${p.energy || 0}" data-s="${p.race_speed || 0}" data-name="${esc(p.name || '')}" class="${pickBtn}">
                <span class="text-foreground font-medium truncate">${esc(p.name)}</span>
                <span class="text-zinc-500 ml-auto">E${p.energy || 0} spd${p.race_speed || 0}</span></button>`,
        onPick: (d, input) => {
            $(`sr-${prefix}-energy`).value = d.e;
            $(`sr-${prefix}-speed`).value = d.s;
            input.value = d.name;
        },
    });
}

export function initSpeedRules() {
    $('close-speed-rules-btn')?.addEventListener('click', () => {
        $('speed-rules-panel')?.classList.replace('translate-x-0', 'translate-x-full');
    });
    document.querySelectorAll('#speed-rules-panel .sr-in').forEach(el => {
        el.addEventListener('input', render);
        el.addEventListener('change', render);
    });
    for (const prefix of ['a', 'b', 'd']) {
        const clear = () => { const label = $(`sr-${prefix}-sys-input`); if (label) label.value = ''; };
        $(`sr-${prefix}-x`)?.addEventListener('input', clear);
        $(`sr-${prefix}-y`)?.addEventListener('input', clear);
    }
    wirePlayerPicker('a');
    wirePlayerPicker('b');
    wireSystemPicker('a');
    wireSystemPicker('b');
    wireSystemPicker('d');
    render();
}
