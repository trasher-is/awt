// Empire Simulator — a thin UI over public/js/utils/empire-model.js's forward simulation.
// Unlike Build Order Sim (an older, unverified standalone tool racing two build QUEUES),
// this simulates ONE empire against build TARGETS using rates cross-checked against
// docs/game-rules.md, and reports whether a timeframe is enough and where the time went.
import { esc } from '../utils/escape.js';
import '../utils/game-tables.js';
import '../utils/travel-model.js';
import '../utils/empire-model.js';

const E = globalThis.AWEmpire;
const T = globalThis.AWTables;

const $ = (id) => document.getElementById(id);

// The research plan is the one input that is inherently an ORDERED list, so it is kept as
// module state (rendered as removable rows) rather than read fresh from the DOM like every
// other field.
let sciencePlan = [
    { field: 'social', level: 10 },
    { field: 'energy', level: 40 },
];

function renderSciencePlan() {
    const box = $('es-science-plan');
    if (!box) return;
    if (!sciencePlan.length) {
        box.innerHTML = '<div class="text-[11px] text-zinc-500">No steps — all science output is wasted unless an overflow field is set below.</div>';
        return;
    }
    box.innerHTML = sciencePlan.map((step, i) => `
        <div class="flex items-center gap-2 bg-zinc-950 border border-border rounded px-2 py-1">
            <span class="text-[10px] text-zinc-500 font-mono w-4">${i + 1}.</span>
            <span class="text-xs font-mono text-foreground flex-1">${esc(step.field)} &rarr; ${step.level}</span>
            <button data-es-remove-step="${i}" class="text-zinc-400 hover:text-red-400"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
}

function readRace() {
    return {
        growth: Number($('es-race-growth').value) || 0,
        science: Number($('es-race-science').value) || 0,
        culture: Number($('es-race-culture').value) || 0,
        production: Number($('es-race-production').value) || 0,
        speed: Number($('es-race-speed').value) || 0,
        attack: Number($('es-race-attack').value) || 0,
        defence: Number($('es-race-defence').value) || 0,
        startupLab: $('es-race-startuplab').checked,
        trader: $('es-race-trader').checked,
    };
}

function updateRaceSum() {
    const r = readRace();
    const sum = r.growth + r.science + r.culture + r.production + r.speed + r.attack + r.defence
        + (r.startupLab ? 1 : 0) + (r.trader ? 6 : 0);
    const el = $('es-race-sum');
    if (!el) return;
    el.textContent = `sum ${sum}`;
    el.classList.toggle('text-red-400', sum !== 0);
    el.classList.toggle('text-foreground', sum === 0);
}

function readTargets() {
    return {
        HF: Number($('es-target-HF').value) || 0,
        RF: Number($('es-target-RF').value) || 0,
        GC: Number($('es-target-GC').value) || 0,
        RL: Number($('es-target-RL').value) || 0,
        SB: Number($('es-target-SB').value) || 0,
    };
}

function updateTargetCost() {
    const targets = readTargets();
    const cost = E.targetCostPP(targets, 1);
    const el = $('es-target-cost');
    if (el) el.textContent = `${Math.round(cost.perPlanet).toLocaleString()} PP/planet`;
}

function buildConfig() {
    const buildOrder = ($('es-build-order').value || '').split(',').map(s => s.trim()).filter(Boolean);
    const artifact = ($('es-artifact').value || '').trim();
    return {
        days: Math.max(1, Number($('es-days').value) || 60),
        race: readRace(),
        targets: readTargets(),
        buildMode: $('es-build-mode').value,
        buildOrder: buildOrder.length ? buildOrder : E.DEFAULTS.buildOrder.slice(),
        sciencePlan: sciencePlan.slice(),
        scienceOverflow: $('es-science-overflow').value || null,
        colonyShips: Math.max(1, Number($('es-colony-ships').value) || 1),
        colonyFirst: $('es-colony-first').checked,
        maxPlanets: Number($('es-max-planets').value) || 0,
        colonyRoute: {
            systemDistance: Number($('es-colony-distance').value) || 0,
            planetDelta: Number($('es-colony-planet-delta').value) || 0,
        },
        tradeRate: Math.max(0, Math.min(100, Number($('es-trade-rate').value) || 0)) / 100,
        economyBonus: $('es-economy-bonus').checked,
        artifact: artifact || null,
        artifactFromDay: Number($('es-artifact-from-day').value) || 0,
        cultureFormula: $('es-culture-formula').value,
        startingPP: Number($('es-starting-pp').value) || 0,
    };
}

function renderWarnings(warnings) {
    const box = $('es-warnings');
    if (!box) return;
    if (!warnings.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = warnings.map(w => `<div><i class="fa-solid fa-triangle-exclamation mr-1.5"></i>${esc(w)}</div>`).join('');
}

function n(x) { return Math.round(x).toLocaleString(); }

function renderKpis(res) {
    const f = res.final, c = res.config;
    $('es-kpi-day').textContent = c.days;
    $('es-kpi-planets').textContent = `${f.planets} (culture ${f.cultureLevel})`;
    $('es-kpi-pop').textContent = `${f.totalPop} / ${f.popCap}·planet`;
    $('es-kpi-pp').textContent = n(f.ppRate);
    $('es-kpi-sci').textContent = n(f.sciRate);
    $('es-kpi-caughtup').textContent = res.firstCaughtUpDay
        ? `day ${res.firstCaughtUpDay}${res.caughtUpAtEnd ? '' : ' (fell behind again since)'}`
        : `never — ${n(f.remainingBuildPP)} PP still needed`;
    $('es-kpi-fleet').textContent =
        `${n(f.fleetIfSpent.battleships)} BS / ${n(f.fleetIfSpent.cruisers)} CR / ${n(f.fleetIfSpent.destroyers)} DS at economy ${f.fleetIfSpent.economy}`;
}

function renderDayTable(res) {
    const body = $('es-daytable');
    if (!body) return;
    const rows = res.history.filter(h => h.day % 5 === 0 || h.day === res.config.days);
    body.innerHTML = rows.map(h => `
        <tr class="border-t border-border/60">
            <td class="px-3 py-1.5">${h.day}</td>
            <td class="px-3 py-1.5 text-right font-mono">${h.planets}</td>
            <td class="px-3 py-1.5 text-right font-mono">${h.pop}</td>
            <td class="px-3 py-1.5 text-right font-mono text-amber-400">${n(h.ppRate)}</td>
            <td class="px-3 py-1.5 text-right font-mono text-sky-400">${n(h.sciRate)}</td>
            <td class="px-3 py-1.5 text-right font-mono">${h.cultureLevel}</td>
            <td class="px-3 py-1.5 text-right font-mono">${n(h.pp)}</td>
            <td class="px-3 py-1.5 text-right font-mono text-zinc-400">${n(h.remainingBuildPP)}</td>
        </tr>`).join('');
}

function renderBuildingsReached(res) {
    const box = $('es-buildings-reached');
    if (!box) return;
    const targets = res.config.targets;
    const byBuilding = {};
    for (const p of res.final.buildings) {
        for (const [b, lvl] of Object.entries(p.buildings)) {
            if (!targets[b]) continue;
            (byBuilding[b] = byBuilding[b] || []).push(lvl);
        }
    }
    const rows = Object.entries(byBuilding).map(([b, levels]) => {
        const min = Math.min(...levels), max = Math.max(...levels);
        const done = levels.filter(l => l >= targets[b]).length;
        return `<div class="flex justify-between"><span>${esc(b)} target ${targets[b]}</span><span class="text-zinc-400">reached ${min}-${max} &middot; ${done}/${levels.length} planets done</span></div>`;
    });
    box.innerHTML = rows.join('') || '<div class="text-zinc-500">No building targets set.</div>';
}

function renderMilestones(res) {
    const box = $('es-milestones');
    const count = $('es-milestone-count');
    if (!box) return;
    if (count) count.textContent = `${res.milestones.length} events`;
    const kindColor = { colony: 'text-emerald-400', culture: 'text-purple-400', science: 'text-sky-400', done: 'text-amber-400' };
    box.innerHTML = res.milestones.map(m =>
        `<div><span class="text-zinc-500">day ${m.day} ${String(m.hour).padStart(2, '0')}:00</span> <span class="${kindColor[m.kind] || 'text-foreground'}">${esc(m.text)}</span></div>`
    ).join('') || '<div class="text-zinc-500">No milestones reached in this window.</div>';
}

export function runSimulation() {
    if (!E) return;
    updateRaceSum();
    updateTargetCost();
    const cfg = buildConfig();
    const res = E.simulate(cfg);
    renderWarnings(res.warnings);
    renderKpis(res);
    renderDayTable(res);
    renderBuildingsReached(res);
    renderMilestones(res);
}

export function initEmpireSim() {
    const panel = $('empire-sim-panel');
    if (!panel) return;

    if (T && T.ARTIFACTS) {
        const list = $('es-artifact-list');
        if (list) list.innerHTML = T.ARTIFACTS.map(a => `<option value="${esc(a.name)}"></option>`).join('');
    }

    $('close-empire-sim-btn')?.addEventListener('click', () => {
        panel.classList.replace('translate-x-0', 'translate-x-full');
    });
    $('es-run')?.addEventListener('click', runSimulation);

    $('es-science-add')?.addEventListener('click', () => {
        const field = $('es-science-add-field').value;
        const level = Number($('es-science-add-level').value) || 1;
        sciencePlan.push({ field, level });
        renderSciencePlan();
        runSimulation();
    });

    panel.addEventListener('click', (e) => {
        const remove = e.target.closest('[data-es-remove-step]');
        if (remove) {
            sciencePlan.splice(parseInt(remove.getAttribute('data-es-remove-step'), 10), 1);
            renderSciencePlan();
            runSimulation();
        }
    });

    // Re-run on any input change rather than binding one listener per field — the model is
    // cheap (≤1440 ticks at the default 60-day/60-minute-tick setting).
    panel.addEventListener('change', (e) => {
        if (e.target.matches('input, select')) runSimulation();
    });

    renderSciencePlan();
    runSimulation();
}
