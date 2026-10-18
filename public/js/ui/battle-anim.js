// Fight simulation window for the battle calculator: a dice roll, then the two fleets
// fighting it out on a canvas. Loaded on demand when a member taps "Fight" — never
// opened by itself.
//
// Presentation only. The outcome comes from the shared model (battle-model.js) and the
// roll/wipe/icon rules from fight-plan.js; this file just stages them so the fight ends
// on exactly those numbers.

import { esc } from '../utils/escape.js';
import '../utils/battle-model.js';
import '../utils/fight-plan.js';

const M = globalThis.AWBattleModel;
const P = globalThis.AWFightPlan;

// Same green/red as the calculator's defender/attacker columns.
const COL = { def: '#34d399', atk: '#f87171', hot: '#fcd34d', dim: '#71717a' };
const TYPES = [
    { name: 'Destroyer',  short: 'DS', size: 5.5, gap: 11 },
    { name: 'Cruiser',    short: 'CR', size: 9,   gap: 18 },
    { name: 'Battleship', short: 'BS', size: 13,  gap: 28 },
];
const VOLLEYS = 6, VOLLEY_MS = 1000, LEAD_MS = 500, DICE_TUMBLE = 1700, DICE_MS = 2900;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// Ship silhouettes, nose pointing +x, unit = size.
const SHAPES = [
    [[1, 0], [-1, -.75], [-.45, 0], [-1, .75]],                                                         // DS: dart
    [[1, 0], [.35, -.42], [-1, -.42], [-1, .42], [.35, .42]],                                           // CR: long hull
    [[1, 0], [.45, -.32], [-.15, -.32], [-.45, -.62], [-1, -.62], [-1, .62], [-.45, .62], [-.15, .32], [.45, .32]], // BS
];

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmt = n => String(Math.round(n * 10) / 10);

let open = null; // the one window that can be open

