// Build Order Sim — races two opening build orders against each other hour by hour.
//
// Ported from a standalone HTML tool the author kept outside the repo. The simulation
// mechanics are unchanged; what changed is the styling (hub design tokens), inline
// onclick handlers became delegated listeners, and the per-empire log colour, which used
// Tailwind classes (`text-playerA-400`) that only existed in that file's own Tailwind
// config — inside the hub those resolve to nothing and every log line rendered colourless.
//
// HEALTH WARNING: every cost table and modifier rate below is transcribed from that tool
// and has NOT been verified against the game. The panel says so on screen. The one number
// already cross-checked is the science trait: 8% per point, which is what caught the War
// Room's ~Sci/h column using production's 4% instead (fixed in archives.js 2026-08-07).
// Anything confirmed from here belongs in a fixture + docs/, per AGENTS.md.

// Cumulative cost to reach level N (index = level).
const BLDG_COST = [0, 5, 8, 11, 17, 25, 38, 57, 85];                          // building, max lvl 8
const POP_COST  = [0, 0, 21, 57, 111, 183, 273, 381];                          // pop level, max 7
const CULT_COST = [0, 0, 318, 765, 1315, 2084, 2985, 4059, 5320, 6785];        // culture, max 9
const SCI_COST  = [0, 29, 74, 138, 221, 325, 451, 603, 780];                   // science, max 8

// Per-point race trait multipliers. Growth and science are both 8%; production and
// culture are 4% — do not "tidy" these into one constant, they are deliberately not equal.
const GROWTH_PER_PT = 0.08;
const SCI_PER_PT    = 0.08;
const PROD_PER_PT   = 0.04;
const CULT_PER_PT   = 0.04;

const MAX_BLDG_LVL = 8;
const MAX_POP_LVL = 7;
const MAX_CULT_LVL = 9;

// Colonisation: a second planet is cheaper than every one after it, and part of the
// outlay comes straight back.
const COLONY_P2 = { cost: 180, rebate: 30 };
const COLONY_PN = { cost: 300, rebate: 60 };

const BLDG_TYPES = ['HF', 'RF', 'GC', 'RL', 'SB'];
const BLDG_COLOR = { HF: 'text-emerald-400', RF: 'text-amber-400', GC: 'text-purple-400', RL: 'text-sky-400', SB: 'text-red-400' };

const $ = (id) => document.getElementById(id);
const numOf = (id, fallback = 0) => {
    const v = parseInt($(id)?.value, 10);
    return Number.isFinite(v) ? v : fallback;
};

let queues = { A: ['HF', 'HF', 'RF', 'GC', 'SB'], B: ['HF', 'HF', 'RF', 'GC', 'SB'] };
let charts = {};

class Planet {
    constructor(id) {
        this.id = id;
        this.popLvl = 1;
        this.popPoints = 0;
        this.buildings = { HF: 0, RF: 0, GC: 0, RL: 0, SB: 0 };
        this.queueIndex = 0;   // how far this planet has got through the shared queue
    }
}

class Empire {
    constructor(name, logColor, mods) {
        this.name = name;
        this.logColor = logColor;   // a real Tailwind class, e.g. 'text-sky-400'
        this.gMod = mods.g;
        this.pMod = mods.p;
        this.cMod = mods.c;
        this.sMod = mods.s;
        this.targetSocial = mods.tSoc;

        this.pp = 0;
        this.planets = [new Planet(1)];

        this.cultPoints = 0;
        this.cultLvl = 1;

        this.sciSocialPts = 0;
        this.sciBioPts = 0;
        this.socialLvl = 0;
        this.bioLvl = 0;

        this.logs = [];
        this.history = { hours: [], ppRate: [], totalPop: [] };
    }

    log(hour, msg, type = 'info') {
        const day = Math.floor(hour / 24) + 1;
        const h = hour % 24;
        const stamp = `[D${String(day).padStart(2, '0')} H${String(h).padStart(2, '0')}]`;

        const colors = {
            build: this.logColor,
            colony: 'text-purple-300 font-bold',
            sci: 'text-blue-400',
            cult: 'text-purple-400',
            pop: 'text-emerald-400',
            info: 'text-muted-foreground'
        };
        // msg is built entirely from internal numbers and fixed strings — no user input.
        this.logs.push(`<div class="${colors[type] || colors.info}"><span class="text-zinc-600 mr-2">${stamp}</span>${msg}</div>`);
    }

    ppRate() {
        return this.planets.reduce((sum, p) => sum + (p.buildings.RF + p.popLvl) * (1 + this.pMod * PROD_PER_PT), 0);
    }

    totalPop() {
        return this.planets.reduce((sum, p) => sum + p.popLvl, 0);
    }

