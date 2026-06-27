// Battle calculator logic — called from archives.js after panel HTML is injected.
//
// Model (validated against the in-game calculator):
//   Each ship has an ATTACK stat and a DEFENSE stat. CV = att + def.
//     D: att 2, def 1  (cv 3)   |  C: att 8, def 16 (cv 24)  |  B: att 36, def 24 (cv 60)
//   Starbase level n: cv = round(4·1.5^n) − 4, and att = def = floor(cv/2).
//
//   Effective attack = (Σ att·n + SBatt) × (1 + 0.07·raceAttack)
//   Effective HP     = (Σ def·n + SBdef) × (1 + 0.11·raceDefense) × (1 + 0.153·mathematics)
//   Fraction killed (simultaneous fire) = min(1, enemyAttack / ownHP)
//   Losses are applied proportionally to ship counts (and CV).
//
//   Race attack: +7% attack per level (so +4 = +28%, −4 = −28%).
//   Race defense: +11% HP per level.
//   Mathematics: scales HP (survivors). Physics & player level: win probability only.

const SHIPS = [
    { name: 'Destroyer',  att: 2,  def: 1,  cv: 3  },
    { name: 'Cruiser',    att: 8,  def: 16, cv: 24 },
    { name: 'Battleship', att: 36, def: 24, cv: 60 },
];
// SB: cv = round(4·1.5^n)−4; att = def = floor(cv/2)  (confirmed: SB10 cv = 227)
function sbCV(n)  { return n > 0 ? Math.round(4 * Math.pow(1.5, n)) - 4 : 0; }
function sbHalf(n){ return Math.floor(sbCV(n) / 2); }

// Combat model reverse-engineered from the in-game Battle Calculator:
//   lossFraction_own = ΣenemyCV / Σ(att + 2·def)_own   (uniform across ship types)
//   Race defense divides your losses by (1 + 0.11·RD); it does NOT affect the enemy.
//   Race attack, physics, player level do NOT change survivors — only win %.
// Win % is a separate logistic on stat differences (see calcWin).
const RACE_DEF  = 0.11;     // race-defense: your losses ÷ (1 + 0.11·RD)
const MATH_TOUGH = 0.0015;  // small symmetric toughness gain per math level
const TOUGH = i => SHIPS[i].att + 2 * SHIPS[i].def;   // per-ship "toughness"

// Win-% logistic coefficients (fit to in-game samples). Win % depends on FORCE RATIO
// (initial CV) plus race-attack, physics and player level — NOT on race-defense or
// mathematics (those change survivors only). A 1.5× CV lead is a guaranteed win.
const WIN_FORCE = 15.25;   // logit weight on relative CV difference
const WIN_SB_FACTOR = 0.94; // starbase counts ~0.94× its CV toward the win ratio
const WIN_RA    = 0.50;    // per race-attack level diff
const WIN_LVL   = 0.069;   // per player-level diff (only if a full D/C/B fleet)
const WIN_PHYS_A = 0.0792; // physics: S = A·(e^(K·|Δ|) − 1), signed
const WIN_PHYS_K = 0.404;

let playerCache = null;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v | 0)); }
function fmt(n) {
    if (n === 0) return '0';
    const r = Math.round(n * 100) / 100;
    return r % 1 === 0 ? String(r) : r.toFixed(2);
}

// Separate logistic win probability for the defender, driven by the initial CV ratio
// plus stat differences. cvD / cvA are total combat values (defender incl. starbase).
function calcWin(d, a, cvD, cvA) {
    // A 1.5× combat-value lead is a guaranteed win.
    if (cvA >= 1.5 * cvD && cvD >= 0) return { winD: 0, winA: 1 };
    if (cvD >= 1.5 * cvA && cvA >= 0) return { winD: 1, winA: 0 };

    const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const dphys = d.phys - a.phys;
    const denom = cvD + cvA;
    let S = denom > 0 ? WIN_FORCE * ((cvD - cvA) / denom) : 0;
    S += WIN_RA * (d.ra - a.ra);
    S += sgn(dphys) * WIN_PHYS_A * (Math.exp(WIN_PHYS_K * Math.abs(dphys)) - 1);
    // Player level only counts when the fleet fields all three ship types.
    const dFull = d.fleet.every(n => n > 0), aFull = a.fleet.every(n => n > 0);
    if (dFull && aFull) S += WIN_LVL * (d.lvl - a.lvl);
    const winD = 1 / (1 + Math.exp(-S));
    return { winD, winA: 1 - winD };
}