export function openFightSimulation(result) {
    if (!result) return;
    open?.close();

    const root = document.createElement('div');
    root.id = 'bc-fight-window';
    root.className = 'fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-2 md:p-6';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Fight simulation');
    root.innerHTML = `
        <div class="w-full max-w-3xl max-h-full overflow-auto bg-zinc-950 border border-border rounded-lg flex flex-col shadow-2xl">
            <div class="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 bg-zinc-900">
                <div class="font-bold tracking-wide text-foreground"><i class="fa-solid fa-explosion text-orange-400 mr-2"></i>Fight simulation</div>
                <button type="button" data-fight-close aria-label="Close" class="w-8 h-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="grid grid-cols-[1fr_auto_1fr] gap-2 items-center px-3 py-2 border-b border-border bg-zinc-900/60 text-xs font-mono tabular-nums">
                <div data-hud="def" style="color:${COL.def}"></div>
                <div data-hud="mid" class="text-center font-semibold whitespace-nowrap" style="color:${COL.hot}"></div>
                <div data-hud="atk" class="text-right" style="color:${COL.atk}"></div>
            </div>
            <canvas class="block w-full bg-black" style="height:clamp(280px,50vh,460px)" aria-label="Defender fleet on the left fighting the attacker fleet on the right"></canvas>
            <div class="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-xs text-muted-foreground border-t border-border" data-key></div>
            <div class="px-4 pb-3" data-ledger></div>
            <div class="px-4 pb-4 flex flex-wrap items-center gap-3">
                <button type="button" data-fight-again class="h-9 px-6 rounded bg-orange-500 hover:bg-orange-400 text-black font-bold uppercase tracking-wider text-sm">Fight again</button>
                <span class="text-xs text-zinc-500">The dice decides the winner by the win chance; the loser is wiped, like a real battle.</span>
            </div>
        </div>`;
    document.body.appendChild(root);

    const cv = root.querySelector('canvas'), ctx = cv.getContext('2d');
    const hud = k => root.querySelector(`[data-hud="${k}"]`);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, g = 1, B = null, raf = 0;
    const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() < .1 ? 2 : 1, a: .2 + Math.random() * .6, p: Math.random() * 6 }));

    // ── setup ──
    function build() {
        const r = result;
        const out = P.rollOutcome(r, Math.random());
        const ships = [], sides = {};
        for (const side of ['def', 'atk']) {
            const fleet = side === 'def' ? r.defFleet : r.atkFleet, surv = side === 'def' ? out.survDef : out.survAtk;
            const plan = P.iconPlan(fleet, surv);
            sides[side] = { fleet, surv, plan };
            plan.forEach(({ icons, keep }, t) => {
                const list = [];
                for (let i = 0; i < icons; i++) list.push({ side, type: t, alive: true, flash: 0, fade: 1, die: false, phase: Math.random() * 6.28 });
                shuffle(list).slice(0, icons - keep).forEach(s => (s.die = true));
                ships.push(...list);
            });
        }
        const sb = r.sbLvl > 0 ? { level: r.sbLvl, cv0: M.sbCV(r.sbLvl), hp: 1, hpEnd: out.survSB, levelNow: r.sbLvl, flash: 0, x: 0, y: 0 } : null;
        if (sb) sb.levelEnd = P.sbLevelLeft(M.sbCV, r.sbLvl, out.survSB);
        const dice = reduce ? null : { u: out.u, shown: Math.random(), flipAt: 0 };
        return { r, out, winner: out.winner, ships, sides, sb, dice, bolts: [], parts: [], events: [], clock: 0, last: 0, done: false };
    }

    function layout(b) {
        const usableH = H - 54 * g, mid = W / 2;
        for (const side of ['def', 'atk']) {
            const dir = side === 'def' ? 1 : -1;
            const list = t => b.ships.filter(s => s.side === side && s.type === t);
            const blocks = [0, 1, 2].map(t => {
                const n = list(t).length, gap = TYPES[t].gap * g, rows = Math.max(1, Math.min(n, Math.floor(usableH / gap)));
                return { t, n, gap, rows, cols: n ? Math.ceil(n / rows) : 0 };
            });
            const sbW = side === 'def' && b.sb ? 76 * g : 0;
            const need = blocks.reduce((s, k) => s + k.cols * k.gap * .95 + (k.n ? 10 * g : 0), 0);
            const f = Math.min(1, (mid - W * .07 - 12 - sbW) / Math.max(1, need));
            let cursor = mid - dir * W * .07;
            for (const k of blocks) {
                if (!k.n) continue;
                const gx = k.gap * .95 * f, items = list(k.t);
                const y0 = H / 2 - (Math.min(k.rows, items.length) - 1) * k.gap / 2;
                items.forEach((s, i) => {
                    const c = Math.floor(i / k.rows), rr = i % k.rows;
                    s.x = cursor - dir * (c * gx + gx / 2) + (Math.random() - .5) * 2 * g;
                    s.y = y0 + rr * k.gap + (c % 2 ? k.gap * .3 : 0);
                });
                cursor -= dir * (k.cols * gx + 10 * g * f);
            }
            if (side === 'def' && b.sb) { b.sb.x = Math.max(36 * g, cursor - 40 * g); b.sb.y = H / 2; }
        }
    }

    // Every dying icon gets a volley, front-loaded so the clash peaks early; misses keep
    // both lines firing; the starbase takes hits each volley.
    function schedule(b) {
        const weights = [.12, .22, .22, .18, .14, .12];
        const volleyOf = x => { let acc = 0; for (let v = 0; v < VOLLEYS; v++) { acc += weights[v]; if (x < acc) return v; } return VOLLEYS - 1; };
        const at = v => LEAD_MS + v * VOLLEY_MS + Math.random() * VOLLEY_MS * .75;
        for (const side of ['def', 'atk']) {
            const dying = shuffle(b.ships.filter(s => s.side === side && s.die));
            dying.forEach((s, i) => b.events.push({ at: at(volleyOf((i + .5) / dying.length)), target: s, from: side === 'def' ? 'atk' : 'def', kill: true }));
        }
        for (let v = 0; v < VOLLEYS; v++) for (const from of ['def', 'atk']) {
            const k = 3 + Math.floor(Math.random() * 4);
            for (let i = 0; i < k; i++) b.events.push({ at: at(v), target: null, from, kill: false });
        }
        if (b.sb) for (let v = 0; v < VOLLEYS; v++) for (let i = 0; i < 3; i++) b.events.push({ at: at(v), target: b.sb, from: 'atk', kill: false, sbHit: v });
        if (b.dice) for (const ev of b.events) ev.at += DICE_MS;
        b.events.sort((x, y) => x.at - y.at);
    }

    // ── drawing ──
    function drawShip(x, y, type, dir, color, alpha, flash) {
        const s = TYPES[type].size * g;
        ctx.save(); ctx.translate(x, y); ctx.scale(dir * s, s); ctx.globalAlpha = alpha;
        ctx.beginPath(); SHAPES[type].forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath();
        ctx.fillStyle = flash > 0 ? '#ffffff' : color; ctx.fill();
        if (type > 0) {
            ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(-.7, -.1, 1.15, .2);
            ctx.fillStyle = COL.hot; ctx.globalAlpha = alpha * (.6 + .4 * Math.random());
            ctx.fillRect(-1.12, type === 2 ? -.45 : -.2, .14, type === 2 ? .2 : .4);
            if (type === 2) ctx.fillRect(-1.12, .25, .14, .2);
        }
        ctx.restore();
    }
    function drawStarbase(sb, t) {
        const r = 26 * g;
        ctx.save(); ctx.translate(sb.x, sb.y); ctx.globalAlpha = sb.hp > 0 ? 1 : .25;
        ctx.strokeStyle = '#27272a'; ctx.lineWidth = 5 * g; ctx.beginPath(); ctx.arc(0, 0, r + 7 * g, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = COL.def; ctx.beginPath(); ctx.arc(0, 0, r + 7 * g, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sb.hp); ctx.stroke();
        ctx.rotate(t / 4000);
        ctx.fillStyle = sb.flash > 0 ? '#fff' : '#123227'; ctx.strokeStyle = COL.def; ctx.lineWidth = 2 * g;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, rr = i % 2 ? r * .78 : r; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = COL.def; ctx.beginPath(); ctx.arc(0, 0, r * .3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.fillStyle = COL.def; ctx.font = `600 ${Math.round(11 * Math.max(g, .9))}px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText(`SB L${sb.levelNow}`, sb.x, sb.y + r + 24 * g);
    }
    function drawDice(b, now) {
        const d = b.dice, p = Math.min(1, now / DICE_TUMBLE), alpha = 1 - Math.max(0, (now - DICE_MS) / 300);
        if (p < 1) { if (now - d.flipAt > 40 + 260 * p * p) { d.shown = Math.random(); d.flipAt = now; } }
        else d.shown = d.u;
        ctx.save(); ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(0,0,0,.78)'; ctx.fillRect(0, 0, W, H);
        const R = 46 * Math.max(g, .95), cx = W / 2, bounce = Math.abs(Math.sin(p * Math.PI * 3)) * (1 - p) * 46 * g;
        const cy = H / 2 - 34 * g - bounce, ang = (1 - Math.pow(1 - p, 3)) * Math.PI * 6;
        const pulse = p >= 1 ? 1 + .06 * Math.sin((now - DICE_TUMBLE) / 70) * Math.max(0, 1 - (now - DICE_TUMBLE) / 600) : 1;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.scale(pulse, pulse);
        const hex = [...Array(6)].map((_, i) => [Math.cos(i * Math.PI / 3 + Math.PI / 6) * R, Math.sin(i * Math.PI / 3 + Math.PI / 6) * R]);
        ctx.beginPath(); hex.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
        ctx.fillStyle = '#18181b'; ctx.fill(); ctx.strokeStyle = COL.hot; ctx.lineWidth = 2.5 * g; ctx.stroke();
        const tri = [0, 2, 4].map(i => [Math.cos(i * Math.PI / 3 - Math.PI / 2) * R * .62, Math.sin(i * Math.PI / 3 - Math.PI / 2) * R * .62]);
        ctx.globalAlpha = alpha * .45; ctx.lineWidth = 1.2 * g; ctx.beginPath();
        tri.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
        hex.forEach(([hx, hy], i) => { const [tx, ty] = tri[Math.round(i / 2) % 3]; ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); });
        ctx.stroke(); ctx.globalAlpha = alpha; ctx.rotate(-ang);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `700 ${Math.round(R * .4)}px ${MONO}`;
        ctx.fillText((d.shown * 100).toFixed(p < 1 ? 0 : 2), 0, 1);
        ctx.restore();

        // win-chance bar; the needle follows the number on the die
        const bw = Math.min(W * .8, 460), bh = 14 * g, bx = cx - bw / 2, by = H / 2 + 52 * g, split = bx + bw * b.r.winD;
        ctx.globalAlpha = alpha * .75;
        ctx.fillStyle = COL.def; ctx.fillRect(bx, by, split - bx, bh);
        ctx.fillStyle = COL.atk; ctx.fillRect(split, by, bx + bw - split, bh);
        ctx.globalAlpha = alpha; ctx.textBaseline = 'alphabetic';
        ctx.font = `600 ${Math.round(11 * Math.max(g, .9))}px ${MONO}`;
        ctx.textAlign = 'left'; ctx.fillStyle = COL.def; ctx.fillText(`DEF ${(b.r.winD * 100).toFixed(1)}%`, bx, by - 7 * g);
        ctx.textAlign = 'right'; ctx.fillStyle = COL.atk; ctx.fillText(`ATK ${(b.r.winA * 100).toFixed(1)}%`, bx + bw, by - 7 * g);
        const nx = bx + bw * d.shown;
        ctx.fillStyle = '#fff'; ctx.fillRect(nx - 1.5 * g, by - 5 * g, 3 * g, bh + 10 * g);
        ctx.beginPath(); ctx.moveTo(nx, by + bh + 5 * g); ctx.lineTo(nx - 6 * g, by + bh + 13 * g); ctx.lineTo(nx + 6 * g, by + bh + 13 * g); ctx.closePath(); ctx.fill();
        if (p >= 1) {
            const atk = b.winner === 'atk';
            ctx.textAlign = 'center'; ctx.fillStyle = atk ? COL.atk : COL.def;
            ctx.font = `700 ${Math.round(17 * Math.max(g, .8))}px system-ui, sans-serif`;
            ctx.fillText(atk ? 'ATTACKER WINS THE ROLL' : 'DEFENDER WINS THE ROLL', cx, by + bh + 38 * g);
        }
        ctx.restore();
    }
    function banner(b) {
        const atk = b.winner === 'atk';
        ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(0, H / 2 - 30 * g, W, 60 * g);
        ctx.fillStyle = atk ? COL.atk : COL.def; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.font = `700 ${Math.round(24 * Math.max(g, .8))}px system-ui, sans-serif`;
        ctx.fillText(atk ? 'ATTACKER WINS' : 'DEFENDER HOLDS', W / 2, H / 2 + 2 * g);
        ctx.fillStyle = '#a1a1aa'; ctx.font = `500 ${Math.round(12 * Math.max(g, .9))}px ${MONO}`;
        ctx.fillText(`rolled ${(b.out.u * 100).toFixed(2)} · win chance ${((atk ? b.r.winA : b.r.winD) * 100).toFixed(1)}%`, W / 2, H / 2 + 20 * g);
    }

    // ── combat events ──
    function pickShooter(b, side) {
        const pool = [];
        for (const s of b.ships) if (s.side === side && s.alive) for (let i = 0; i < [1, 2, 4][s.type]; i++) pool.push(s);
        if (side === 'def' && b.sb && b.sb.hp > 0) for (let i = 0; i < 6; i++) pool.push({ x: b.sb.x, y: b.sb.y, type: 3 });
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    }
    function boom(b, s, now) {
        s.alive = false;
        for (let i = 0, n = [10, 18, 30][s.type]; i < n; i++) {
            const a = Math.random() * 6.28, sp = (.03 + Math.random() * .12) * g * (1 + s.type * .5);
            b.parts.push({ x: s.x, y: s.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t0: now, life: 400 + Math.random() * 500 + s.type * 200,
                c: Math.random() < .5 ? COL.hot : (s.side === 'def' ? COL.def : COL.atk), r: (1 + Math.random() * 1.6) * g });
        }
    }
    function fire(b, ev, now) {
        const shooter = pickShooter(b, ev.from);
        let target = ev.target;
        if (!target) {
            const foes = b.ships.filter(s => s.side !== ev.from && s.alive);
            if (!foes.length) return;
            target = foes[Math.floor(Math.random() * foes.length)];
        }
        if (!shooter) { if (ev.kill) boom(b, target, now); return; }
        const exact = ev.kill || target === b.sb;
        const tx = target.x + (exact ? 0 : (Math.random() - .5) * 18 * g), ty = target.y + (exact ? 0 : (Math.random() - .5) * 18 * g);
        b.bolts.push({ x0: shooter.x, y0: shooter.y, x1: tx, y1: ty, t0: now, dur: 180 + Math.hypot(tx - shooter.x, ty - shooter.y) * .7,
            w: [1.2, 1.8, 3, 3.4][shooter.type] * g, color: ev.from === 'def' ? COL.def : COL.atk, ev, target });
    }
    function hit(b, bolt, now) {
        const { ev, target } = bolt;
        if (ev.kill && target.alive) { target.flash = 80; boom(b, target, now); return; }
        if (target === b.sb) {
            const sb = b.sb;
            sb.hp = Math.max(sb.hpEnd, Math.min(sb.hp, 1 - (1 - sb.hpEnd) * (ev.sbHit + 1) / VOLLEYS));
            sb.levelNow = Math.max(sb.levelEnd, P.sbLevelLeft(M.sbCV, sb.level, sb.hp));
            sb.flash = 70;
        } else if (target.alive) target.flash = 60;
        for (let i = 0; i < 4; i++) b.parts.push({ x: bolt.x1, y: bolt.y1, vx: (Math.random() - .5) * .12 * g, vy: (Math.random() - .5) * .12 * g, t0: now, life: 220, c: COL.hot, r: g });
    }

    // ── HUD, key, result ──
    function liveCount(b, side, t) {
        const S = b.sides[side], { icons, keep } = S.plan[t];
        if (b.done) return S.surv[t];
        const dying = icons - keep;
        if (!dying) return S.fleet[t];
        const dead = b.ships.filter(s => s.side === side && s.type === t && !s.alive).length;
        return Math.round(S.fleet[t] - (dead / dying) * (S.fleet[t] - S.surv[t]));
    }
    function renderHud(b) {
        const row = side => [0, 1, 2].filter(t => b.sides[side].fleet[t] > 0).map(t => `${TYPES[t].short} ${fmt(liveCount(b, side, t))}`).join('  ') || 'none';
        hud('def').textContent = row('def') + (b.sb ? `  SB ${b.sb.levelNow}` : '');
        hud('atk').textContent = row('atk');
        hud('mid').textContent = b.done ? (b.winner === 'atk' ? 'ATTACKER WINS' : 'DEFENDER HOLDS')
            : b.dice && b.clock < DICE_MS ? 'ROLLING…' : `${(b.r.winD * 100).toFixed(1)}% · ${(b.r.winA * 100).toFixed(1)}%`;
    }
    function renderKey(b) {
        const svg = (t, color) => {
            const k = 7.5 * [.8, 1.1, 1.3][t];
            return `<svg viewBox="0 0 26 18" width="22" height="15" aria-hidden="true"><polygon points="${SHAPES[t].map(([x, y]) => `${13 + x * k},${9 + y * k}`).join(' ')}" fill="${color}"/></svg>`;
        };
        root.querySelector('[data-key]').innerHTML = [0, 1, 2].map(t => {
            const pd = b.sides.def.plan[t].per, pa = b.sides.atk.plan[t].per;
            const parts = [pd > 1 && b.sides.def.fleet[t] ? `${pd} def` : '', pa > 1 && b.sides.atk.fleet[t] ? `${pa} atk` : ''].filter(Boolean);
            return `<span class="inline-flex items-center gap-1">${svg(t, COL.def)}${svg(t, COL.atk)}${TYPES[t].name}${parts.length ? ` <em class="text-zinc-500">(1 icon = ${parts.join(' / ')})</em>` : ''}</span>`;
        }).join('') + (b.sb ? `<span class="inline-flex items-center gap-1"><svg viewBox="0 0 26 18" width="22" height="15" aria-hidden="true"><circle cx="13" cy="9" r="6" fill="#123227" stroke="${COL.def}" stroke-width="2"/></svg>Starbase, ring = strength left</span>` : '');
    }
    function renderLedger(b) {
        const el = root.querySelector('[data-ledger]');
        if (!b.done) { el.innerHTML = ''; return; }
        const rows = [];
        for (const side of ['def', 'atk']) [0, 1, 2].forEach(t => {
            const n = b.sides[side].fleet[t]; if (!n) return;
            rows.push([side, TYPES[t].name, n, b.sides[side].surv[t]]);
        });
        if (b.sb) rows.push(['def', 'Starbase lvl', b.sb.level, b.sb.levelEnd]);
        el.innerHTML = `<div class="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 gap-y-1 text-xs font-mono tabular-nums">` +
            rows.map(([side, name, n, left]) => `<span style="color:${side === 'def' ? COL.def : COL.atk}">${side === 'def' ? 'Defender' : 'Attacker'}</span>` +
                `<span class="text-muted-foreground">${esc(name)}</span><span class="text-right">${fmt(left)} / ${n}</span>` +
                `<span class="text-right ${n - left > 0 ? 'text-red-400' : 'text-zinc-600'}">−${fmt(n - left)}</span>`).join('') + `</div>`;
    }

    // ── loop ──
    function frame(ts) {
        const b = B;
        if (!b.last) b.last = ts;
        b.clock += ts - b.last; b.last = ts;
        const now = b.clock;
        while (b.events.length && b.events[0].at <= now) fire(b, b.events.shift(), now);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#d4d4f5';
        for (const s of stars) { ctx.globalAlpha = s.a * (.7 + .3 * Math.sin(ts / 900 + s.p)); ctx.fillRect(s.x * W, s.y * H, s.r, s.r); }
        ctx.globalAlpha = 1;
        if (b.sb) { b.sb.flash -= 16; drawStarbase(b.sb, ts); }
        for (const s of b.ships) {
            if (!s.alive) { s.fade = Math.max(0, s.fade - .06); if (!s.fade) continue; }
            s.flash -= 16;
            drawShip(s.x, s.y + Math.sin(ts / 700 + s.phase) * 1.2 * g, s.type, s.side === 'def' ? 1 : -1,
                s.side === 'def' ? COL.def : COL.atk, s.alive ? 1 : s.fade * .5, s.flash);
        }
        ctx.lineCap = 'round';
        b.bolts = b.bolts.filter(bo => {
            const p = (now - bo.t0) / bo.dur;
            if (p >= 1) { hit(b, bo, now); return false; }
            const tail = Math.max(0, p - .25);
            ctx.strokeStyle = bo.color; ctx.lineWidth = bo.w; ctx.globalAlpha = .95;
            ctx.beginPath(); ctx.moveTo(bo.x0 + (bo.x1 - bo.x0) * tail, bo.y0 + (bo.y1 - bo.y0) * tail);
            ctx.lineTo(bo.x0 + (bo.x1 - bo.x0) * p, bo.y0 + (bo.y1 - bo.y0) * p); ctx.stroke();
            return true;
        });
        b.parts = b.parts.filter(pt => {
            const age = now - pt.t0; if (age > pt.life) return false;
            ctx.globalAlpha = 1 - age / pt.life; ctx.fillStyle = pt.c;
            ctx.beginPath(); ctx.arc(pt.x + pt.vx * age, pt.y + pt.vy * age, pt.r, 0, 6.28); ctx.fill();
            return true;
        });
        ctx.globalAlpha = 1;
        if (b.dice && now < DICE_MS + 300) drawDice(b, now);
        if (!b.done && !b.events.length && !b.bolts.length && now > LEAD_MS + VOLLEYS * VOLLEY_MS + (b.dice ? DICE_MS : 0)) {
            b.done = true;
            if (b.sb) { b.sb.hp = b.sb.hpEnd; b.sb.levelNow = b.sb.levelEnd; }
            renderLedger(b);
        }
        if (b.done) banner(b);
        renderHud(b);
        raf = requestAnimationFrame(frame);
    }

    function resize() {
        const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        if (!r.width) return;
        W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        g = Math.max(.55, Math.min(1.15, W / 760, H / 440));
        if (B) layout(B);
    }

    function start() {
        cancelAnimationFrame(raf);
        B = build();
        layout(B); schedule(B); renderKey(B); renderLedger(B);
        if (reduce) { // no motion: straight to the result
            for (const ev of B.events) if (ev.kill) { ev.target.alive = false; ev.target.fade = 0; }
            B.events = []; B.clock = LEAD_MS + VOLLEYS * VOLLEY_MS + 1;
        }
        raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(resize);
    const onKey = e => { if (e.key === 'Escape') close(); };
    function close() {
        cancelAnimationFrame(raf); ro.disconnect();
        document.removeEventListener('keydown', onKey);
        root.remove();
        if (open?.root === root) open = null;
    }
    root.addEventListener('click', e => { if (e.target === root || e.target.closest('[data-fight-close]')) close(); });
    root.querySelector('[data-fight-again]').addEventListener('click', start);
    document.addEventListener('keydown', onKey);
    ro.observe(cv);
    resize();
    start();
    root.querySelector('[data-fight-close]').focus();
    open = { root, close };
}