    tick(hour, queue) {
        let sciBase = 0, cultRate = 0, ppRate = 0;

        // 1. Income and population growth, per planet.
        for (const p of this.planets) {
            sciBase += p.buildings.RL + p.popLvl;
            cultRate += p.buildings.GC * (1 + this.cMod * CULT_PER_PT);
            ppRate += (p.buildings.RF + p.popLvl) * (1 + this.pMod * PROD_PER_PT);

            if (p.popLvl < MAX_POP_LVL) {
                p.popPoints += (p.buildings.HF + 1) * (1 + this.gMod * GROWTH_PER_PT);
                while (p.popLvl < MAX_POP_LVL && p.popPoints >= POP_COST[p.popLvl + 1]) {
                    p.popPoints -= POP_COST[p.popLvl + 1];
                    p.popLvl++;
                    this.log(hour, `Planet ${p.id} reached pop ${p.popLvl}`, 'pop');
                }
            }
        }

        this.pp += ppRate;

        // 2. Science: fill Social up to the target, then everything spills into Biology.
        const sciRate = sciBase * (1 + this.sMod * SCI_PER_PT);
        if (this.socialLvl < this.targetSocial) {
            this.sciSocialPts += sciRate;
            while (this.socialLvl < this.targetSocial) {
                const cost = this.socialLvl < 8 ? SCI_COST[this.socialLvl + 1] : SCI_COST[8];
                if (this.sciSocialPts < cost) break;
                this.sciSocialPts -= cost;
                this.socialLvl++;
                this.log(hour, `Social science reached lvl ${this.socialLvl}`, 'sci');
            }
            // Target met mid-tick: carry the leftover across rather than losing it.
            if (this.socialLvl >= this.targetSocial && this.sciSocialPts > 0) {
                this.sciBioPts += this.sciSocialPts;
                this.sciSocialPts = 0;
            }
        } else {
            this.sciBioPts += sciRate;
        }

        for (;;) {
            const cost = this.bioLvl < 8 ? SCI_COST[this.bioLvl + 1] : SCI_COST[8];
            if (this.sciBioPts < cost) break;
            this.sciBioPts -= cost;
            this.bioLvl++;
            this.log(hour, `Biology science reached lvl ${this.bioLvl}`, 'sci');
        }

        // 3. Culture — its level is the number of planet slots available.
        this.cultPoints += cultRate;
        while (this.cultLvl < MAX_CULT_LVL && this.cultPoints >= CULT_COST[this.cultLvl + 1]) {
            this.cultPoints -= CULT_COST[this.cultLvl + 1];
            this.cultLvl++;
            this.log(hour, `Culture reached lvl ${this.cultLvl} (slot unlocked)`, 'cult');
        }

        // 4. Colonise into any free slot we can afford.
        if (this.planets.length < this.cultLvl) {
            const { cost, rebate } = this.planets.length === 1 ? COLONY_P2 : COLONY_PN;
            if (this.pp >= cost) {
                this.pp -= cost - rebate;
                const id = this.planets.length + 1;
                this.planets.push(new Planet(id));
                this.log(hour, `Colonised planet ${id}`, 'colony');
            }
        }

        // 5. Work the build queue. Every planet walks the same queue independently.
        for (const p of this.planets) {
            if (p.queueIndex >= queue.length) continue;
            const type = queue[p.queueIndex];
            const current = p.buildings[type];
            const target = current + 1;

            if (target > MAX_BLDG_LVL) { p.queueIndex++; continue; }   // already maxed, skip the entry

            const cost = BLDG_COST[target] - BLDG_COST[current];
            if (this.pp >= cost) {
                this.pp -= cost;
                p.buildings[type] = target;
                p.queueIndex++;
                this.log(hour, `Planet ${p.id} built ${type} ${target}`, 'build');
            }
        }

        // 6. Sample the curves every 6h — enough shape without 336 points per chart.
        if (hour % 6 === 0) {
            this.history.hours.push(hour);
            this.history.ppRate.push(ppRate);
            this.history.totalPop.push(this.totalPop());
        }
    }
}

function renderQueue(player) {
    const host = $(`bo-queue-${player}`);
    if (!host) return;
    const counts = {};
    host.innerHTML = queues[player].map((type, index) => {
        counts[type] = (counts[type] || 0) + 1;
        return `<div class="bg-secondary border border-border px-2 py-1 rounded text-xs flex items-center gap-2 ${BLDG_COLOR[type] || ''}">
            <span class="font-bold">${type} ${counts[type]}</span>
            <i class="fa-solid fa-xmark cursor-pointer text-zinc-500 hover:text-red-400" data-bo-remove="${player}" data-index="${index}"></i>
        </div>`;
    }).join('');
}

function readMods(player) {
    return {
        g: numOf(`bo-${player}-growth`),
        p: numOf(`bo-${player}-prod`),
        c: numOf(`bo-${player}-cult`),
        s: numOf(`bo-${player}-sci`),
        tSoc: numOf(`bo-${player}-target-social`)
    };
}