function calc() {
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;

    const defFleet = [g('bc-def-d'), g('bc-def-c'), g('bc-def-b')];
    const atkFleet = [g('bc-atk-d'), g('bc-atk-c'), g('bc-atk-b')];
    const sbLvl    = clamp(g('bc-def-sb'), 0, 50);

    const def = { phys: clamp(g('bc-def-phys'),0,30), math: clamp(g('bc-def-math'),0,30),
                  ra: clamp(g('bc-def-ra'),-4,4), rd: clamp(g('bc-def-rd'),-4,4),
                  lvl: Math.max(0, g('bc-def-lvl')|0), fleet: defFleet };
    const atk = { phys: clamp(g('bc-atk-phys'),0,30), math: clamp(g('bc-atk-math'),0,30),
                  ra: clamp(g('bc-atk-ra'),-4,4), rd: clamp(g('bc-atk-rd'),-4,4),
                  lvl: Math.max(0, g('bc-atk-lvl')|0), fleet: atkFleet };

    // Enemy CV (offense) and own toughness Σ(att+2def), incl. starbase for the defender.
    const cvOf  = f => f.reduce((s, n, i) => s + n * SHIPS[i].cv, 0);
    const toughOf = f => f.reduce((s, n, i) => s + n * TOUGH(i), 0);

    const sbCv    = sbCV(sbLvl);
    const sbTough = sbLvl > 0 ? sbHalf(sbLvl) * 3 : 0; // att + 2·def with att=def=floor(cv/2)

    // Math threshold: a mathematics advantage of 6+ over the enemy grants +25% combat
    // (both offense and toughness) to that side — the in-game "+6 → +25%" rule, which is
    // why 20-vs-25 and 20-vs-26 differ so sharply.
    const cmDef = 1 + 0.25 * ((def.math - atk.math) >= 6 ? 1 : 0);
    const cmAtk = 1 + 0.25 * ((atk.math - def.math) >= 6 ? 1 : 0);

    const enemyCVtoDef = cvOf(atkFleet) * cmAtk;
    const enemyCVtoAtk = (cvOf(defFleet) + sbCv) * cmDef;

    const defTough = (toughOf(defFleet) + sbTough) * (1 + RACE_DEF * def.rd) * (1 + MATH_TOUGH * def.math) * cmDef;
    const atkTough = toughOf(atkFleet) * (1 + RACE_DEF * atk.rd) * (1 + MATH_TOUGH * atk.math) * cmAtk;

    if (defTough === 0 && atkTough === 0) return null;

    const fracDefKilled = defTough > 0 ? Math.min(1, enemyCVtoDef / defTough) : 1;
    const fracAtkKilled = atkTough > 0 ? Math.min(1, enemyCVtoAtk / atkTough) : 1;

    const survDef = defFleet.map(n => n * (1 - fracDefKilled));
    const survAtk = atkFleet.map(n => n * (1 - fracAtkKilled));
    const survSB  = sbLvl > 0 ? (1 - fracDefKilled) : 0;

    const initCVD = cvOf(defFleet) + sbCv;
    const initCVA = cvOf(atkFleet);
    const cvDefRemain = survDef.reduce((s, n, i) => s + n * SHIPS[i].cv, 0) + survSB * sbCv;
    const cvAtkRemain = survAtk.reduce((s, n, i) => s + n * SHIPS[i].cv, 0);

    // Win % weights the starbase slightly below its raw CV.
    const winCVD = cvOf(defFleet) + WIN_SB_FACTOR * sbCv;
    const { winD, winA } = calcWin(def, atk, winCVD, initCVA);

    return { defFleet, atkFleet, sbLvl, survDef, survAtk, survSB,
             initCVD, initCVA, cvDefRemain, cvAtkRemain, winD, winA };
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

    const sbRow = r.sbLvl > 0 ? `<div class="flex items-center gap-2 text-xs font-mono">
        <span class="w-20 text-muted-foreground">SB lvl ${r.sbLvl}</span>
        <span class="text-emerald-300 font-semibold">${fmt(r.survSB)}</span>
        <span class="text-zinc-600">/ 1</span>
        <span class="text-zinc-500 ml-auto">(${(r.survSB * 100).toFixed(1)}% survive)</span>
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
                <span class="text-foreground font-medium truncate">${p.name}</span>
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