export function runSimulation() {
    const days = Math.min(60, Math.max(1, numOf('bo-days', 14)));
    const maxHours = days * 24;
    if ($('bo-kpi-day')) $('bo-kpi-day').innerText = days;

    const empires = {
        A: new Empire('A', 'text-sky-400', readMods('A')),
        B: new Empire('B', 'text-rose-400', readMods('B'))
    };

    for (let h = 1; h <= maxHours; h++) {
        empires.A.tick(h, queues.A);
        empires.B.tick(h, queues.B);
    }

    for (const key of ['A', 'B']) {
        const emp = empires[key];
        const set = (id, text) => { const el = $(id); if (el) el.innerText = text; };
        set(`bo-kpi-planets-${key}`, emp.planets.length);
        set(`bo-kpi-pop-${key}`, emp.totalPop());
        set(`bo-kpi-pp-${key}`, Math.round(emp.ppRate()));
        const sciEl = $(`bo-kpi-sci-${key}`);
        if (sciEl) sciEl.innerHTML = `S:${emp.socialLvl} B:${emp.bioLvl}<br>C:${emp.cultLvl}`;

        const logEl = $(`bo-log-${key}`);
        if (logEl) {
            logEl.innerHTML = emp.logs.join('');
            logEl.scrollTop = logEl.scrollHeight;
        }
        set(`bo-log-count-${key}`, `${emp.logs.length} events`);
    }

    drawChart('pop', 'bo-pop-chart', 'Population', empires.A.history.hours,
        empires.A.history.totalPop, empires.B.history.totalPop, true);
    drawChart('income', 'bo-income-chart', 'PP/h', empires.A.history.hours,
        empires.A.history.ppRate, empires.B.history.ppRate, false);
}

function drawChart(key, canvasId, label, hours, seriesA, seriesB, integerTicks) {
    const canvas = $(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (charts[key]) charts[key].destroy();

    charts[key] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: hours,
            datasets: [
                { label: `A ${label}`, data: seriesA, borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.10)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2 },
                { label: `B ${label}`, data: seriesB, borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.10)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#a1a1aa', boxWidth: 12, font: { size: 11, family: 'monospace' } } },
                tooltip: {
                    backgroundColor: 'rgba(9,9,11,0.95)',
                    titleColor: '#fafafa',
                    bodyColor: '#d4d4d8',
                    callbacks: { title: (ctx) => `Hour ${hours[ctx[0].dataIndex]}` }
                }
            },
            scales: {
                x: {
                    grid: { color: '#27272a' },
                    ticks: { color: '#71717a', maxTicksLimit: 12, font: { size: 10, family: 'monospace' }, callback: (v) => `H${hours[v]}` }
                },
                y: {
                    grid: { color: '#27272a' },
                    ticks: { color: '#a1a1aa', font: { size: 10, family: 'monospace' }, ...(integerTicks ? { stepSize: 1 } : {}) }
                }
            }
        }
    });
}

export function initBuildOrder() {
    const panel = $('build-order-panel');
    if (!panel) return;

    $('close-build-order-btn')?.addEventListener('click', () => {
        panel.classList.replace('translate-x-0', 'translate-x-full');
    });
    $('bo-run')?.addEventListener('click', runSimulation);

    // Delegated: the queue chips are re-rendered constantly, so binding per chip would
    // leak listeners and break after every render.
    panel.addEventListener('click', (e) => {
        const add = e.target.closest('[data-bo-add]');
        if (add) {
            const player = add.getAttribute('data-bo-add');
            const type = add.getAttribute('data-bldg');
            if (!BLDG_TYPES.includes(type)) return;
            // A building cannot go past level 8, so more than 8 of a type is dead weight.
            if (queues[player].filter(t => t === type).length >= MAX_BLDG_LVL) return;
            queues[player].push(type);
            renderQueue(player);
            runSimulation();
            return;
        }

        const remove = e.target.closest('[data-bo-remove]');
        if (remove) {
            const player = remove.getAttribute('data-bo-remove');
            queues[player].splice(parseInt(remove.getAttribute('data-index'), 10), 1);
            renderQueue(player);
            runSimulation();
            return;
        }

        const clear = e.target.closest('[data-bo-clear]');
        if (clear) {
            queues[clear.getAttribute('data-bo-clear')] = [];
            renderQueue(clear.getAttribute('data-bo-clear'));
            runSimulation();
            return;
        }

        if (e.target.closest('#bo-copy-a-to-b')) {
            queues.B = [...queues.A];
            renderQueue('B');
            runSimulation();
        }
    });

    panel.addEventListener('change', (e) => {
        if (e.target.matches('input[type="number"]')) runSimulation();
    });

    renderQueue('A');
    renderQueue('B');
    runSimulation();
}
